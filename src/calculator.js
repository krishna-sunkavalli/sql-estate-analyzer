"use strict";

const CALCULATOR_PRICES = /*__PRICES__*/{}/*__END_PRICES__*/;
const HOURS = 730;
const MONTHS = 36;
const PLANS = {payg: "PAYG", ri1: "1-year reservation", ri3: "3-year reservation",
  sp1: "1-year savings plan", sp3: "3-year savings plan"};
// Commitment terms are chosen rather than asked for: the cheapest published
// rate the snapshot actually carries for every size in the layout, preferring
// three-year terms. Order is a tiebreak only; the rate decides.
const PLAN_PREFERENCE = ["ri3", "sp3", "ri1", "sp1", "payg"];

function bestVmPlan(region, sizes) {
  let best = null;
  for (const plan of PLAN_PREFERENCE) {
    const rates = sizes.map(s => region.vmPlans?.[`Standard_E${s}bds_v5`]?.rates?.[plan]);
    if (rates.some(r => !Number.isFinite(r) || r <= 0)) continue;
    const total = rates.reduce((t, r) => t + r, 0);
    if (!best || total < best.total) best = {plan, total};
  }
  return best?.plan ?? null;
}

function bestMiPlan(region) {
  let best = null;
  for (const plan of PLAN_PREFERENCE) {
    const rate = region.miPlans?.[plan]?.base;
    if (!Number.isFinite(rate) || rate <= 0) continue;
    if (!best || rate < best.rate) best = {plan, rate};
  }
  return best?.plan ?? null;
}
const REGION_NAMES = {
  eastus: "East US", eastus2: "East US 2", westus2: "West US 2", westus3: "West US 3",
  centralus: "Central US", southcentralus: "South Central US", northeurope: "North Europe",
  westeurope: "West Europe", uksouth: "UK South", francecentral: "France Central",
  germanywestcentral: "Germany West Central", swedencentral: "Sweden Central",
  southeastasia: "Southeast Asia", australiaeast: "Australia East", japaneast: "Japan East",
  centralindia: "Central India", canadacentral: "Canada Central", brazilsouth: "Brazil South",
};
const CARD_LABELS = {  stay: {eyebrow: "Baseline", title: "On-premises", subtitle: "Existing footprint staying put"},
  vm: {eyebrow: "Lift and shift", title: "SQL on IaaS", subtitle: "SQL Server on Azure Virtual Machines"},
  mi: {eyebrow: "Managed platform", title: "SQL MI", subtitle: "Managed Instance, General Purpose"},
  serverless: {eyebrow: "Intermittent workloads", title: "SQL serverless", subtitle: "Azure SQL Database · usage-based"},
};
const DISKS = [
  ["P4", 32], ["P6", 64], ["P10", 128], ["P15", 256], ["P20", 512],
  ["P30", 1024], ["P40", 2048], ["P50", 4096], ["P60", 8192],
  ["P70", 16384], ["P80", 32767],
];
const sum = o => o.standard + o.enterprise;

/* Azure Hybrid Benefit for SQL Server conversion ratios, as published by
   Microsoft. Each value is the number of Azure vCores or vCPUs that one
   qualifying core licence of the given edition covers.

   Managed Instance and Azure SQL Database (elastic pool and single database)
   share one set of ratios. Virtual machines are keyed by the edition of SQL
   Server installed on the VM, because a Standard VM and an Enterprise VM
   consume entitlement at different rates. */
const AHB_RATIOS = {
  mi: {
    gp: {enterprise: 4, standard: 1},
    bc: {enterprise: 1, standard: 0.25},
  },
  vm: {
    // Ratios for covering a VM of this edition, per licence edition held.
    standard: {enterprise: 4, standard: 1},
    enterprise: {enterprise: 1, standard: 0.25},
  },
};
// Business Critical ratios are recorded above for completeness, but only
// General Purpose is priced in this snapshot, so it is the only tier accepted.
const PRICED_TIERS = new Set(["gp"]);

const AHB_INELIGIBLE = new Set(["serverless"]);
// Each virtual machine consumes at least four core licences, whatever its size.
const AHB_MIN_VM_LICENCES = 4;

// Azure capacity is not sold in one uniform block size. An architect fits the
// workload to the real size ladder, so the last deployment is sized to the
// remainder instead of rounding a whole block up. Sizes below are the SKUs
// actually priced in the snapshot; the MI ladder is the published Gen5 set.
const VM_SIZES = [16, 8, 4];
const MI_SIZES = [80, 64, 40, 32, 24, 16, 8, 4];

// Managed Instance has two deployment topologies. A single instance is its own
// billable unit and cannot be smaller than four vCores. An instance pool is the
// billable unit instead: pool vCores are purchased once and instances are placed
// inside, and only a pool can host a two-vCore instance. Both bill the same
// published per-vCore rate, so the cheaper topology is simply the one needing
// fewer vCores. Pools halve compute for estates of one- and two-core servers,
// and cost slightly more when instances already sit on the ladder, because a
// pool must round up to a purchasable size.
const MI_POOL_INSTANCE_SIZES = [2, 4, 8, 16, 24, 32, 40, 64, 80];
const MI_POOL_SIZES = [8, 16, 24, 32, 40, 64, 80];
const MI_POOL_MAX_INSTANCES = 40;
// Published per-instance reserved storage limits inside a pool.
const MI_POOL_STORAGE_CAP = {2: 640, 4: 2048, 8: 8192};

function packMiPool(required, instances, maxSize) {
  const sizes = MI_POOL_INSTANCE_SIZES.filter(s => s <= maxSize);
  const pools = MI_POOL_SIZES.filter(s => s <= maxSize);
  if (!sizes.length || !pools.length || !instances) return null;
  const size = sizes.find(s => s >= Math.ceil(required / instances));
  if (!size) return null;
  const largest = pools[pools.length - 1];
  const perPool = Math.min(MI_POOL_MAX_INSTANCES, Math.floor(largest / size));
  if (!perPool) return null;
  const out = [];
  let left = instances;
  while (left > 0) {
    const take = Math.min(left, perPool);
    const pool = pools.find(p => p >= take * size);
    if (!pool) return null;
    out.push(pool);
    left -= take;
  }
  out.instanceSize = size;
  return out;
}

