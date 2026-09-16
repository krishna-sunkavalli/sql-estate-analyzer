const test = require("node:test");
const assert = require("node:assert/strict");
const {calculateCoreOptions} = require("./calculator.js");
const livePrices = require("./calculator-prices.json");

const fixture = {
  sql2022Pack: {standard:3945, enterprise:15123},
  sqlSaPack: {standard:796.08, enterprise:3052.80},
  vmLicensePerCoreHour: {standard: 0.1, enterprise: 0.375},
  regions: {test: {
    miPlans: {payg: {base: 0.15, included: 0.25}, ri1: {base: 0.12, included: 0.22},
      ri3: {base: 0.08, included: 0.18}, sp1: {base: 0.12, included: 0.2}},
    vmPlans: Object.fromEntries([4,8,16].map(n => [`Standard_E${n}bds_v5`, {
      rates: {payg: n / 10, ri1: n * 0.08, ri3: n * 0.06, sp1: n * 0.09, sp3: n * 0.07},
      windowsLicensePerHour: n * 0.046,
    }])),
    serverless: {paygPerCoreHour: 0.5},
    storage: {mi_gp_per_gb_mo: 0.1, db_gp_per_gb_mo: 0.12, premium_ssd_lrs_per_disk_mo: {
      P4: 3, P6: 5, P10: 10, P15: 20, P20: 40, P30: 80,
      P40: 160, P50: 320, P60: 640, P70: 1280, P80: 2560,
    }},
  }},
};
// Existing cases pin the pre-default baseline explicitly so they keep asserting
// unbenefited pay-as-you-go behaviour; the shipped defaults are covered separately.
const defaults = {standard: 16, enterprise: 0, rightSizePct: 0,
  region: "test", unitCores: 16, licenseBasis: "existing", onPremPerCoreMonth: 0,
  ahb: false, vmPlan: "payg", miPlan: "payg"};
const serverless = {serverlessEnabled: true, databaseCount: 2, storageGB: 100,
  serverlessMin: 1, serverlessMax: 8, serverlessBillable: 2, activePct: 25};
const run = changes => calculateCoreOptions({...defaults, ...changes}, fixture);
const near = (a,b) => assert.ok(Math.abs(a-b) < 0.000001, `${a} != ${b}`);

