"use strict";

const CALCULATOR_PRICES = /*__PRICES__*/{}/*__END_PRICES__*/;
const HOURS = 730;
const MONTHS = 36;
const PLANS = {payg: "PAYG", ri1: "1-year reservation", ri3: "3-year reservation",
  sp1: "1-year savings plan", sp3: "3-year savings plan"};
const DISKS = [
  ["P4", 32], ["P6", 64], ["P10", 128], ["P15", 256], ["P20", 512],
  ["P30", 1024], ["P40", 2048], ["P50", 4096], ["P60", 8192],
  ["P70", 16384], ["P80", 32767],
];
const sum = o => o.standard + o.enterprise;

function positiveRate(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Missing or invalid published rate: ${name}.`);
  return value;
}

function calculateCoreOptions(raw, prices = CALCULATOR_PRICES) {
  const input = {rightSizePct: 20, unitCores: 16, onPremPerCoreMonth: 37.5, avoidablePct: 50,
    storageGB: 0, licenseBasis: "refresh", discountPct: 0, ahb: true,
    vmPlan: "ri3", miPlan: "ri3",
    serverlessEnabled: false, databaseCount: null, serverlessMin: 1, serverlessMax: 8,
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
  for (const key of ["ahb", "serverlessEnabled"]) {
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
  const required = Object.fromEntries(Object.entries(moved).map(([e, n]) => [e, n ? Math.ceil(n * (1 - input.rightSizePct / 100)) : 0]));
  const units = Object.fromEntries(Object.entries(required).map(([e, n]) => [e, n ? Math.ceil(n / input.unitCores) : 0]));
  const deployments = sum(units);
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
  // Only the declared avoidable share falls with the actual migrated footprint.
  const infrastructure = fullInfrastructure * (1 - input.avoidablePct / 100 * sum(moved) / sum(source));
  const base = {upfront: licensePurchase(retained), compute: 0, sqlLicense: 0, storage: 0, coveredCores: 0,
    sa: saMonthly(retained),
    azureCores: 0, deployments: 0, allocation: [], storageDetail: "No Azure deployments"};
  const total = scenario => {
    const compute = scenario.compute * discountFactor;
    const sqlLicense = scenario.sqlLicense * discountFactor;
    const storage = scenario.storage * discountFactor;
    const sa = scenario.sa * discountFactor;
    const monthly = scenario.infrastructure + compute + sqlLicense + storage + sa;
    return {...scenario, compute, sqlLicense, storage, sa, status: "ready", monthly, threeYear: monthly * MONTHS + scenario.upfront};
  };
  const baseline = total({...base, upfront: licensePurchase(source), key: "stay", name: "Stay on-premises",
    infrastructure: fullInfrastructure, sa: saMonthly(source), retainedCores: sum(source)});
  const unavailable = (key, name, reason, status = "unavailable") => ({
    ...base, key, name, status, reason, infrastructure, retainedCores: sum(retained), monthly: null, threeYear: null,
  });
  const scenarios = ["vm", "mi"].map(key => {
    const name = key === "vm" ? "SQL Server on Azure VM" : "SQL Managed Instance GP";
    const plan = input[`${key}Plan`];
    const sku = `Standard_E${input.unitCores}bds_v5`;
    const rate = key === "vm" ? region.vmPlans?.[sku]?.rates?.[plan] : region.miPlans?.[plan];
    if (deployments && !rate && plan !== "payg") return unavailable(key, name, `${PLANS[plan]} unavailable: no verified ${input.region} ${key === "vm" ? sku : "MI GP Gen5"} rate in this snapshot. Select a supported plan.`);
    // The single Azure Hybrid Benefit choice also covers Windows Server on the
    // VM scenario. Windows AHB removes the Windows licence uplift embedded in
    // the VM meter. Reservations and savings plans never discount that uplift,
    // so it is deducted at its unchanged PAYG value from the selected term.
    let windowsCredit = 0;
    if (key === "vm" && input.ahb && deployments) {
      windowsCredit = positiveRate(region.vmPlans?.[sku]?.windowsLicensePerHour,
        `${input.region} ${sku} Windows Server licence uplift`);
      if (windowsCredit >= positiveRate(rate, `${input.region} ${sku} ${plan}`)) {
        throw new Error("Windows Server licence uplift is not below the published VM rate.");
      }
    }
    const vmRate = key === "vm" && deployments ? positiveRate(rate, `${input.region} ${sku} ${plan}`) - windowsCredit : 0;
    let compute = 0, sqlLicense = 0, coveredCores = 0;
    const ahbBackingCores = {standard: 0, enterprise: 0};
    const allocation = [];
    for (const edition of ["standard", "enterprise"]) {
      const count = units[edition];
      if (!count) continue;
      const ratio = key === "mi" && edition === "enterprise" ? 4 : 1;
      // This is conditional coverage, not entitlement evidence. Rights retained
      // on-premises are never pooled with the migrated share.
      const eligibleMovedCores = input.ahb ? moved[edition] * ratio : 0;
      const coveredUnits = Math.min(count, Math.floor(eligibleMovedCores / input.unitCores));
      coveredCores += coveredUnits * input.unitCores;
      // Source licence cores consumed by the benefit, back through the ratio.
      ahbBackingCores[edition] = coveredUnits * input.unitCores / ratio;
      if (key === "vm") {
        compute += vmRate * count * HOURS;
        sqlLicense += positiveRate(prices.vmLicensePerCoreHour[edition], `${edition} VM license`) *
          (count - coveredUnits) * input.unitCores * HOURS;
      } else {
        const baseRate = positiveRate(rate?.base, `MI GP ${plan} base`);
        const included = positiveRate(rate?.included, `MI GP ${plan} license-included`);
        if (included < baseRate) throw new Error("MI license-included rate is below its base rate.");
        compute += baseRate * count * input.unitCores * HOURS;
        sqlLicense += (included - baseRate) * (count - coveredUnits) * input.unitCores * HOURS;
      }
      allocation.push(`${edition}: ${count} × ${input.unitCores} ${key === "vm" ? "vCPU" : "vCore"}; ${coveredUnits} assumed SQL AHB deployment(s)${key === "vm" && input.ahb ? "; Windows Server AHB assumed" : ""}`);
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
      const limit = input.unitCores === 4 ? 2048 : 8192;
      if (perUnit > limit) return unavailable(key, name, `MI storage needs ${perUnit} GB per instance, above this model's ${limit} GB limit. Increase deployment size or review placement.`);
      storage = perUnit * deployments * positiveRate(region.storage.mi_gp_per_gb_mo, "MI GP storage");
      storageDetail = `${deployments} × ${perUnit} GB reserved storage (32 GB increments)`;
    }
    return total({...base, key, name, plan, infrastructure, compute, sqlLicense, storage, storageDetail,
      sa: saMonthly(retained) + saMonthly(ahbBackingCores),
      allocation, coveredCores, azureCores: deployments * input.unitCores, deployments, retainedCores: sum(retained)});
  });
  const serverlessName = "Azure SQL Database serverless";
  const serverlessBase = {...base, key: "serverless", name: serverlessName, infrastructure, retainedCores: sum(retained), plan: "payg"};
  let serverless;
  if (!sum(moved)) {
    serverless = total(serverlessBase);
  } else if (!input.serverlessEnabled || input.databaseCount === null || input.databaseCount === "") {
    serverless = unavailable("serverless", serverlessName, "Input needed: enable the optional estimate and enter the database count for the selected migrating footprint. Core totals cannot determine database count.", "input-needed");
  } else {
    const dbs = input.databaseCount;
    const min = input.serverlessMin, max = input.serverlessMax, billable = input.serverlessBillable;
    if (!Number.isInteger(dbs) || dbs < 1 || dbs > 100000) throw new Error("Serverless database count must be a whole number from 1 to 100,000.");
    if (![2, 4, 8].includes(max)) throw new Error("Serverless maximum must be 2, 4 or 8 vCores in this conservative model.");
    const floor = max === 8 ? 1 : 0.5;
    if (!Number.isFinite(min) || min < floor || min > max || min * 2 !== Math.round(min * 2)) throw new Error(`Serverless minimum must be ${floor}–${max} vCores, in 0.5 increments.`);
    // Gen5's minimum memory at 0.5 configured vCores increases billing above
    // 0.5: 2.05 GB at max 2 and 2.1 GB at max 4, normalized at 3 GB/vCore.
    const billingFloor = min === 0.5 ? (max === 2 ? 2.05 / 3 : 0.7) : min;
    if (!Number.isFinite(billable) || billable < billingFloor || billable > max) throw new Error(`Assumed active billable vCores must be between ${billingFloor.toFixed(3)} and ${max}, including the memory-normalized minimum.`);
    if (!Number.isFinite(input.activePct) || input.activePct < 0 || input.activePct > 100) throw new Error("Serverless active-use percentage must be 0–100.");
    if (input.storageGB <= 0) {
      serverless = unavailable("serverless", serverlessName, "Input needed: enter total migrated data storage in the assumptions. Serverless storage is billed even while paused.", "input-needed");
    } else if (Math.ceil(input.storageGB / dbs) > 1024) {
      serverless = unavailable("serverless", serverlessName, "Storage exceeds this conservative model's 1,024 GB per-database limit. Review database placement; do not change the real database count just to fit.");
    } else {
      const perDB = Math.max(1, Math.ceil(input.storageGB / dbs));
      const compute = dbs * billable * HOURS * input.activePct / 100 *
        positiveRate(region.serverless?.paygPerCoreHour, "SQL Database GP Gen5 serverless PAYG");
      const storage = dbs * perDB * positiveRate(region.storage.db_gp_per_gb_mo, "SQL Database GP storage");
      serverless = total({...serverlessBase, compute, storage, deployments: dbs, azureCores: dbs * max,
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
  return {input, source, moved, retained, required, baseline, scenarios};
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
    for (const name of Object.keys(CALCULATOR_PRICES.regions)) region.add(new Option(name, name));
    region.value = "eastus";
    const date = v => new Date(v).toLocaleDateString("en-US", {year:"numeric", month:"short", day:"numeric", timeZone:"UTC"});
    document.getElementById("priceDate").textContent = `VM / MI / serverless / SQL license rates: ${date(CALCULATOR_PRICES.captured)}. Storage snapshot: ${date(CALCULATOR_PRICES.infrastructureSnapshot)}. USD public rates, embedded; no runtime requests.`;
    document.getElementById("btnTheme").onclick = () => {
      const root = document.documentElement;
      root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    };
    const sync = () => {
      for (const id of ["migrationPct", "rightSizePct"]) document.getElementById(`${id}Value`).textContent = `${form.elements[id].value}%`;
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
      document.getElementById("serverlessFields").disabled = !form.elements.serverlessEnabled.checked;
      results.hidden = true;
      error.textContent = "";
    };
    form.addEventListener("input", sync);
    form.addEventListener("change", sync);
    sync();
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
      for (const key of ["ahb","serverlessEnabled"]) input[key] = form.elements[key].checked;
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
      const delta = s => `${money(Math.abs(s.deltaThreeYear))} ${s.deltaThreeYear < 0 ? "lower" : s.deltaThreeYear > 0 ? "higher" : "difference"} over 3 years
        (${s.deltaPct === null ? "percentage unavailable: zero baseline" : `${Math.abs(s.deltaPct).toFixed(1)}%`});
        ${money(Math.abs(s.deltaMonthly))}/month ${s.deltaMonthly < 0 ? "lower" : s.deltaMonthly > 0 ? "higher" : "difference"} recurring cost vs on-premises (excludes initial purchase).`;
      results.innerHTML = `
        <div class="card">
          <h2>Four alternatives for the same original footprint</h2>
          <p>${sum(source).toLocaleString()} source cores: ${source.standard} Standard + ${source.enterprise} Enterprise.
          Move ${moved.standard} Standard + ${moved.enterprise} Enterprise; keep ${retained.standard} Standard + ${retained.enterprise} Enterprise on-premises in every Azure alternative.</p>
          <p class="calc-muted">${escape(input.region)} · 730 hours/month · ${input.rightSizePct}% assumed VM / MI right-sizing · illustrative ${input.unitCores}-core reference deployments.
          </p>
          <p><b>${input.licenseBasis === "refresh" ? "License-refresh scenario: one-time SQL license purchase modeled over 3 years, not annual renewal." : "Existing-license scenario: sunk purchases excluded; no refresh purchase."}</b>
          ${input.licenseBasis === "refresh" ? "On-premises buys for the full footprint; Azure alternatives buy only for retained cores. AHB assumes separate eligible existing migrated rights, not free new licenses." : ""}
          Three-year total = one-time purchase + 36 × recurring monthly cost.</p>
          <p class="calc-muted">All figures are published list prices. Negotiated or agreement-specific discounts are not applied and will change these totals.</p>
          <div class="note warn">Only ${input.avoidablePct}% of baseline on-premises operations is assumed avoidable, proportional to actual migrated cores; the fixed share remains even at 100% migration.
          ${input.onPremPerCoreMonth === 0 ? "On-premises operations are omitted: not a full TCO or savings claim." : ""}
          ${input.storageGB === 0 ? "Migrated storage is unspecified: VM data disks omitted; MI uses 32 GB per instance; serverless needs a storage input." : ""}
          Software Assurance is charged at published list on cores retained on-premises and on the cores whose rights back AHB, because AHB requires active eligible SA or a qualifying subscription. Actual SA pricing is agreement-specific.
          These partial-cost comparisons are not full TCO or guaranteed savings.
          ${sum(moved) === 0 && input.migrationPct > 0 ? "This percentage rounds down to zero migrated cores." : ""}
          Core counts and this estimate do not prove license entitlements or feature readiness.</div>
          <div class="calc-results">${all.map(s => `
            <article class="calc-option"><h3>${s.name}</h3>
            ${s.status !== "ready" ? `<p><b>${s.status === "input-needed" ? "Input needed" : "Unavailable"}</b></p><p>${escape(s.reason)}</p><p class="calc-muted">No total or savings reported; not $0. The retained footprint and ongoing costs still apply.</p>` : `
              <div class="calc-price">${money(s.monthly)}<span>/ month recurring${s.plan && s.plan !== "payg" ? ", amortized commitment" : ""}; excludes initial purchase</span></div>
              <p><b>${money(s.upfront)}</b> one-time SQL license purchase<br><b>${money(s.threeYear)}</b> over three years, including purchase</p>
              <p class="calc-muted">${s.key === "stay" ? `${s.retainedCores} cores on-premises` : `${s.retainedCores} source cores retained + ${s.deployments} Azure ${s.key === "serverless" ? "database(s)" : "reference deployment(s)"}`}</p>
              ${s.key === "stay" ? "" : `<p class="calc-muted">${s.key === "serverless" ? "Illustrative PAYG; no AHB or reservation. SQL license included in compute." : `${escape(PLANS[s.plan])}; ${input.ahb ? `${s.coveredCores} of ${s.azureCores} Azure cores conditionally covered by AHB` : "no AHB, SQL license included"}.`}</p><p class="calc-delta">${delta(s)}</p>`}
            `}</article>`).join("")}</div>
          <details class="acc"><summary>Monthly cost breakdown, rates and scope</summary>
            <div class="tbl-wrap"><table class="calc-table"><thead><tr><th>Monthly component</th>${all.map(s => `<th>${s.name}</th>`).join("")}</tr></thead>
            <tbody>${rows.map(([label,key]) => `<tr><th scope="row">${label}</th>${all.map(s => `<td>${s.status === "ready" ? money(s[key]) : "Not calculated"}</td>`).join("")}</tr>`).join("")}
            <tr><th scope="row">One-time SQL license purchase (not monthly)</th>${all.map(s => `<td>${s.status === "ready" ? money(s.upfront) : "Not calculated"}</td>`).join("")}</tr></tbody></table></div>
            <p>Refresh purchase = ceil(Standard cores / 2) × $3,945 + ceil(Enterprise cores / 2) × $15,123.
            These are published SQL Server 2022 two-core pack list prices, not annual SA rates or a current-contract quote.
            Refresh is a hypothetical planned replacement purchase, not a recharge of historical licenses. Existing-license mode excludes it.
            On-premises uses all source cores; each Azure alternative uses retained cores only. With AHB, migrated existing eligible rights must be independently available; no new rights or SA are assumed free.</p>
            ${scenarios.filter(s => s.status === "ready").map(s => `<p><b>${s.name}</b>: ${escape(s.allocation.join("; ") || "No migration")}. ${escape(s.storageDetail)}.</p>`).join("")}
            <p>Standard and Enterprise workloads are sized separately: floor migrated cores, ceil right-sized demand, then round to whole reference deployments.
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
      results.hidden = false;
      results.focus();
    });
  });
}