function packDeployments(required, maxSize, ladder) {
  const usable = ladder.filter(s => s <= maxSize).sort((a, b) => b - a);
  if (!usable.length) throw new Error("No Azure deployment size fits the selected maximum.");
  const smallest = usable[usable.length - 1];
  const out = [];
  let left = required;
  while (left > 0) {
    // Take the largest size that still fits; below the smallest size, the
    // smallest size is the minimum billable unit.
    out.push(left < smallest ? smallest : usable.find(s => s <= left));
    left -= out[out.length - 1];
  }
  return out;
}

// With a known instance count the topology is given, not inferred: each instance
// becomes its own deployment sized to its share. This matters because both VM
// and MI have a four-core floor, so many small instances cost far more than the
// same cores consolidated, which the packing above would otherwise assume.
function sizePerInstance(required, instances, maxSize, ladder) {
  const usable = ladder.filter(s => s <= maxSize).sort((a, b) => a - b);
  if (!usable.length) throw new Error("No Azure deployment size fits the selected maximum.");
  const share = Math.ceil(required / instances);
  const size = usable.find(s => s >= share);
  if (!size) return null;
  return Array.from({length: instances}, () => size);
}

function positiveRate(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Missing or invalid published rate: ${name}.`);
  return value;
}

function calculateCoreOptions(raw, prices = CALCULATOR_PRICES) {
  const input = {rightSizePct: 20, unitCores: 16, onPremPerCoreMonth: 37.5, avoidablePct: 100,
    storageGB: 0, licenseBasis: "existing", discountPct: 0, ahb: true,
    vmPlan: "auto", miPlan: "auto", migrationPct: 100, instanceCount: null, serviceTier: "gp",
    purchaseModel: "serverless",
    databaseCount: null, serverlessMin: 1, serverlessMax: 8,
    serverlessBillable: 2, activePct: 25, ...raw};
  for (const key of ["standard", "enterprise"]) {
    if (!Number.isInteger(input[key]) || input[key] < 0 || input[key] > 100000) {
      throw new Error(`${key} cores must be a whole number between 0 and 100,000.`);
    }
  }
  if (input.standard + input.enterprise === 0) throw new Error("Enter at least one Standard or Enterprise core.");
  for (const [key, max] of [["migrationPct", 100], ["rightSizePct", 60], ["avoidablePct", 100],
    ["discountPct", 100], ["onPremPerCoreMonth", 10000], ["storageGB", 10000000]]) {
    if (!Number.isFinite(input[key]) || input[key] < 0 || input[key] > max) throw new Error(`Invalid ${key}.`);
  }
  if (![4, 8, 16].includes(input.unitCores)) throw new Error("Choose 4, 8 or 16 cores per reference deployment.");
  if (!["refresh", "existing"].includes(input.licenseBasis)) throw new Error("Choose a license-refresh or existing-license scenario.");
  for (const key of ["ahb"]) {
    if (typeof input[key] !== "boolean") throw new Error(`Confirm ${key}.`);
  }
  if (!PRICED_TIERS.has(input.serviceTier)) throw new Error("Choose a priced service tier.");
  if (!["serverless", "provisioned"].includes(input.purchaseModel)) throw new Error("Choose a priced purchase model.");
  for (const key of ["vmPlan", "miPlan"]) {
    if (input[key] !== "auto" && !Object.hasOwn(PLANS, input[key])) throw new Error(`Invalid ${key}.`);
  }
  const region = prices.regions[input.region];
  if (!region) throw new Error("Choose a region with published prices.");
  const source = {standard: input.standard, enterprise: input.enterprise};
  const moved = Object.fromEntries(Object.entries(source).map(([e, n]) => [e, Math.floor(n * input.migrationPct / 100)]));
  const retained = Object.fromEntries(Object.entries(source).map(([e, n]) => [e, n - moved[e]]));
  // The comparison prices the migrating footprint, so there must be one.
  if (sum(moved) === 0) {
    throw new Error(input.migrationPct === 0
      ? "Move at least some cores to Azure to compare the options."
      : `${input.migrationPct}% of this footprint rounds down to zero cores. Raise the percentage.`);
  }
  const required = Object.fromEntries(Object.entries(moved).map(([e, n]) => [e, n ? Math.ceil(n * (1 - input.rightSizePct / 100)) : 0]));
  // Instances are shared out in proportion to each edition's right-sized
  // demand, with at least one wherever that edition has cores.
  const editions = ["standard", "enterprise"].filter(e => required[e] > 0);
  let instancesPer = null;
  if (input.instanceCount !== null) {
    if (!Number.isInteger(input.instanceCount) || input.instanceCount < 1 || input.instanceCount > 100000) {
      throw new Error("Instance count must be a whole number from 1 to 100,000.");
    }
    if (input.instanceCount < editions.length) {
      throw new Error(`This footprint spans ${editions.length} editions, so it needs at least ${editions.length} instances.`);
    }
    instancesPer = {standard: 0, enterprise: 0};
    if (editions.length === 1) {
      instancesPer[editions[0]] = input.instanceCount;
    } else {
      const first = Math.min(input.instanceCount - 1,
        Math.max(1, Math.round(input.instanceCount * required.standard / sum(required))));
      instancesPer.standard = first;
      instancesPer.enterprise = input.instanceCount - first;
    }
  }
  const packs = (key, allowPool) => {
    const ladder = key === "vm" ? VM_SIZES : MI_SIZES;
    const single = Object.fromEntries(Object.entries(required).map(([e, n]) => {
      if (!n) return [e, []];
      if (instancesPer) return [e, sizePerInstance(n, instancesPer[e], input.unitCores, ladder)];
      return [e, packDeployments(n, input.unitCores, ladder)];
    }));
    single.topology = "single";
    // Pooling is only meaningful when the instance topology is known, and only
    // Managed Instance offers it. Azure SQL Database has elastic pools, which
    // are a different construct that does not change the vCore count, so the
    // Database target is costed without this.
    if (key !== "mi" || !instancesPer || !allowPool) return single;
    const pooled = Object.fromEntries(Object.entries(required).map(([e, n]) =>
      [e, n ? packMiPool(n, instancesPer[e], input.unitCores) : []]));
    if (editions.some(e => pooled[e] === null)) return single;
    pooled.topology = "pool";
    pooled.instanceSize = Math.min(...editions.map(e => pooled[e].instanceSize ?? Infinity));
    const cores = o => editions.reduce((t, e) => t + o[e].reduce((a, b) => a + b, 0), 0);
    if (editions.some(e => single[e] === null)) return pooled;
    return cores(pooled) < cores(single) ? pooled : single;
  };
  const discountFactor = 1 - input.discountPct / 100;
  const licensePurchase = counts => input.licenseBasis === "existing" ? 0 :
    Object.entries(counts).reduce((total, [edition, cores]) => total + (cores ? Math.ceil(cores / 2) *
      positiveRate(prices.sql2022Pack?.[edition], `SQL Server 2022 ${edition} two-core pack`) : 0), 0) * discountFactor;
  const fullInfrastructure = sum(source) * input.onPremPerCoreMonth;
  // Software Assurance is an ongoing on-premises licensing cost, unlike the
  // one-time purchase. It is charged on cores still running on-premises, and on
  // the cores whose rights back Azure Hybrid Benefit, because AHB requires
  // active SA or a qualifying subscription.
  const saPerCoreMonth = edition =>
    positiveRate(prices.sqlSaPack?.[edition], `SQL Server ${edition} two-core pack Software Assurance`) / 2 / 12;
  const saMonthly = counts => Object.entries(counts)
    .reduce((t, [edition, cores]) => t + (cores ? cores * saPerCoreMonth(edition) : 0), 0);
  // Everything below is scoped to the cores selected for migration. The retained
  // remainder is identical in all four columns, so including it would add the
  // same constant everywhere: it cannot change the decision, but it does
  // compress the visible difference. It is reported separately as context.
  const scopedInfrastructure = sum(moved) * input.onPremPerCoreMonth;
  // Migrating frees only the declared avoidable share of that slice's operations.
  const infrastructure = scopedInfrastructure * (1 - input.avoidablePct / 100);
  const base = {upfront: 0, compute: 0, sqlLicense: 0, storage: 0, coveredCores: 0,
    sa: 0, licenseCores: 0,
    azureCores: 0, deployments: 0, allocation: [], storageDetail: "No Azure deployments"};
  const total = scenario => {
    const compute = scenario.compute * discountFactor;
    const sqlLicense = scenario.sqlLicense * discountFactor;
    const storage = scenario.storage * discountFactor;
    const sa = scenario.sa * discountFactor;
    const monthly = scenario.infrastructure + compute + sqlLicense + storage + sa;
    return {...scenario, compute, sqlLicense, storage, sa, status: "ready", monthly, threeYear: monthly * MONTHS + scenario.upfront};
  };
  const baseline = total({...base, upfront: licensePurchase(moved), key: "stay", name: "Stay on-premises",
    infrastructure: scopedInfrastructure, sa: saMonthly(moved), scopedCores: sum(moved),
    licenseCores: sum(moved)});
  const unavailable = (key, name, reason, status = "unavailable") => ({
    ...base, key, name, status, reason, infrastructure, scopedCores: sum(moved), monthly: null, threeYear: null,
  });
  const buildScenario = (key, {allowPool = false} = {}) => {
    const name = key === "vm" ? "SQL Server on Azure VM" : "SQL Managed Instance GP";
    const layout = packs(key, allowPool);
    if (Object.values(layout).some(v => v === null)) {
      const worst = editions.find(e => layout[e] === null);
      return unavailable(key, name, `${input.instanceCount} instance(s) puts about ${Math.ceil(required[worst] / instancesPer[worst])} ${key === "vm" ? "vCPU" : "vCore"} on each ${worst} instance, above the ${input.unitCores}-core maximum. Raise the largest deployment size or split the workload across more instances.`);
    }
    const sizes = [...layout.standard, ...layout.enterprise];
    const requested = input[`${key}Plan`];
    const plan = requested === "auto"
      ? (key === "vm" ? bestVmPlan(region, sizes) : bestMiPlan(region))
      : requested;
    if (!plan) return unavailable(key, name, `No published ${key === "vm" ? "VM" : "MI GP Gen5"} rate for ${input.region} in this snapshot.`);
    const deployments = sizes.length;
    const azureCores = sizes.reduce((t, s) => t + s, 0);
    const vmRateFor = size => {
      const sku = `Standard_E${size}bds_v5`;
      const published = region.vmPlans?.[sku]?.rates?.[plan];
      if (!published) return null;
      // Windows AHB removes the Windows uplift embedded in the VM meter. The
      // uplift is never discounted by a reservation or savings plan, so it is
      // deducted at its unchanged pay-as-you-go value from the selected term.
      const credit = input.ahb
        ? positiveRate(region.vmPlans?.[sku]?.windowsLicensePerHour, `${input.region} ${sku} Windows Server licence uplift`)
        : 0;
      if (credit >= positiveRate(published, `${input.region} ${sku} ${plan}`)) {
        throw new Error("Windows Server licence uplift is not below the published VM rate.");
      }
      return published - credit;
    };
    if (deployments) {
      // A missing commitment rate is a real gap in the snapshot, so the scenario
      // is marked unavailable. A missing pay-as-you-go rate means the price file
      // itself is broken, so it must fail loudly rather than quietly vanish.
      if (key === "vm") {
        const missing = [...new Set(sizes)].find(s => !region.vmPlans?.[`Standard_E${s}bds_v5`]?.rates?.[plan]);
        if (missing && plan !== "payg") return unavailable(key, name, `${PLANS[plan]} unavailable: no verified ${input.region} Standard_E${missing}bds_v5 rate in this snapshot. Select a supported plan.`);
      } else if (!region.miPlans?.[plan] && plan !== "payg") {
        return unavailable(key, name, `${PLANS[plan]} unavailable: no verified ${input.region} MI GP Gen5 rate in this snapshot. Select a supported plan.`);
      }
    }
    let compute = 0, sqlLicense = 0, coveredCores = 0;
    const ahbBackingCores = {standard: 0, enterprise: 0};
    const allocation = [];
    // Entitlement comes only from the cores being migrated. Rights retained
    // on-premises are never pooled with the migrated share, and an ineligible
    // target draws nothing at all.
    const pool = input.ahb && !AHB_INELIGIBLE.has(key)
      ? {standard: moved.standard, enterprise: moved.enterprise}
      : {standard: 0, enterprise: 0};
    const ratioFor = (licence, deploymentEdition) => (key === "vm"
      ? AHB_RATIOS.vm[deploymentEdition] : AHB_RATIOS.mi[input.serviceTier])[licence];
    // A deployment is covered only when the entitlement stretches across the
    // whole of it, so partial coverage never happens. Same-edition licences are
    // spent first; leftover Enterprise then covers Standard workloads, which the
    // published table allows at a more generous ratio. Standard licences
    // covering Enterprise workloads is permitted at four to one but is not
    // modelled, which understates the benefit rather than overstating it.
    const claim = (size, deploymentEdition) => {
      const order = deploymentEdition === "standard" ? ["standard", "enterprise"] : ["enterprise"];
      for (const licence of order) {
        const ratio = ratioFor(licence, deploymentEdition);
        if (!ratio) continue;
        let need = size / ratio;
        if (key === "vm") need = Math.max(need, AHB_MIN_VM_LICENCES);
        if (pool[licence] + 1e-9 < need) continue;
        pool[licence] -= need;
        ahbBackingCores[licence] += need;
        return true;
      }
      return false;
    };
    // Enterprise deployments are matched first. On a virtual machine an
    // Enterprise licence covers an Enterprise VM one to one, so spending those
    // licences on Standard workloads first would strand the Enterprise ones
    // behind a four to one conversion.
    for (const edition of ["enterprise", "standard"]) {
      const sizeList = layout[edition];
      if (!sizeList.length) continue;
      let covered = 0;
      for (const size of sizeList) {
        const takes = claim(size, edition);
        if (takes) covered += size;
        const rate = key === "vm" ? vmRateFor(size) : positiveRate(region.miPlans?.[plan]?.base, `MI GP ${plan} base`);
        if (key === "vm") {
          compute += positiveRate(rate, `${input.region} Standard_E${size}bds_v5 ${plan}`) * HOURS;
          if (!takes) sqlLicense += positiveRate(prices.vmLicensePerCoreHour[edition], `${edition} VM license`) * size * HOURS;
        } else {
          const included = positiveRate(region.miPlans?.[plan]?.included, `MI GP ${plan} license-included`);
          if (included < rate) throw new Error("MI license-included rate is below its base rate.");
          compute += rate * size * HOURS;
          if (!takes) sqlLicense += (included - rate) * size * HOURS;
        }
      }
      coveredCores += covered;
      // Long lists are summarised by grouping equal sizes rather than naming
      // the first one, because the fitted layout usually ends on a smaller
      // remainder and "16 each" would misstate it.
      const describe = list => {
        if (list.length <= 6) return list.join(" + ");
        const groups = [];
        for (const s of list) {
          const last = groups[groups.length - 1];
          if (last && last.size === s) last.n += 1; else groups.push({size: s, n: 1});
        }
        groups.sort((a, b) => b.size - a.size);
        return groups.map(g => `${g.n} \u00d7 ${g.size}`).join(" + ");
      };
      const unit = key === "vm" ? "vCPU" : "vCore";
      allocation.push(`${edition}: ${layout.topology === "pool"
        ? `${instancesPer[edition]} instance(s) of ${layout.instanceSize} vCore in ${sizeList.length} pool(s) of ${describe(sizeList)} vCore`
        : `${sizeList.length} ${instancesPer ? "instance" : "deployment"}(s) of ${describe(sizeList)} ${unit}`} for ${required[edition]} required; ${covered} ${unit} assumed SQL AHB${key === "vm" && input.ahb ? "; Windows Server AHB assumed" : ""}`);
    }
    let storage = 0, storageDetail = "No Azure deployments";
    if (deployments && key === "vm") {
      const diskRates = region.storage.premium_ssd_lrs_per_disk_mo;
      storage = positiveRate(diskRates.P10, "P10 OS disk") * deployments;
      storageDetail = `${deployments} × 128 GB P10 OS disks`;
      if (input.storageGB > 0) {
        const perUnit = input.storageGB / deployments;
        const full = Math.floor(perUnit / 32767);
        const remainder = perUnit - full * 32767;
        const last = remainder > 0 ? DISKS.find(([, capacity]) => capacity >= remainder) : null;
        storage += deployments * ((full ? full * positiveRate(diskRates.P80, "P80") : 0) +
          (last ? positiveRate(diskRates[last[0]], last[0]) : 0));
        storageDetail += "; equal data allocation rounded to Premium SSD sizes";
      } else storageDetail += "; data disks unspecified / omitted";
    } else if (deployments) {
      // Storage follows the instance in both topologies, so it is billed per
      // instance rather than per billable compute unit.
      const units = layout.topology === "pool" ? input.instanceCount : deployments;
      const perUnit = Math.max(32, Math.ceil(input.storageGB / units / 32) * 32);
      const limit = layout.topology === "pool"
        ? (MI_POOL_STORAGE_CAP[layout.instanceSize] ?? 16384)
        : (Math.min(...sizes) === 4 ? 2048 : 8192);
      if (perUnit > limit) return unavailable(key, name, `MI storage needs ${perUnit} GB per instance, above this model's ${limit} GB limit. Increase deployment size or review placement.`);
      storage = perUnit * units * positiveRate(region.storage.mi_gp_per_gb_mo, "MI GP storage");
      storageDetail = `${units} × ${perUnit} GB reserved storage (32 GB increments)`;
    }
    return total({...base, key, name, plan, infrastructure, compute, sqlLicense, storage, storageDetail,
      sa: saMonthly(ahbBackingCores),
      licenseCores: sum(ahbBackingCores),
      topology: layout.topology, instanceSize: layout.instanceSize,
      allocation, coveredCores, azureCores, deployments, sizes, scopedCores: sum(moved)});
  };
  const scenarios = [buildScenario("vm"), buildScenario("mi", {allowPool: true})];
  const serverlessName = "Azure SQL Database serverless";
  const serverlessBase = {...base, key: "serverless", name: serverlessName, infrastructure, scopedCores: sum(moved), plan: "payg"};
  let serverless;
  if (input.purchaseModel === "provisioned") {
    // Azure SQL Database General Purpose provisioned and Managed Instance
    // General Purpose bill against the same Gen5 compute meter: the published
    // per-vCore rates are identical in every captured region, so the already
    // verified Managed Instance rates are reused rather than scraped twice.
    // The published Hybrid Benefit table also lists the two services on one
    // row, so the same ratios apply. Only storage differs. Instance pools are a
    // Managed Instance construct, so the Database column is always costed on
    // the single-instance topology even when pooling wins for Managed Instance.
    const mi = buildScenario("mi");
    if (mi.status !== "ready") {
      serverless = unavailable("dbProvisioned", "Azure SQL Database provisioned", mi.reason, mi.status);
    } else {
      const perDb = Math.max(32, Math.ceil(input.storageGB / mi.deployments / 32) * 32);
      const storage = perDb * mi.deployments * positiveRate(region.storage.db_gp_per_gb_mo, "SQL Database GP storage");
      serverless = total({...base, key: "dbProvisioned", name: "Azure SQL Database provisioned",
        plan: mi.plan, infrastructure, compute: mi.compute / discountFactor,
        sqlLicense: mi.sqlLicense / discountFactor, storage,
        sa: mi.sa / discountFactor, licenseCores: mi.licenseCores,
        topology: mi.topology, instanceSize: mi.instanceSize,
        allocation: mi.allocation, coveredCores: mi.coveredCores, azureCores: mi.azureCores,
        deployments: mi.deployments, sizes: mi.sizes, scopedCores: sum(moved),
        storageDetail: `${mi.deployments} × ${perDb} GB reserved storage`});
    }
  } else {
    const max = input.serverlessMax;
    if (![2, 4, 8].includes(max)) throw new Error("Serverless maximum must be 2, 4 or 8 vCores in this conservative model.");
    // Core totals cannot reveal how many databases exist. When the count is not
    // supplied, assume a capacity-equivalent layout: enough databases, each
    // capped at the chosen maximum, to cover the same right-sized demand. This
    // is a declared assumption for directional guidance, not a discovery.
    const assumed = [];
    let dbs = input.databaseCount;
    if (dbs === null || dbs === "") {
      dbs = Math.max(1, Math.ceil(sum(required) / max));
      assumed.push(`${dbs} database(s) assumed: right-sized demand divided by the ${max}-vCore maximum`);
    }
    const min = input.serverlessMin, billable = input.serverlessBillable;
    if (!Number.isInteger(dbs) || dbs < 1 || dbs > 100000) throw new Error("Serverless database count must be a whole number from 1 to 100,000.");
    const floor = max === 8 ? 1 : 0.5;
    if (!Number.isFinite(min) || min < floor || min > max || min * 2 !== Math.round(min * 2)) throw new Error(`Serverless minimum must be ${floor}–${max} vCores, in 0.5 increments.`);
    // Gen5's minimum memory at 0.5 configured vCores increases billing above
    // 0.5: 2.05 GB at max 2 and 2.1 GB at max 4, normalized at 3 GB/vCore.
    const billingFloor = min === 0.5 ? (max === 2 ? 2.05 / 3 : 0.7) : min;
    if (!Number.isFinite(billable) || billable < billingFloor || billable > max) throw new Error(`Assumed active billable vCores must be between ${billingFloor.toFixed(3)} and ${max}, including the memory-normalized minimum.`);
    if (!Number.isFinite(input.activePct) || input.activePct < 0 || input.activePct > 100) throw new Error("Serverless active-use percentage must be 0–100.");
    // Storage is billed even while a database is paused, so it is never
    // omitted. Unspecified storage falls back to the same 32 GB floor the
    // Managed Instance column uses, and says so.
    let perDB;
    if (input.storageGB > 0) {
      perDB = Math.max(1, Math.ceil(input.storageGB / dbs));
    } else {
      perDB = 32;
      assumed.push("32 GB per database assumed: no migrated storage was entered");
    }
    if (perDB > 1024) {
      serverless = unavailable("serverless", serverlessName, `Storage needs ${perDB} GB per database, above this conservative model's 1,024 GB limit. Review database placement; do not change the real database count just to fit.`);
    } else {
      const compute = dbs * billable * HOURS * input.activePct / 100 *
        positiveRate(region.serverless?.paygPerCoreHour, "SQL Database GP Gen5 serverless PAYG");
      const storage = dbs * perDB * positiveRate(region.storage.db_gp_per_gb_mo, "SQL Database GP storage");
      serverless = total({...serverlessBase, compute, storage, deployments: dbs, azureCores: dbs * max, assumed,
        allocation: [`${dbs} database(s); ${min}–${max} configured vCores each; assumed ${billable} memory-normalized billable vCores while online; ${input.activePct}% billable online time`],
        storageDetail: `${dbs} × ${perDB} GB reserved data storage, charged online and paused`});
    }
  }
  scenarios.push(serverless);
  for (const s of [baseline, ...scenarios]) {
    s.deltaMonthly = s.status === "ready" ? s.monthly - baseline.monthly : null;
    s.deltaThreeYear = s.status === "ready" ? s.threeYear - baseline.threeYear : null;
    s.deltaPct = s.status === "ready" && baseline.threeYear > 0 ? s.deltaThreeYear / baseline.threeYear * 100 : null;
  }
  // Reported separately, never folded into the comparison: the retained cores
  // cost exactly this in all four columns, so they cannot influence the choice.
  const retainedContext = {
    cores: sum(retained),
    infrastructure: sum(retained) * input.onPremPerCoreMonth,
    sa: saMonthly(retained) * discountFactor,
    upfront: licensePurchase(retained),
  };
  retainedContext.monthly = retainedContext.infrastructure + retainedContext.sa;
  retainedContext.threeYear = retainedContext.monthly * MONTHS + retainedContext.upfront;
  return {input, source, moved, retained, required, baseline, scenarios, retainedContext};
}