test("four alternatives: PAYG VM/MI includes SQL/storage; unconfigured serverless is not zero", () => {
  const r = run();
  const [vm,mi,s] = r.scenarios;
  assert.equal(r.scenarios.length, 3);
  near(vm.monthly, 16 * 0.1 * 730 + 16 * 0.1 * 730 + 10);
  near(mi.monthly, 16 * 0.25 * 730 + 32 * 0.1);
  assert.equal(s.status, "input-needed");
  assert.equal(s.monthly, null);
  assert.equal(s.threeYear, null);
  assert.equal(s.deltaPct, null);
});
test("default refresh uses published two-core packs once, plus ongoing Software Assurance", () => {
  const r = calculateCoreOptions({standard: 50, enterprise: 20, region: "test",
    estateStandard: 100, estateEnterprise: 40}, fixture);
  // Scoped to the 70 cores being migrated, not the 140-core estate.
  near(r.baseline.infrastructure, 70 * 37.5);
  near(r.baseline.upfront,25*3945+10*15123);
  // SA is recurring on the in-scope cores if they stay put.
  near(r.baseline.sa, 50*796.08/24 + 20*3052.80/24);
  near(r.baseline.threeYear,r.baseline.upfront+36*(70*37.5+r.baseline.sa));
  assert.equal(r.input.rightSizePct,20);
  assert.equal(r.input.avoidablePct,50);
  assert.equal(r.input.discountPct,0);
  assert.equal(r.input.licenseBasis,"refresh");
  // Moving these cores avoids buying licenses for them entirely.
  for (const s of r.scenarios) near(s.upfront,0);
  // The remainder of the estate is reported as context, never in the comparison.
  assert.equal(r.retainedContext.cores,70);
  near(r.retainedContext.infrastructure,70*37.5);
  near(r.retainedContext.upfront,25*3945+10*15123);
  assert.equal(r.baseline.renewal,undefined);
});
test("the estate total is optional and purely contextual", () => {
  const withEstate = run({standard:33, enterprise:17, licenseBasis:"refresh",
    onPremPerCoreMonth:50, estateStandard:66, estateEnterprise:34});
  const without = run({standard:33, enterprise:17, licenseBasis:"refresh", onPremPerCoreMonth:50});
  // Supplying an estate cannot move a single number in the comparison.
  near(withEstate.baseline.threeYear, without.baseline.threeYear);
  for (let i = 0; i < without.scenarios.length; i++) {
    if (without.scenarios[i].status !== "ready") continue;
    near(withEstate.scenarios[i].threeYear, without.scenarios[i].threeYear);
  }
  // It only populates the out-of-scope context.
  assert.equal(withEstate.retainedContext.cores, 50);
  near(withEstate.retainedContext.infrastructure, 50*50);
  near(withEstate.retainedContext.upfront, Math.ceil(33/2)*3945+Math.ceil(17/2)*15123);
  assert.equal(without.retainedContext.cores, 0);
  near(without.retainedContext.threeYear, 0);
});
test("an estate smaller than the migrating footprint is rejected, not silently clamped", () => {
  assert.throws(() => run({standard:50, enterprise:0, estateStandard:40}), /cannot hold fewer standard cores/);
  assert.throws(() => run({standard:0, enterprise:8, estateEnterprise:4}), /cannot hold fewer enterprise cores/);
  // Equal is fine: the whole estate is moving.
  const all = run({standard:50, enterprise:0, estateStandard:50});
  assert.equal(all.retainedContext.cores, 0);
});
test("every column prices the same in-scope cores; the estate remainder sits outside", () => {
  const r=run({...serverless,standard:25,enterprise:10,estateStandard:100,estateEnterprise:40,
    onPremPerCoreMonth:10,licenseBasis:"refresh"});
  assert.deepEqual(r.moved,{standard:25,enterprise:10});
  assert.deepEqual(r.retained,{standard:75,enterprise:30});
  assert.equal(r.baseline.scopedCores,35);
  near(r.baseline.infrastructure,35*10);
  for(const s of r.scenarios) {
    assert.equal(s.scopedCores,35);
    // Azure keeps only the unavoidable share of the in-scope operations cost.
    near(s.infrastructure,35*10*0.5);
    near(s.upfront,0);
  }
  assert.equal(r.retainedContext.cores,105);
  near(r.retainedContext.infrastructure,105*10);
  near(r.retainedContext.upfront,Math.ceil(75/2)*3945+15*15123);
});
test("0/50/100 percent avoidable costs at full migration preserve the fixed share", () => {
  for(const avoidablePct of [0,50,100]) {
    const r=run({...serverless,avoidablePct,onPremPerCoreMonth:37.5});
    for(const s of r.scenarios) near(s.infrastructure,16*37.5*(1-avoidablePct/100));
  }
});
test("existing-license mode excludes sunk purchases; AHB assumes existing eligible rights", () => {
  const r=run({...serverless,ahb:true});
  for(const s of [r.baseline,...r.scenarios]) near(s.upfront,0);
  assert.equal(r.scenarios[0].sqlLicense,0);
  assert.equal(r.scenarios[1].sqlLicense,0);
});
test("refresh buys only for in-scope cores that stay; moving them avoids the purchase", () => {
  for(const estateMultiple of [1,2,3]) for(const ahb of [false,true]) {
    const r=run({...serverless,standard:33,enterprise:17,ahb,licenseBasis:"refresh",
      estateStandard:33*estateMultiple,estateEnterprise:17*estateMultiple});
    // The baseline buys packs for the migrated slice only.
    near(r.baseline.upfront,Math.ceil(r.moved.standard/2)*3945+Math.ceil(r.moved.enterprise/2)*15123);
    // The retained remainder's purchase sits in context, outside the comparison.
    near(r.retainedContext.upfront,Math.ceil(r.retained.standard/2)*3945+Math.ceil(r.retained.enterprise/2)*15123);
    for(const s of r.scenarios) {
      near(s.upfront,0);
      near(s.threeYear,s.monthly*36);
      near(s.deltaThreeYear,s.threeYear-r.baseline.threeYear);
      if (r.baseline.threeYear > 0) near(s.deltaPct,s.deltaThreeYear/r.baseline.threeYear*100);
    }
  }
});
test("single additional discount applies to purchases and selected Azure charges, never operations", () => {
  for(const licenseBasis of ["refresh","existing"]) for(const vmPlan of ["payg","ri1","sp3"]) for(const miPlan of ["payg","ri3","sp1"]) {
    const input={...serverless,standard:100,enterprise:40,onPremPerCoreMonth:37.5,licenseBasis,vmPlan,miPlan};
    const undiscounted=run(input);
    for(const discountPct of [0,10,100]) {
      const r=run({...input,discountPct});
      for(const [index,s] of [r.baseline,...r.scenarios].entries()) {
        const original=[undiscounted.baseline,...undiscounted.scenarios][index], factor=1-discountPct/100;
        near(s.infrastructure,original.infrastructure);
        for(const component of ["upfront","compute","sqlLicense","storage"]) near(s[component],original[component]*factor);
        near(s.threeYear,s.upfront+36*s.monthly);
      }
    }
  }
});
test("missing published license prices fail refresh but do not recharge existing licenses", () => {
  const broken=structuredClone(fixture); delete broken.sql2022Pack.standard;
  assert.throws(()=>calculateCoreOptions({...defaults,licenseBasis:"refresh"},broken),/two-core pack/);
  assert.equal(calculateCoreOptions(defaults,broken).baseline.upfront,0);
});
test("AHB never reuses retained rights or partially covers a deployment", () => {
  // Entitlement exactly matches the fitted deployment, so it is fully covered.
  const exact=run({standard:8,estateStandard:16,ahb:true});
  assert.deepEqual(exact.scenarios[0].sizes,[8]);
  for(const s of exact.scenarios.slice(0,2)) assert.equal(s.coveredCores,8);
  // Estate rights are never pooled: 8 of 16 cores move, so only 8 are eligible
  // even though the estate holds 16.
  near(exact.scenarios[0].sa, 8*796.08/24);
  // 10 source cores fit as 8 + 4 = 12 vCores. On VM the 1:1 entitlement covers
  // the 8, but the leftover 2 cannot part-cover the 4, so it pays the meter.
  const partial=run({standard:0,enterprise:10,ahb:true});
  assert.deepEqual(partial.scenarios[0].sizes,[8,4]);
  assert.equal(partial.scenarios[0].coveredCores,8);
  assert.ok(partial.scenarios[0].sqlLicense>0);
  // MI stretches Enterprise 4:1, so 10 source cores entitle 40 vCores and both
  // deployments are covered outright.
  assert.equal(partial.scenarios[1].coveredCores,12);
  near(partial.scenarios[1].sqlLicense,0);
});
test("right-sizing is not an entitlement ratio and serverless is sized independently", () => {
  const r=run({...serverless,standard:0,enterprise:20,rightSizePct:20,ahb:true});
  assert.equal(r.required.enterprise,16);
  for(const s of r.scenarios.slice(0,2)) assert.equal(s.azureCores,16);
  const without=run({...serverless,standard:0,enterprise:20,rightSizePct:0});
  near(r.scenarios[2].monthly,without.scenarios[2].monthly);
});
test("AHB charges SA on the backing cores, stays net cheaper, and never applies to serverless", () => {
  const without=run(serverless), withAHB=run({...serverless,ahb:true});
  for(let i=0;i<2;i++) {
    assert.equal(withAHB.scenarios[i].coveredCores,16);
    assert.equal(withAHB.scenarios[i].renewal,undefined);
    assert.equal(withAHB.scenarios[i].sqlLicense,0);
    // The benefit is not free: SA is charged on the 16 source cores backing it.
    near(withAHB.scenarios[i].sa,16*796.08/24);
    near(without.scenarios[i].sa,0);
    // It still has to beat paying the Azure SQL licence meter outright.
    assert.ok(withAHB.scenarios[i].monthly<without.scenarios[i].monthly);
  }
  near(withAHB.baseline.threeYear,without.baseline.threeYear);
  near(withAHB.scenarios[2].threeYear,without.scenarios[2].threeYear);
  near(withAHB.scenarios[2].sa,0);
});
test("a single core still produces a valid minimum deployment", () => {
  const r=run({standard:1,enterprise:1});
  assert.deepEqual(r.moved,{standard:1,enterprise:1});
  assert.deepEqual(r.retained,{standard:0,enterprise:0});
  // Each edition is sized separately, so each gets the smallest valid size.
  for(const s of r.scenarios.slice(0,2)) {
    assert.deepEqual(s.sizes,[4,4]);
    assert.equal(s.azureCores,8);
  }
});
test("invalid core, estate, discount, purchase basis, scope and plan inputs fail explicitly", () => {
  for(const bad of [{standard:0,enterprise:0},{standard:-1},{standard:1.5},{rightSizePct:61},
    {region:"missing"},{unitCores:6},{ahb:"yes"},{vmPlan:"ri1+sp1"},{storageGB:NaN},
    {estateStandard:1.5},{estateStandard:-1},{estateStandard:8},
    {avoidablePct:-1},{discountPct:NaN},{discountPct:-1},{discountPct:101},{licenseBasis:"annual"}]) assert.throws(()=>run(bad));
});
test("missing PAYG and storage rates fail rather than creating free resources", () => {
  for(const mutate of [
    p=>delete p.regions.test.vmPlans.Standard_E16bds_v5,
    p=>delete p.regions.test.miPlans.payg,
    p=>delete p.regions.test.serverless.paygPerCoreHour,
    p=>delete p.regions.test.storage.db_gp_per_gb_mo,
  ]) {
    const broken=structuredClone(fixture); mutate(broken);
    assert.throws(()=>calculateCoreOptions({...defaults,...serverless},broken),/Missing or invalid published rate/);
  }
});
test("unsupported commitments are unavailable, not a PAYG or zero fallback", () => {
  const r=run({miPlan:"sp3"});
  assert.equal(r.scenarios[1].status,"unavailable");
  assert.match(r.scenarios[1].reason,/no verified/);
  assert.equal(r.scenarios[1].monthly,null);
  assert.equal(r.scenarios[0].status,"ready");
});
test("reservations and savings plans discount VM infrastructure only; SQL/storage unchanged", () => {
  const payg=run({storageGB:1000});
  for(const plan of ["ri1","ri3","sp1","sp3"]) {
    const s=run({storageGB:1000,vmPlan:plan}).scenarios[0];
    assert.ok(s.compute<payg.scenarios[0].compute);
    near(s.sqlLicense,payg.scenarios[0].sqlLicense);
    near(s.storage,payg.scenarios[0].storage);
    near(s.threeYear,s.monthly*36);
  }
});
test("MI uses correct plan-specific included/base rates with independent AHB", () => {
  for(const [miPlan, rates] of Object.entries(fixture.regions.test.miPlans)) {
    for(const ahb of [false,true]) {
      const s=run({miPlan,ahb}).scenarios[1];
      near(s.compute,16*730*rates.base);
      near(s.sqlLicense,ahb?0:16*730*(rates.included-rates.base));
    }
  }
});
test("oversized MI storage only blocks MI; data storage costs are separate", () => {
  const low=run(), high=run({storageGB:1000});
  for(let i=0;i<2;i++) assert.ok(high.scenarios[i].storage>low.scenarios[i].storage);
  const huge=run({standard:4,unitCores:4,storageGB:3000});
  assert.equal(huge.scenarios[1].status,"unavailable");
  assert.match(huge.scenarios[1].reason,/MI storage/);
});
test("serverless requires explicit count and storage, never interpreting unset as zero", () => {
  for(const changes of [{serverlessEnabled:true},{...serverless,databaseCount:null},{...serverless,storageGB:0}]) {
    const s=run(changes).scenarios[2];
    assert.equal(s.status,"input-needed");
    assert.equal(s.monthly,null);
  }
  assert.throws(()=>run({...serverless,databaseCount:0}),/database count/);
  assert.throws(()=>run({...serverless,databaseCount:1.5}),/database count/);
});
test("serverless 0/25/100 online percent bills online compute and all-month storage", () => {
  for(const activePct of [0,25,100]) {
    const s=run({...serverless,activePct,onPremPerCoreMonth:10}).scenarios[2];
    near(s.compute,2*2*730*activePct/100*0.5);
    near(s.storage,100*0.12);
    near(s.infrastructure,80);
    near(s.monthly,s.compute+s.storage+80);
  }
});
test("serverless configured ranges and memory-normalized billing floor validated", () => {
  for(const changes of [{serverlessMax:6},{serverlessMin:0.5},{serverlessMin:9},{serverlessBillable:0.9},
    {serverlessBillable:9},{serverlessMin:1.25},{activePct:101},{activePct:NaN}]) assert.throws(()=>run({...serverless,...changes}));
  assert.throws(()=>run({...serverless,serverlessMax:4,serverlessMin:0.5,serverlessBillable:0.5}),/memory-normalized/);
  assert.equal(run({...serverless,serverlessMax:4,serverlessMin:0.5,serverlessBillable:0.7}).scenarios[2].status,"ready");
  assert.throws(()=>run({...serverless,serverlessMax:2,serverlessMin:0.5,serverlessBillable:0.68}),/memory-normalized/);
  assert.equal(run({...serverless,serverlessMax:2,serverlessMin:0.5,serverlessBillable:0.69}).scenarios[2].status,"ready");
});
test("serverless storage enforces conservative 1–1024 GB per DB and rounds up", () => {
  const s=run({...serverless,storageGB:1}).scenarios[2];
  near(s.storage,2*0.12);
  assert.equal(run({...serverless,storageGB:2048}).scenarios[2].status,"ready");
  const invalid=run({...serverless,storageGB:2049}).scenarios[2];
  assert.equal(invalid.status,"unavailable");
  assert.equal(invalid.monthly,null);
});
test("monthly, 3-year deltas and percentages reconcile with positive and zero baselines", () => {
  for(const onPremPerCoreMonth of [0,37.5,1000]) {
    const r=run({...serverless,onPremPerCoreMonth});
    for(const s of r.scenarios) {
      near(s.threeYear,s.monthly*36);
      near(s.deltaMonthly,s.monthly-r.baseline.monthly);
      near(s.deltaThreeYear,s.threeYear-r.baseline.threeYear);
      if(r.baseline.threeYear) near(s.deltaPct,s.deltaThreeYear/r.baseline.threeYear*100);
      else assert.equal(s.deltaPct,null);
    }
  }
});
test("live MI table class mapping regression: GP East US Gen5 per-core rates", () => {
  const p=livePrices.regions.eastus.miPlans;
  near(p.payg.included,1.008736/4); near(p.payg.base,0.608872/4);
  near(p.sp1.included,0.80696/4); near(p.sp1.base,0.48708/4);
  near(p.ri1.included,0.795744/4);
  near(p.ri1.base,(0.795744-(1.008736-0.608872))/4);
  near(p.ri3.included,0.673824/4); near(p.ri3.base,0.27396/4);
  assert.equal(p.sp3,undefined);
});
test("live VM discounts retain Windows uplift and public SQL PAYG licensing", () => {
  const p=livePrices.regions.eastus.vmPlans.Standard_E4bds_v5;
  near(p.rates.payg,0.518);
  near(p.windowsLicensePerHour,0.518-0.334);
  near(p.rates.ri1,1726/8760+p.windowsLicensePerHour);
  near(p.rates.ri3,3335/26280+p.windowsLicensePerHour);
  near(p.rates.sp1,0.2258508+p.windowsLicensePerHour);
  near(p.rates.sp3,0.1414156+p.windowsLicensePerHour);
  near(livePrices.vmLicensePerCoreHour.standard,0.1);
  near(livePrices.vmLicensePerCoreHour.enterprise,0.375);
  near(livePrices.regions.eastus.serverless.paygPerCoreHour,0.521758);
});
test("all 18 live regions, 3 deployment sizes, AHB on/off and every captured commitment", () => {
  assert.equal(Object.keys(livePrices.regions).length,18);
  for(const [region, rates] of Object.entries(livePrices.regions)) {
    for(const unitCores of [4,8,16]) for(const ahb of [false,true]) {
      for(const id of rates.vmPlans[`Standard_E${unitCores}bds_v5`].meterIds) {
        assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      }
      const vmPlans=Object.keys(rates.vmPlans[`Standard_E${unitCores}bds_v5`].rates);
      for(const vmPlan of vmPlans) for(const miPlan of Object.keys(rates.miPlans)) {
        const r=calculateCoreOptions({...defaults,...serverless,region,unitCores,ahb,vmPlan,miPlan,
          standard:100,enterprise:200,rightSizePct:20,licenseBasis:"refresh"},livePrices);
        for(const s of [r.baseline,...r.scenarios]) {
          assert.equal(s.status,"ready",`${region} ${s.key}`);
          assert.ok(Number.isFinite(s.threeYear)&&s.threeYear>0);
          near(s.threeYear,s.upfront+36*s.monthly);
        }
      }
    }
  }
});

