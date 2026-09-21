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

// Azure capacity is not sold in one uniform block size. An architect fits the
// workload to the real size ladder, so the last deployment is sized to the
// remainder instead of rounding a whole block up. Sizes below are the SKUs
// actually priced in the snapshot; the MI ladder is the published Gen5 set.
const VM_SIZES = [16, 8, 4];
const MI_SIZES = [80, 64, 40, 32, 24, 16, 8, 4];

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
  const input = {rightSizePct: 20, unitCores: 16, onPremPerCoreMonth: 37.5, avoidablePct: 50,
    storageGB: 0, licenseBasis: "existing", discountPct: 0, ahb: true,
    vmPlan: "auto", miPlan: "auto", migrationPct: 50, instanceCount: null,
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
  const packs = key => Object.fromEntries(Object.entries(required).map(([e, n]) => {
    if (!n) return [e, []];
    const ladder = key === "vm" ? VM_SIZES : MI_SIZES;
    if (instancesPer) return [e, sizePerInstance(n, instancesPer[e], input.unitCores, ladder)];
    return [e, packDeployments(n, input.unitCores, ladder)];
  }));
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
  const scenarios = ["vm", "mi"].map(key => {
    const name = key === "vm" ? "SQL Server on Azure VM" : "SQL Managed Instance GP";
    const layout = packs(key);
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
    for (const edition of ["standard", "enterprise"]) {
      const sizeList = layout[edition];
      if (!sizeList.length) continue;
      const ratio = key === "mi" && edition === "enterprise" ? 4 : 1;
      // This is conditional coverage, not entitlement evidence. Rights retained
      // on-premises are never pooled with the migrated share.
      let entitled = input.ahb ? moved[edition] * ratio : 0;
      let covered = 0;
      for (const size of sizeList) {
        // AHB applies per deployment, so a deployment is only covered when the
        // entitlement stretches across the whole of it.
        const takes = entitled >= size;
        if (takes) { entitled -= size; covered += size; }
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
      // Source licence cores consumed by the benefit, back through the ratio.
      ahbBackingCores[edition] = covered / ratio;
      allocation.push(`${edition}: ${sizeList.length} ${instancesPer ? "instance" : "deployment"}(s) of ${sizeList.length > 6 ? `${sizeList[0]} ${key === "vm" ? "vCPU" : "vCore"} each` : sizeList.join(" + ")} for ${required[edition]} required; ${covered} ${key === "vm" ? "vCPU" : "vCore"} assumed SQL AHB${key === "vm" && input.ahb ? "; Windows Server AHB assumed" : ""}`);
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
      const perUnit = Math.max(32, Math.ceil(input.storageGB / deployments / 32) * 32);
      const limit = Math.min(...sizes) === 4 ? 2048 : 8192;
      if (perUnit > limit) return unavailable(key, name, `MI storage needs ${perUnit} GB per instance, above this model's ${limit} GB limit. Increase deployment size or review placement.`);
      storage = perUnit * deployments * positiveRate(region.storage.mi_gp_per_gb_mo, "MI GP storage");
      storageDetail = `${deployments} × ${perUnit} GB reserved storage (32 GB increments)`;
    }
    return total({...base, key, name, plan, infrastructure, compute, sqlLicense, storage, storageDetail,
      sa: saMonthly(ahbBackingCores),
      licenseCores: sum(ahbBackingCores),
      allocation, coveredCores, azureCores, deployments, sizes, scopedCores: sum(moved)});
  });
  const serverlessName = "Azure SQL Database serverless";
  const serverlessBase = {...base, key: "serverless", name: serverlessName, infrastructure, scopedCores: sum(moved), plan: "payg"};
  let serverless;
  {
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

    $("btnTheme").onclick = () => {
      const root = document.documentElement;
      root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    };

    const TARGETS = {
      vm: {idx: 0, label: "SQL Server on Azure VM", blurb: "Lift and shift onto Azure Virtual Machines, keeping full SQL Server control.", unit: "vCPU"},
      mi: {idx: 1, label: "Azure SQL Managed Instance", blurb: "Run your SQL workloads on a managed platform and use your existing licences with Azure Hybrid Benefit.", unit: "vCore"},
      serverless: {idx: 2, label: "Azure SQL Database", blurb: "Usage-based databases that scale down between bursts.", unit: "vCore"},
    };

    const readInput = () => {
      const target = picked("target");
      const term = picked("term");
      return {
        target,
        standard: Math.floor(Number($("standard").value) || 0),
        enterprise: Math.floor(Number($("enterprise").value) || 0),
        migrationPct: Number($("migrationPct").value),
        rightSizePct: Number($("rightSizePct").value),
        region: region.value,
        licenseBasis: "existing",
        ahb: $("ahb").checked,
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

    const line = (dt, dd, sub) =>
      `<div class="opt-line"><dt>${dt}</dt><dd>${dd}${sub ? `<em>${sub}</em>` : ""}</dd></div>`;

    const render = () => {
      const input = readInput();
      const t = TARGETS[input.target];
      $("migrationValue").textContent = `${input.migrationPct}%`;
      $("rightSizeValue").textContent = `${input.rightSizePct}%`;
      $("computeModelField").hidden = input.target !== "serverless";
      $("computeModelFor").textContent = "(Azure SQL Database)";

      let report;
      try { report = calculateCoreOptions(input); }
      catch (e) {
        error.textContent = e.message;
        error.hidden = false;
        output.innerHTML = "";
        $("scopeSub").textContent = "";
        return;
      }
      error.hidden = true;
      const {source, moved, required, baseline, scenarios} = report;
      const total = source.standard + source.enterprise;
      const inScope = moved.standard + moved.enterprise;
      $("scopeSub").textContent = `${int(inScope)} of ${int(total)} cores in scope`;

      // Commitment discounts are measured against this footprint's own
      // pay-as-you-go cost rather than quoted as a generic headline number.
      const termField = $("termField");
      termField.hidden = input.target === "serverless";
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

      const az = scenarios[t.idx];
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

      const renewLines = [
        line("SQL cores (existing)", int(total)),
        line("Existing licences", "Already owned"),
        line("Software Assurance renewal", `${int(inScope)} cores`, `${money(baseline.sa * 12)} / year at list`),
        line("Infrastructure &amp; operations", money(baseline.infrastructure * 12) + " / year",
          `${int(inScope)} cores &times; ${money(input.onPremPerCoreMonth * 12)} / core / year`),
      ].join("");

      const azLines = [
        line("Right-sized Azure compute", az.key === "serverless"
          ? `${int(az.deployments)} database(s)` : `${int(az.azureCores)} ${t.unit}`,
          `${input.rightSizePct}% optimization from ${int(inScope)} cores`),
        line("Cores kept on Software Assurance", int(az.licenseCores),
          az.key === "mi" && moved.enterprise ? "4:1 ratio for Enterprise on General Purpose"
            : az.key === "serverless" ? "Hybrid Benefit does not apply to serverless" : "1:1 ratio"),
        line("Software Assurance renewal", `${int(az.licenseCores)} cores`, `${money(az.sa * 12)} / year at list`),
        line("Azure hosting cost", money(az.compute + az.sqlLicense + az.storage) + " / month",
          `${esc(PLANS[az.plan])}${az.infrastructure > 0 ? `, plus ${money(az.infrastructure)} / month retained on-premises` : ""}`),
      ].join("");

      const ahbApplies = az.key !== "serverless";
      const badge = !ahbApplies ? {cls: " is-off", text: "AHB n/a for serverless"}
        : input.ahb ? {cls: "", text: "AHB applied &#10003;"}
        : {cls: " is-off", text: "AHB off"};

      const takeaways = [
        `Right-sizing at ${input.rightSizePct}% takes ${int(inScope)} source cores to ${int(az.key === "serverless" ? az.azureCores : az.azureCores)} ${t.unit}.`,
        !ahbApplies
          ? `Azure Hybrid Benefit does not apply to serverless, so its SQL licence is included in the hourly rate instead.`
          : input.ahb && az.licenseCores < inScope
          ? `Azure Hybrid Benefit keeps Software Assurance on ${int(az.licenseCores)} cores instead of ${int(inScope)}.`
          : input.ahb ? `Azure Hybrid Benefit is applied, but this footprint still needs Software Assurance on ${int(az.licenseCores)} cores.`
          : `Azure Hybrid Benefit is switched off, so the Azure SQL licence meter is paid instead.`,
        opsYear > 0 ? `Migrating avoids about ${money(opsYear)} a year of on-premises infrastructure and operations.`
          : `On-premises operations are unchanged at this migration share.`,
        saving3 > 0 ? `Estimated ${money(saving3)} lower over three years, about ${savingPct.toFixed(0)}% against renewing.`
          : `This configuration costs ${money(-saving3)} more over three years than renewing.`,
      ].map(x => `<li>${x}</li>`).join("");

      output.innerHTML = `
        <div class="opt-compare">
          <div class="opt-col">
            <div class="opt-col-head">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--cp-text-muted)"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/></svg>
              <div><h3 style="color:var(--cp-text)">Renew on-prem <span>(Current path)</span></h3>
              <p>Keep the SQL Server estate on-premises and renew Software Assurance.</p></div>
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

    const exportCsv = () => {
      const input = readInput();
      let report;
      try { report = calculateCoreOptions(input); } catch { return; }
      const t = TARGETS[input.target];
      const az = report.scenarios[t.idx];
      if (az.status !== "ready") return;
      const rows = [
        ["SQL Renewal Optimizer"],
        ["Region", REGION_NAMES[input.region] ?? input.region],
        ["Standard cores", input.standard],
        ["Enterprise cores", input.enterprise],
        ["Share moving to Azure", `${input.migrationPct}%`],
        ["Right-sizing", `${input.rightSizePct}%`],
        ["Target service", t.label],
        ["Commitment term", PLANS[az.plan]],
        ["Azure Hybrid Benefit", input.ahb ? "Applied" : "Not applied"],
        [],
        ["", "Renew on-prem", "Modernize to Azure"],
        ["Monthly", Math.round(report.baseline.monthly), Math.round(az.monthly)],
        ["Annual", Math.round(report.baseline.monthly * 12), Math.round(az.monthly * 12)],
        ["3-year total", Math.round(report.baseline.threeYear), Math.round(az.threeYear)],
        ["3-year saving", "", Math.round(report.baseline.threeYear - az.threeYear)],
        [],
        ["Directional estimate at published list prices. Run an Azure Migrate assessment for an accurate one."],
      ];
      const csv = rows.map(r => r.map(c => {
        const s = String(c ?? "");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(",")).join("\r\n");
      const url = URL.createObjectURL(new Blob([csv], {type: "text/csv;charset=utf-8"}));
      const a = Object.assign(document.createElement("a"),
        {href: url, download: "sql-renewal-optimizer.csv"});
      document.body.append(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    };

    for (const root of [form, $("optAssumptions")]) {
      root.addEventListener("input", render);
      root.addEventListener("change", render);
    }
    form.addEventListener("submit", e => e.preventDefault());
    $("btnExport").addEventListener("click", exportCsv);
    $("btnReset").addEventListener("click", () => {
      form.reset();
      $("optAssumptions").querySelectorAll("input, select").forEach(el => {
        if (el.type === "checkbox") el.checked = el.defaultChecked;
        else el.value = el.defaultValue;
      });
      region.value = "eastus";
      render();
    });
    render();
  });
}