if (typeof module !== "undefined" && module.exports) module.exports = {calculateCoreOptions};

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    const $ = id => document.getElementById(id);
    const form = $("optForm");
    const output = $("optOutput");
    const error = $("optError");
    const money = n => new Intl.NumberFormat("en-US", {style: "currency", currency: "USD", maximumFractionDigits: 0}).format(n);
    const esc = t => String(t).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
    const int = n => Math.round(n).toLocaleString("en-US");
    const picked = name => form.querySelector(`input[name="${name}"]:checked`)?.value;

    const region = $("region");
    for (const name of Object.keys(CALCULATOR_PRICES.regions)) region.add(new Option(REGION_NAMES[name] ?? name, name));
    region.value = "eastus";

    const TARGETS = {
      vm: {idx: 0, label: "SQL Server on Azure VM", blurb: "Lift and shift, full SQL Server control.", unit: "vCPU"},
      mi: {idx: 1, label: "Azure SQL Managed Instance", blurb: "Fully managed, near-full SQL Server compatibility.", unit: "vCore"},
      db: {idx: 2, label: "Azure SQL Database", blurb: "Single databases and elastic pools.", unit: "vCore"},
    };
    // A virtual machine has no service tier. Managed Instance is qualified by
    // tier, Azure SQL Database by purchase model. Options the snapshot cannot
    // price are listed but disabled, and every option states whether Azure
    // Hybrid Benefit reaches it, since that is the reason to prefer one.
    const QUALIFIERS = {
      vm: null,
      mi: {label: "Service tier", options: [
        {value: "gp", text: "General Purpose", priced: true, ahb: true},
        {value: "bc", text: "Business Critical", priced: false, ahb: true},
      ]},
      db: {label: "Purchase model", options: [
        {value: "provisioned", text: "Provisioned vCore", priced: true, ahb: true},
        {value: "serverless", text: "Serverless", priced: true, ahb: false},
        {value: "dtu", text: "DTU", priced: false, ahb: false},
      ]},
    };
    const syncQualifier = () => {
      const target = picked("target");
      const q = QUALIFIERS[target];
      const field = $("qualifierField"), select = $("qualifier");
      field.hidden = !q;
      if (!q) return;
      $("qualifierLabel").textContent = q.label;
      const keep = select.dataset.target === target ? select.value : null;
      if (select.dataset.target !== target) {
        select.dataset.target = target;
        select.replaceChildren();
        for (const o of q.options) {
          // Two different reasons an option can stand out, so both are stated
          // rather than left to the reader: disabled means this snapshot has no
          // published price, while a priced option can still be outside Azure
          // Hybrid Benefit. Greying out the second kind would remove working
          // functionality to convey a footnote.
          const note = !o.priced ? " — not priced here" : o.ahb ? "" : " — no Azure Hybrid Benefit";
          const opt = new Option(`${o.text}${note}`, o.value);
          opt.disabled = !o.priced;
          select.add(opt);
        }
        select.value = q.options.find(o => o.priced).value;
      } else if (keep) select.value = keep;
      const chosen = q.options.find(o => o.value === select.value);
      $("qualifierSub").textContent = chosen?.ahb
        ? "Azure Hybrid Benefit applies to this option."
        : "Azure Hybrid Benefit does not apply to this option.";
    };

    const readInput = () => {
      const target = picked("target");
      const term = picked("term");
      const qual = $("qualifier").value;
      return {
        target,
        standard: Math.floor(Number($("standard").value) || 0),
        enterprise: Math.floor(Number($("enterprise").value) || 0),
        // The whole estate is costed on both sides, so the two columns price
        // exactly the same cores and stay directly comparable.
        migrationPct: 100,
        rightSizePct: Number($("rightSizePct").value),
        region: region.value,
        licenseBasis: "existing",
        ahb: $("ahb").checked,
        serviceTier: target === "mi" ? qual : "gp",
        purchaseModel: target === "db" ? qual : "serverless",
        vmPlan: term, miPlan: term,
        onPremPerCoreMonth: Number($("onPremPerCoreMonth").value),
        avoidablePct: Number($("avoidablePct").value),
        storageGB: Number($("storageGB").value),
        instanceCount: $("instanceCount").value === "" ? null : Number($("instanceCount").value),
        databaseCount: $("databaseCount").value === "" ? null : Number($("databaseCount").value),
        activePct: Number($("activePct").value),
      };
    };

    // Rounded axis maximum so the gridlines land on readable figures.
    const niceMax = v => {
      if (v <= 0) return 1;
      const mag = 10 ** Math.floor(Math.log10(v));
      return Math.ceil(v / (mag / 2)) * (mag / 2);
    };
    const shortMoney = n => n >= 1e6 ? `$${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`
      : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`;

    const chart = (a, b, labelA, labelB) => {
      const W = 360, H = 232, padL = 52, padB = 54, padT = 26;
      const top = niceMax(Math.max(a, b, 1));
      const plotH = H - padB - padT, plotW = W - padL - 12;
      const y = v => padT + plotH - (v / top) * plotH;
      const barW = 78, gap = (plotW - barW * 2) / 3;
      const bars = [
        {v: a, x: padL + gap, fill: "var(--cp-text-muted)", label: labelA},
        {v: b, x: padL + gap * 2 + barW, fill: "var(--cp-accent)", label: labelB},
      ];
      const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => {
        const v = top * f;
        return `<line x1="${padL}" x2="${W - 12}" y1="${y(v)}" y2="${y(v)}" stroke="var(--cp-border)" stroke-width="1"/>
          <text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="var(--cp-text-muted)">${shortMoney(v)}</text>`;
      }).join("");
      const drawn = bars.map(bar => {
        const h = Math.max(1, plotH - (y(bar.v) - padT));
        const lines = bar.label.split("|");
        return `<rect x="${bar.x}" y="${y(bar.v)}" width="${barW}" height="${h}" fill="${bar.fill}" rx="3"/>
          <text x="${bar.x + barW / 2}" y="${y(bar.v) - 8}" text-anchor="middle" font-size="11" font-weight="600" fill="var(--cp-text)">${money(bar.v)}</text>
          ${lines.map((l, i) => `<text x="${bar.x + barW / 2}" y="${H - padB + 18 + i * 13}" text-anchor="middle" font-size="10.5" fill="var(--cp-text-muted)">${esc(l)}</text>`).join("")}`;
      }).join("");
      return `<svg class="opt-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Three-year cost comparison">${ticks}${drawn}</svg>`;
    };

    // The conversion ratio shown on the card is read from the published rules
    // table rather than written out, so the caption cannot drift from the maths.
    const ratioText = (key, tier, editions) => {
      if (AHB_INELIGIBLE.has(key)) return "Not available on the serverless compute tier";
      const unit = key === "vm" ? "vCPU" : "vCore";
      return editions.map(ed => {
        const n = key === "vm" ? AHB_RATIOS.vm[ed][ed] : AHB_RATIOS.mi[tier][ed];
        const label = ed === "enterprise" ? "Enterprise" : "Standard";
        return `1 ${label} licence : ${n} ${unit}${n === 1 ? "" : "s"}`;
      }).join(" \u00b7 ");
    };

    const line = (dt, dd, sub) =>
      `<div class="opt-line"><dt>${dt}</dt><dd>${dd}${sub ? `<em>${sub}</em>` : ""}</dd></div>`;

    const render = () => {
      syncQualifier();
      const input = readInput();
      const t = TARGETS[input.target];
      $("rightSizeValue").textContent = `${input.rightSizePct}%`;

      let report;
      try { report = calculateCoreOptions(input); }
      catch (e) {
        error.textContent = e.message;
        error.hidden = false;
        output.innerHTML = "";
        return;
      }
      error.hidden = true;
      const {source, moved, required, baseline, scenarios} = report;
      const total = source.standard + source.enterprise;
      const inScope = moved.standard + moved.enterprise;

      const az = scenarios[t.idx];

      // Commitment discounts are measured against this footprint's own
      // pay-as-you-go cost rather than quoted as a generic headline number.
      // Serverless is billed per second with no commitment, so the selector
      // has nothing to offer there.
      const termField = $("termField");
      termField.hidden = az.key === "serverless";
      if (!termField.hidden) {
        const compute = plan => {
          try {
            const s = calculateCoreOptions({...input, vmPlan: plan, miPlan: plan}).scenarios[t.idx];
            return s.status === "ready" ? s.compute + s.sqlLicense : null;
          } catch { return null; }
        };
        const payg = compute("payg");
        for (const [plan, el] of [["ri1", $("term1Off")], ["ri3", $("term3Off")]]) {
          const c = compute(plan);
          el.textContent = payg && c !== null && c < payg
            ? `${Math.round((1 - c / payg) * 100)}% off` : "\u00a0";
        }
      }

      if (az.status !== "ready") {
        output.innerHTML = `<div class="opt-compare"><div class="opt-col is-pending">
          <b>${esc(t.label)} cannot be priced with these inputs.</b><p>${esc(az.reason)}</p></div></div>`;
        return;
      }

      const onPremYear = baseline.monthly * 12, azureYear = az.monthly * 12;
      const saving3 = baseline.threeYear - az.threeYear;
      const savingPct = baseline.threeYear > 0 ? saving3 / baseline.threeYear * 100 : 0;
      const opsYear = baseline.infrastructure * 12 - az.infrastructure * 12;
      const azCores = az.key === "serverless" ? az.deployments : az.azureCores;
      const mix = ["enterprise", "standard"].filter(e => moved[e] > 0)
        .map(e => `${int(moved[e])} ${e === "enterprise" ? "Enterprise" : "Standard"}`).join(" + ");

      // Every money line is annual, and the lines in each column sum to that
      // column's total, so the figure at the foot can be checked on screen.
      const renewLines = [
        line("SQL cores (existing)", int(total)),
        line("Software Assurance renewal", money(baseline.sa * 12) + " / year",
          `${mix} cores at published list`),
        line("Hardware &amp; facilities", money(baseline.infrastructure * 12) + " / year",
          `${int(inScope)} cores &times; ${money(input.onPremPerCoreMonth * 12)} / core / year`),
      ].join("");

      // Managed Instance is billed by the pool when pooling is cheaper, so the
      // caption names the topology rather than leaving the vCore count
      // unexplained against the instance count the user entered.
      const topologyNote = az.topology === "pool"
        ? `${int(input.instanceCount)} instances of ${az.instanceSize} vCore in ${int(az.deployments)} instance pool(s)`
        : az.topology === "single" && input.instanceCount
        ? `${int(az.deployments)} deployment(s), four-${t.unit} minimum each`
        : null;

      const azLines = [
        line("Right-sized Azure compute", az.key === "serverless"
          ? `${int(az.deployments)} database(s)` : `${int(az.azureCores)} ${t.unit}`,
          topologyNote ?? `${input.rightSizePct}% optimization from ${int(inScope)} cores`),
        line("Cores kept on Software Assurance", int(az.licenseCores),
          ratioText(az.key, input.serviceTier,
            ["enterprise", "standard"].filter(e => moved[e] > 0))),
        line("Software Assurance renewal", money(az.sa * 12) + " / year",
          az.licenseCores > 0
            ? `${int(az.licenseCores)} cores at published list, required to keep Azure Hybrid Benefit`
            : "No cores held on Software Assurance"),
        line("Azure hosting", money((az.compute + az.sqlLicense + az.storage) * 12) + " / year",
          `${money(az.compute + az.sqlLicense + az.storage)} / month &middot; ${esc(PLANS[az.plan])}`),
        // Server, storage, power, cooling, rack and facilities for the migrated
        // cores. Migrating decommissions that hardware, so by default none of it
        // survives and the line is omitted rather than printed as a zero. It
        // reappears only for estates that keep boxes running through a dual-run
        // period or cannot shrink a fixed facility cost, where the column would
        // otherwise not add up to its own total.
        az.infrastructure > 0
          ? line("Hardware still running", money(az.infrastructure * 12) + " / year",
            `${100 - input.avoidablePct}% of ${money(baseline.infrastructure * 12)} assumed to stay`)
          : "",
      ].join("");

      const ahbApplies = az.key !== "serverless";
      const badge = !ahbApplies ? {cls: " is-off", text: "AHB n/a for serverless"}
        : input.ahb ? {cls: "", text: "AHB applied &#10003;"}
        : {cls: " is-off", text: "AHB off"};

      const takeaways = [
        `Right-sizing at ${input.rightSizePct}% takes ${int(inScope)} source cores to ${int(az.azureCores)} ${t.unit}.`,
        // Moved out of the card heading, which is now a single line, but the
        // parity is worth stating: the two services are not priced differently
        // at this tier, so the choice is about management model, not cost.
        ...(az.key === "dbProvisioned" ? ["At General Purpose this prices the same as Managed Instance: both bill against the Gen5 compute meter at the same storage rate."] : []),
        ...(az.topology === "pool" ? [`Instance pools are cheaper here: a two-vCore instance only exists inside a pool, and the pool is the billable unit, so these ${int(input.instanceCount)} servers avoid the four-vCore single-instance minimum.`] : []),
        !ahbApplies
          ? `Azure Hybrid Benefit does not apply to serverless, so its SQL licence is included in the hourly rate instead.`
          : input.ahb && az.licenseCores < inScope
          ? `Azure Hybrid Benefit keeps Software Assurance on ${int(az.licenseCores)} cores instead of ${int(inScope)}.`
          : input.ahb ? `Azure Hybrid Benefit is applied, but this footprint still needs Software Assurance on ${int(az.licenseCores)} cores.`
          : `Azure Hybrid Benefit is switched off, so the Azure SQL licence meter is paid instead.`,
        opsYear > 0 ? `Decommissioning the migrated servers removes about ${money(opsYear)} a year of hardware and facilities cost.`
          : `On-premises hardware is unchanged at this migration share.`,
        saving3 > 0 ? `Estimated ${money(saving3)} lower over three years, about ${savingPct.toFixed(0)}% against renewing.`
          : `This configuration costs ${money(-saving3)} more over three years than renewing.`,
      ].map(x => `<li>${x}</li>`).join("");

      output.innerHTML = `
        <div class="opt-compare">
          <div class="opt-col">
            <div class="opt-col-head">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--cp-text-muted)"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/></svg>
              <div><h3 style="color:var(--cp-text)">Renew on-prem <span>(Current path)</span></h3>
              <p>Stay on-premises, renew Software Assurance.</p></div>
            </div>
            <dl class="opt-lines">${renewLines}</dl>
            <div class="opt-total"><span>Estimated annual cost</span><b>${money(onPremYear)}</b></div>
          </div>
          <div class="opt-col is-azure">
            <div class="opt-col-head">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 3 3.5 18h4L14 3zM13 9l-4.5 9H21z"/></svg>
              <div><h3>Modernize to Azure</h3><p>${esc(t.blurb)}</p></div>
              <span class="opt-badge${badge.cls}">${badge.text}</span>
            </div>
            <dl class="opt-lines">${azLines}</dl>
            <div class="opt-total"><span>Estimated annual cost</span><b>${money(azureYear)}</b></div>
          </div>
        </div>

        <div class="opt-lower">
          <div class="opt-chart-wrap">
            <div>
              <h3>3-year cost comparison</h3>
              <p>Total estimated cost over three years. Software Assurance is charged at published list; your agreement will differ.</p>
              ${chart(baseline.threeYear, az.threeYear,
                `Renew on-prem|${int(inScope)} cores`,
                `Modernize to Azure|${int(azCores)} ${az.key === "serverless" ? "database(s)" : t.unit}`)}
            </div>
            <div class="opt-save">
              <h4><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 12h3M8 16h3M15 12v5"/></svg> Estimated 3-year ${saving3 >= 0 ? "savings" : "increase"}</h4>
              <b>${money(Math.abs(saving3))}</b>
              <span class="vs">${saving3 >= 0 ? "lower" : "higher"} than renewing on-premises &middot; ${Math.abs(savingPct).toFixed(0)}%</span>
              <p>Based on the inputs and assumptions below. Actual cost varies with your agreement, workload profile and region.</p>
            </div>
          </div>
          <div class="opt-takeaways">
            <h3><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg> Key takeaways</h3>
            <ol>${takeaways}</ol>
          </div>
        </div>`;
    };

    for (const root of [form, $("optAssumptions")]) {
      root.addEventListener("input", render);
      root.addEventListener("change", render);
    }
    form.addEventListener("submit", e => e.preventDefault());
    render();
  });
}