test("shipped defaults are 3-year reservations with SQL and Windows Azure Hybrid Benefit", () => {
  const r = calculateCoreOptions({standard: 16, enterprise: 0, rightSizePct: 0,
    region: "test", unitCores: 16, licenseBasis: "existing", onPremPerCoreMonth: 0}, fixture);
  const [vm, mi] = r.scenarios;
  assert.equal(vm.plan, "ri3");
  assert.equal(mi.plan, "ri3");
  // SQL AHB on by default removes the Azure SQL licence charge on both.
  near(vm.sqlLicense, 0);
  near(mi.sqlLicense, 0);
  // Windows AHB on by default deducts the uplift from the selected ri3 rate.
  near(vm.compute, (16 * 0.06 - 16 * 0.046) * 1 * 730);
});

test("the single AHB toggle covers Windows on VM and deducts an undiscounted uplift from every term", () => {
  const input = {standard: 16, enterprise: 0, rightSizePct: 0,
    region: "test", unitCores: 16, licenseBasis: "existing", onPremPerCoreMonth: 0};
  const uplift = 16 * 0.046 * 730;
  for (const [plan, rate] of [["payg", 1.6], ["ri1", 1.28], ["ri3", 0.96], ["sp1", 1.44], ["sp3", 1.12]]) {
    const off = calculateCoreOptions({...input, ahb: false, vmPlan: plan, miPlan: "payg"}, fixture);
    const on = calculateCoreOptions({...input, ahb: true, vmPlan: plan, miPlan: "payg"}, fixture);
    near(off.scenarios[0].compute, rate * 730);
    near(on.scenarios[0].compute, rate * 730 - uplift);
    // The uplift is never discounted by the commitment; it is identical every term.
    near(off.scenarios[0].compute - on.scenarios[0].compute, uplift);
    // Windows licensing is not part of Managed Instance or serverless compute.
    near(on.scenarios[1].compute, off.scenarios[1].compute);
    // The same toggle still clears the SQL licence line on both Azure options.
    near(on.scenarios[0].sqlLicense, 0);
    near(on.scenarios[1].sqlLicense, 0);
    assert.ok(off.scenarios[0].sqlLicense > 0 && off.scenarios[1].sqlLicense > 0);
  }
});

