import {calculateCoreOptions} from "./src/calculator.js";
const run = o => calculateCoreOptions({standard:100, enterprise:0, migrationPct:100,
  rightSizePct:20, unitCores:16, region:"eastus", ...o});
for (const n of [80, 50, 40, 25, 20, 10, 4]) {
  const r = run({instanceCount:n});
  const vm = r.scenarios[0], mi = r.scenarios[1];
  console.log(`inst=${String(n).padStart(3)} | VM ${String(vm.azureCores).padStart(4)} vCPU | MI ${String(mi.azureCores).padStart(4)} vCore  topology=${String(mi.topology).padEnd(6)} size=${mi.instanceSize ?? "-"} pools=${mi.deployments}  MI $/mo ${Math.round(mi.monthly).toLocaleString()}`);
}
console.log("\nallocation at 80:", run({instanceCount:80}).scenarios[1].allocation[0]);
console.log("allocation at 25:", run({instanceCount:25}).scenarios[1].allocation[0]);
