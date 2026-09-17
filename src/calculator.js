"use strict";

const CALCULATOR_PRICES = /*__PRICES__*/{}/*__END_PRICES__*/;
const HOURS = 730;
const MONTHS = 36;
const PLANS = {payg: "PAYG", ri1: "1-year reservation", ri3: "3-year reservation",
  sp1: "1-year savings plan", sp3: "3-year savings plan"};
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

function positiveRate(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Missing or invalid published rate: ${name}.`);
  return value;
}

function calculateCoreOptions(raw, prices = CALCULATOR_PRICES) {
  const input = {rightSizePct: 20, unitCores: 16, onPremPerCoreMonth: 37.5, avoidablePct: 50,
    storageGB: 0, licenseBasis: "existing", discountPct: 0, ahb: true,
    vmPlan: "ri3", miPlan: "ri3", migrationPct: 50,
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
    if (!Object.hasOwn(PLANS, input[key])) throw new Error(`Invalid ${key}.`);
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
  const packs = key => Object.fromEntries(Object.entries(required).map(([e, n]) =>
    [e, n ? packDeployments(n, input.unitCores, key === "vm" ? VM_SIZES : MI_SIZES) : []]));
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
    const plan = input[`${key}Plan`];
    const layout = packs(key);
    const sizes = [...layout.standard, ...layout.enterprise];
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
      allocation.push(`${edition}: ${sizeList.length} deployment(s) of ${sizeList.join(" + ")} ${key === "vm" ? "vCPU" : "vCore"} for ${required[edition]} required; ${covered} ${key === "vm" ? "vCPU" : "vCore"} assumed SQL AHB${key === "vm" && input.ahb ? "; Windows Server AHB assumed" : ""}`);
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
    const form = document.getElementById("calculatorForm");
    const results = document.getElementById("calculatorResults");
    const error = document.getElementById("calcError");
    const money = n => new Intl.NumberFormat("en-US", {style: "currency", currency: "USD", maximumFractionDigits: 0}).format(n);
    const escape = text => String(text).replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
    const region = form.elements.region;
    for (const name of Object.keys(CALCULATOR_PRICES.regions)) region.add(new Option(REGION_NAMES[name] ?? name, name));
    region.value = "eastus";
    const date = v => new Date(v).toLocaleDateString("en-US", {year:"numeric", month:"short", day:"numeric", timeZone:"UTC"});
    document.getElementById("priceDate").textContent = `VM / MI / serverless / SQL license rates: ${date(CALCULATOR_PRICES.captured)}. Storage snapshot: ${date(CALCULATOR_PRICES.infrastructureSnapshot)}. USD public rates, embedded; no runtime requests.`;
    document.getElementById("btnTheme").onclick = () => {
      const root = document.documentElement;
      root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    };
    const sync = () => {
      const pct = Number(form.elements.migrationPct.value);
      document.getElementById("migrationValue").textContent = `${pct}%`;
      // The slider end labels double as live readouts, using the model's own
      // floor-per-edition split so the counts shown are the counts priced.
      const counts = ["standard", "enterprise"].map(k => Math.max(0, Math.floor(Number(form.elements[k].value) || 0)));
      const moved = counts.map(n => Math.floor(n * pct / 100));
      const total = counts[0] + counts[1], moving = moved[0] + moved[1];
      const num = n => n.toLocaleString();
      document.getElementById("movingLabel").textContent = total
        ? `${num(moving)} migrate` : "Keep on-premises";
      document.getElementById("stayingLabel").textContent = total
        ? `${num(total - moving)} stay on-premises` : "Move everything";
      document.getElementById("assumptionSummary").textContent =
        `${form.elements.rightSizePct.value}% right-sizing · ${form.elements.licenseBasis.selectedOptions[0].textContent}`;
      const r = CALCULATOR_PRICES.regions[region.value];
      const sku = `Standard_E${form.elements.unitCores.value}bds_v5`;
      for (const key of ["vm", "mi"]) {
        const select = form.elements[`${key}Plan`];
        const selected = select.value || "ri3";
        select.replaceChildren();
        for (const [plan, label] of Object.entries(PLANS)) {
          const supported = key === "vm" ? r.vmPlans?.[sku]?.rates?.[plan] : r.miPlans?.[plan];
          const option = new Option(`${label}${supported ? "" : " — rate unavailable"}`, plan);
          option.disabled = !supported;
          select.add(option);
        }
        // Preserve a previously selected unsupported term so it is surfaced in
        // the results, never silently replaced by a different price.
        select.value = selected;
      }
      results.hidden = true;
      error.textContent = "";
    };
    form.addEventListener("input", sync);
    form.addEventListener("change", sync);
    sync();
    // Collapsing the form on submit keeps the inputs available as context while
    // giving the answer the whole viewport. Editing restores them in place.
    const summary = document.getElementById("calcSummary");
    const collapse = on => {
      form.hidden = on;
      summary.hidden = !on;
    };
    document.getElementById("btnEdit").addEventListener("click", () => {
      collapse(false);
      results.hidden = true;
      form.scrollIntoView({block: "start", behavior: "smooth"});
      form.elements.standard.focus();
    });
    form.addEventListener("submit", event => {
      event.preventDefault();
      results.hidden = true;
      error.textContent = "";
      if (!form.reportValidity()) return;
      const input = {};
      for (const key of ["standard","enterprise","migrationPct","rightSizePct","unitCores",
        "onPremPerCoreMonth","avoidablePct","storageGB","serverlessMin","serverlessMax","serverlessBillable","activePct"]) {
        input[key] = Number(form.elements[key].value);
      }
      input.databaseCount = form.elements.databaseCount.value === "" ? null : Number(form.elements.databaseCount.value);
      input.ahb = form.elements.ahb.checked;
      for (const key of ["region","vmPlan","miPlan","licenseBasis"]) input[key] = form.elements[key].value;
      let report;
      try { report = calculateCoreOptions(input); }
      catch (e) { error.textContent = `Cannot calculate: ${e.message}`; return; }
      const {source, moved, retained, baseline, scenarios} = report;
      const all = [baseline, ...scenarios];
      const regionalPrices = CALCULATOR_PRICES.regions[input.region];
      const hourly = value => Number.isFinite(value) ? value.toFixed(6) : "unavailable";
      const vmRate = regionalPrices.vmPlans?.[`Standard_E${input.unitCores}bds_v5`]?.rates?.[input.vmPlan];
      const miRates = regionalPrices.miPlans?.[input.miPlan];
      const rows = [
        ["On-premises infrastructure / operations", "infrastructure"],
        ["SQL Server Software Assurance (retained + AHB-backing cores)", "sa"],
        [`Azure compute (VM ${input.ahb ? "excludes Windows via AHB" : "includes Windows"}; serverless includes SQL)`, "compute"],
        ["Azure SQL licensing (VM / MI)", "sqlLicense"], ["Azure storage", "storage"],
      ];
      const inScope = sum(moved);
      // Highlight the lowest modeled three-year cost. Directional estimates are
      // excluded: an option running on assumed inputs is not comparable on the
      // same evidence, and would otherwise win precisely because it was guessed.
      const ready = all.filter(s => s.status === "ready");
      const comparable = ready.filter(s => !s.assumed?.length);
      const bestKey = comparable.length > 1
        ? comparable.reduce((a, b) => a.threeYear <= b.threeYear ? a : b).key : null;
      const anyDirectional = ready.some(s => s.assumed?.length);
      const editionLabel = moved.standard && moved.enterprise ? "Mixed-edition"
        : moved.enterprise ? "Enterprise" : "Standard";
      results.innerHTML = `
        <div class="card">
          <h2>Four ways to host the ${inScope.toLocaleString()} cores you are moving</h2>
          <p>${inScope.toLocaleString()} of ${sum(source).toLocaleString()} cores are in scope: ${moved.standard} Standard + ${moved.enterprise} Enterprise.
          Every column below costs <b>this same workload</b>, hosted four different ways. On-premises needs all ${inScope.toLocaleString()} cores; the Azure options may need fewer after right-sizing.</p>
          ${report.retainedContext.cores > 0 ? `<div class="note">The other ${report.retainedContext.cores.toLocaleString()} cores (${retained.standard} Standard + ${retained.enterprise} Enterprise) stay on-premises whichever option you choose, and cost about ${money(report.retainedContext.threeYear)} over three years.
          That figure is context only and is deliberately outside the comparison: an identical amount in every column cannot change the decision, only shrink the visible difference. Add it to any column for a full-estate view.</div>` : ""}
          <p class="calc-muted">${escape(REGION_NAMES[input.region] ?? input.region)} · 730 hours/month · ${input.rightSizePct}% assumed VM / MI right-sizing · deployments sized up to ${input.unitCores} cores and fitted to the published size ladder.
          </p>
          <p><b>${input.licenseBasis === "existing"
            ? "Licenses are assumed already purchased, so only Software Assurance continues; no new purchase is charged to any column."
            : "License-refresh scenario: a one-time SQL license purchase is modeled over 3 years, not as an annual renewal."}</b>
          ${input.licenseBasis === "refresh" ? "Staying on-premises buys licenses for these cores; the Azure options do not." : ""}
          Three-year TCO = ${input.licenseBasis === "refresh" ? "one-time purchase + " : ""}36 × recurring monthly cost.</p>
          <p class="calc-muted">All figures are published list prices. Negotiated or agreement-specific discounts are not applied and will change these totals.</p>
          <div class="note warn">Only ${input.avoidablePct}% of these cores' on-premises operations is assumed avoidable; the fixed share remains in every Azure option.
          ${input.onPremPerCoreMonth === 0 ? "On-premises operations are omitted: not a full TCO or savings claim." : ""}
          ${input.storageGB === 0 ? "Migrated storage is unspecified: VM data disks omitted; MI uses 32 GB per instance; serverless needs a storage input." : ""}
          Software Assurance is charged at published list: on all in-scope cores if they stay, or only on the cores whose rights back AHB if they move, because AHB requires active eligible SA or a qualifying subscription. Migrated cores without AHB pay the Azure SQL meter instead, never both. Actual SA pricing is agreement-specific.
          These partial-cost comparisons are not full TCO or guaranteed savings.
          Core counts and this estimate do not prove license entitlements or feature readiness.</div>
          <div class="calc-results">${all.map(s => {
            const label = CARD_LABELS[s.key];
            const eyebrow = s.key === "mi" && input.ahb && moved.enterprise > 0 ? "4:1 Enterprise AHB" : label.eyebrow;
            const subtitle = s.key === "stay" ? `${editionLabel} footprint staying put` : label.subtitle;
            const head = `<p class="calc-eyebrow">${eyebrow}</p><h3>${label.title}</h3><p class="calc-sub">${subtitle}</p>`;            if (s.status !== "ready") {
              return `<article class="calc-option">${head}
                <p class="calc-pending"><b>${s.status === "input-needed" ? "Input needed" : "Unavailable"}</b></p>
                <p class="calc-pending">${escape(s.reason)}</p>
                <p class="calc-muted">No total or savings reported; not $0. The retained footprint and ongoing costs still apply.</p></article>`;
            }
            const savings = s.key === "stay" ? `<dd class="is-base">Baseline</dd>`
              : `<dd class="${s.deltaThreeYear < 0 ? "is-saving" : s.deltaThreeYear > 0 ? "is-higher" : ""}">${money(Math.abs(s.deltaThreeYear))}${s.deltaPct === null ? "" : ` · ${Math.abs(s.deltaPct).toFixed(0)}%`}${s.deltaThreeYear > 0 ? " more" : ""}</dd>`;
            return `<article class="calc-option${s.key === bestKey ? " is-best" : ""}">${head}
              <div class="calc-price">${money(s.monthly)}<span>per month${s.plan && s.plan !== "payg" ? ", amortized commitment" : ""}</span></div>
              <dl class="calc-specs">
                <div><dt>3-year TCO</dt><dd>${money(s.threeYear)}</dd></div>
                <div><dt>Savings</dt>${savings}</div>
              </dl>
              ${s.assumed?.length ? `<p class="calc-assumed">Directional: ${escape(s.assumed.join("; "))}.</p>` : ""}</article>`;
          }).join("")}</div>
          ${bestKey ? `<p class="calc-muted">Highlighted: lowest modeled 3-year cost${anyDirectional ? " among the options with complete inputs" : ""}. That is an arithmetic result for the assumptions above, not a recommendation; compatibility, readiness and operational fit are not assessed here.${anyDirectional ? " Any column marked directional is running on assumed inputs and is excluded from that comparison until real figures are entered." : ""}</p>` : ""}
          <details class="acc"><summary>Monthly cost breakdown, rates and scope</summary>
            <div class="tbl-wrap"><table class="calc-table"><thead><tr><th>Monthly component</th>${all.map(s => `<th>${CARD_LABELS[s.key].title}</th>`).join("")}</tr></thead>
            <tbody>${rows.map(([label,key]) => `<tr><th scope="row">${label}</th>${all.map(s => `<td>${s.status === "ready" ? money(s[key]) : "Not calculated"}</td>`).join("")}</tr>`).join("")}
            <tr><th scope="row">One-time SQL license purchase (not monthly)</th>${all.map(s => `<td>${s.status === "ready" ? money(s.upfront) : "Not calculated"}</td>`).join("")}</tr></tbody></table></div>
            <p>Refresh purchase = ceil(Standard cores / 2) × $3,945 + ceil(Enterprise cores / 2) × $15,123.
            These are published SQL Server 2022 two-core pack list prices, not annual SA rates or a current-contract quote.
            Refresh is a hypothetical planned replacement purchase, not a recharge of historical licenses. Existing-license mode excludes it.
            Only the on-premises column buys licenses for these cores; moving them avoids that purchase. With AHB, existing eligible rights must be independently available; no new rights or SA are assumed free.</p>
            ${scenarios.filter(s => s.status === "ready").map(s => `<p><b>${s.name}</b>: ${escape(s.allocation.join("; ") || "No migration")}. ${escape(s.storageDetail)}.</p>`).join("")}
            <p>Standard and Enterprise workloads are sized separately: floor migrated cores, ceil right-sized demand, then fit that demand to the published Azure size ladder largest-first, so only the final deployment carries rounding.
            These 4/8/16-core groups are illustrative consolidation, not an exact topology. Memory, IOPS, HA/DR replicas and compatibility are not inferred.</p>
            <p>VM: Windows Ebdsv5, one P10 OS disk per VM. MI: classic General Purpose standard-series Gen5, not Business Critical or next-gen GP.
            Storage is spread evenly; actual placement and service limits require review.</p>
            <p>AHB is conditional on independently verified, reassignable eligible SA/subscription licenses. The checkbox is an assumption, not verification.
            Only the migrated share is available: Standard 1:1 and Enterprise 4:1 for MI GP; same-edition 1:1 for VM.
            Only fully covered reference deployments receive AHB. Entitlement ratios never right-size capacity, and retained on-premises rights are not reused.</p>
            <p>One pricing plan per scenario: reservations and savings plans never stack on the same usage. VM commitment discounts apply only to infrastructure;
            they do not discount Windows/SQL licensing or storage. MI uses published plan-specific included/base rates.
            Commitments assume 100% utilization every hour. Monthly figures amortize the full commitment; 3-year projections assume 1-year terms are purchased again at unchanged rates, not automatic renewal. Actual prices and unused commitments may differ.</p>
            <p>Selected published hourly rates (USD): VM ${escape(PLANS[input.vmPlan])} ${hourly(vmRate)}/VM including Windows;
            MI ${escape(PLANS[input.miPlan])} ${hourly(miRates?.included)}/vCore license-included or ${hourly(miRates?.base)}/vCore AHB base;
            serverless PAYG ${hourly(regionalPrices.serverless?.paygPerCoreHour)}/billable vCore.
            MI RI1 base is derived from included RI1 minus the published PAYG SQL license component; reservations exclude software charges.</p>
          </details>
          <div class="note info"><b>Serverless is optional and illustrative, not a readiness recommendation.</b>
            The explicitly entered database count and storage apply to the selected migrating footprint, not the whole estate; recheck both whenever migration scope changes.
            Each database is assumed to fit the same chosen compute range and equal storage share. This is an unverified full-footprint equivalence assumption; source cores do not size serverless.
            Only eligible General Purpose databases can auto-pause. Active-use % means all billable online time, including idle auto-pause delay, not just query activity.
            Assumed billable vCores include max(CPU, memory/3 GB, configured CPU/memory minimums); this is declared, not measured.
            Compute = databases × assumed billable vCores × 730 × active-use % × PAYG rate; storage continues while paused.
            No AHB or RI. Database savings plans may be available, but are not modeled here without hourly commitment/usage matching; this is explicitly a PAYG comparison. No universal savings claim.</div>
          <p class="calc-muted">Excluded: ongoing SA/subscription fees, application tier, ESU, migration effort, networking, extra backup storage, DR, security services, taxes and free allowances.
          No negotiated price is verified by this calculator. <a href="modernization-options/">Review the decision guide</a> and use Azure Migrate before committing.</p>
        </div>`;
      const setSum = (id, text) => { document.getElementById(id).textContent = text; };
      const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
      setSum("sumFootprint", [
        source.standard ? plural(source.standard, "Standard core") : "",
        source.enterprise ? plural(source.enterprise, "Enterprise core") : "",
      ].filter(Boolean).join(" + "));
      setSum("sumMoving", `${inScope.toLocaleString()} of ${sum(source).toLocaleString()} (${input.migrationPct}%)`);
      setSum("sumRegion", REGION_NAMES[input.region] ?? input.region);
      setSum("sumAhb", input.ahb ? "Applied" : "Not applied");
      collapse(true);
      results.hidden = false;
      results.focus();
    });
  });
}