test("AHB fails loudly when no Windows uplift is published rather than crediting zero", () => {
  const bare = structuredClone(fixture);
  delete bare.regions.test.vmPlans.Standard_E16bds_v5.windowsLicensePerHour;
  assert.throws(() => calculateCoreOptions({standard: 16, enterprise: 0,
    rightSizePct: 0, region: "test", unitCores: 16, licenseBasis: "existing",
    onPremPerCoreMonth: 0, ahb: true}, bare), /Windows Server licence uplift/);
});

test("the smallest possible migration still produces a valid, positive comparison", () => {
  // Validation guarantees at least one core, so there is always at least one
  // deployment; a zero-capacity Azure column can no longer be produced.
  const r = run({standard: 1, enterprise: 0, ahb: true, onPremPerCoreMonth: 37.5});
  for (const s of r.scenarios.slice(0, 2)) {
    assert.equal(s.status, "ready");
    assert.deepEqual(s.sizes, [4]);
    assert.ok(s.compute > 0);
    assert.ok(s.threeYear > 0);
  }
});

test("Software Assurance is edition-sensitive and recurring even in existing-license mode", () => {
  const std = run({standard: 100, enterprise: 0, licenseBasis: "existing"});
  const ent = run({standard: 0, enterprise: 100, licenseBasis: "existing"});
  // The old defect: identical on-premises cost regardless of edition.
  assert.ok(ent.baseline.threeYear > std.baseline.threeYear);
  near(std.baseline.sa, 100 * 796.08 / 24);
  near(ent.baseline.sa, 100 * 3052.80 / 24);
  // Sunk purchases are still excluded; SA is what remains.
  near(std.baseline.upfront, 0);
  near(std.baseline.threeYear, 36 * std.baseline.sa);
});

test("migrating without AHB drops SA entirely for the in-scope cores", () => {
  const r = run({standard: 40, enterprise: 0, estateStandard: 100, rightSizePct: 0,
    licenseBasis: "existing", ahb: false, vmPlan: "payg", miPlan: "payg"});
  // Staying put keeps SA on all 40 in-scope cores.
  near(r.baseline.sa, 40 * 796.08 / 24);
  // Moving them without AHB means no SA obligation at all; the Azure SQL meter
  // is paid instead, never both.
  for (const s of r.scenarios) {
    near(s.sa, 0);
    if (s.key !== "serverless") assert.ok(s.sqlLicense > 0);
  }
  // The 60 untouched cores still pay SA, reported outside the comparison.
  near(r.retainedContext.sa, 60 * 796.08 / 24);
});

test("MI Enterprise AHB bills SA on source cores, not the four-to-one vCore expansion", () => {
  const r = run({standard: 0, enterprise: 64, rightSizePct: 0,
    unitCores: 16, licenseBasis: "existing", ahb: true, vmPlan: "payg", miPlan: "payg"});
  const [vm, mi] = r.scenarios;
  // VM is one-to-one: 64 vCPU covered needs 64 source cores of SA.
  near(vm.sa, 64 * 3052.80 / 24);
  // MI Enterprise stretches 1 core to 4 vCores, so the same 64 vCores need 16.
  near(mi.sa, 16 * 3052.80 / 24);
  assert.equal(mi.coveredCores, 64);
});

test("the discount applies to Software Assurance but on-premises operations stay at list", () => {
  const full = run({standard: 40, enterprise: 0, discountPct: 0, onPremPerCoreMonth: 10});
  const cut = run({standard: 40, enterprise: 0, discountPct: 25, onPremPerCoreMonth: 10});
  near(cut.baseline.sa, full.baseline.sa * 0.75);
  near(cut.baseline.infrastructure, full.baseline.infrastructure);
});

test("a missing published SA price fails rather than treating Software Assurance as free", () => {
  const bare = structuredClone(fixture);
  delete bare.sqlSaPack.standard;
  assert.throws(() => calculateCoreOptions({standard: 16, enterprise: 0,
    region: "test", licenseBasis: "existing"}, bare), /Software Assurance/);
});

test("all four columns price the same in-scope workload, and Azure right-sizes below it", () => {
  const r = run({...serverless, standard: 50, enterprise: 0, estateStandard: 100,
    rightSizePct: 20, unitCores: 16, onPremPerCoreMonth: 37.5, licenseBasis: "refresh"});
  // Same scope in every column: the 50 cores selected for migration.
  for (const s of [r.baseline, ...r.scenarios]) assert.equal(s.scopedCores, 50);
  // Right-sizing means Azure provisions less capacity than the source footprint.
  assert.equal(r.required.standard, 40);
  assert.ok(r.required.standard < 50);
  // Only the on-premises column pays for all 50 cores of operations.
  near(r.baseline.infrastructure, 50 * 37.5);
  for (const s of r.scenarios) near(s.infrastructure, 50 * 37.5 * 0.5);
  // The untouched 50 cores are excluded from every column, reported separately.
  assert.equal(r.retainedContext.cores, 50);
  assert.ok(r.retainedContext.threeYear > 0);
  for (const s of [r.baseline, ...r.scenarios]) {
    assert.ok(s.threeYear < r.retainedContext.threeYear + s.threeYear);
  }
});

test("scaling the estate while holding migrated cores constant does not move the comparison", () => {
  // The estate remainder is a constant in every column, so growing it must not
  // change any scenario total or any delta.
  const small = run({standard: 30, enterprise: 0, estateStandard: 60, rightSizePct: 0,
    licenseBasis: "refresh", onPremPerCoreMonth: 20});
  const large = run({standard: 30, enterprise: 0, estateStandard: 300, rightSizePct: 0,
    licenseBasis: "refresh", onPremPerCoreMonth: 20});
  assert.equal(small.moved.standard, 30);
  assert.equal(large.moved.standard, 30);
  near(small.baseline.threeYear, large.baseline.threeYear);
  for (let i = 0; i < small.scenarios.length; i++) {
    const a = small.scenarios[i], b = large.scenarios[i];
    assert.equal(a.status, b.status);
    if (a.status !== "ready") continue;
    near(a.threeYear, b.threeYear);
    near(a.deltaPct, b.deltaPct);
  }
  // Only the out-of-scope context differs.
  assert.equal(small.retainedContext.cores, 30);
  assert.equal(large.retainedContext.cores, 270);
});

test("deployments fit the published size ladder instead of rounding to uniform blocks", () => {
  // 40 required used to become three 16-core blocks (48 vCores). It now fits
  // exactly, so Azure is not charged for capacity an architect would not buy.
  const r = run({standard: 50, enterprise: 0, rightSizePct: 20, unitCores: 16});
  assert.equal(r.required.standard, 40);
  assert.deepEqual(r.scenarios[0].sizes, [16, 16, 8]);
  assert.equal(r.scenarios[0].azureCores, 40);
  // Provisioned capacity never drops below the right-sized requirement.
  for (const s of r.scenarios.slice(0, 2)) assert.ok(s.azureCores >= r.required.standard);
});

test("fitted capacity is never wasteful and never short across many core counts", () => {
  for (let cores = 1; cores <= 200; cores++) {
    const r = run({standard: cores, enterprise: 0, rightSizePct: 0, unitCores: 16});
    for (const s of r.scenarios.slice(0, 2)) {
      // Always enough capacity for the requirement.
      assert.ok(s.azureCores >= cores, `${cores}: provisioned ${s.azureCores}`);
      // Never more than the smallest deployment size of slack, so rounding can
      // only ever cost part of one 4-core deployment.
      assert.ok(s.azureCores - cores < 4, `${cores}: slack ${s.azureCores - cores}`);
    }
  }
});

test("the maximum deployment size caps individual deployments without inflating total capacity", () => {
  for (const unitCores of [4, 8, 16]) {
    const r = run({standard: 64, enterprise: 0, rightSizePct: 0, unitCores});
    for (const s of r.scenarios.slice(0, 2)) {
      assert.ok(Math.max(...s.sizes) <= unitCores);
      // 64 is reachable exactly at every cap, so the cap changes deployment
      // count and unit price, never the provisioned total.
      assert.equal(s.azureCores, 64);
    }
  }
});
