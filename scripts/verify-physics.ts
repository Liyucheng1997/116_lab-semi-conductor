/**
 * Physics regression checks: process results, 2-D solver convergence and compact-model sanity.
 * Run with `npm run verify`. Every number printed is also asserted against a plausible range.
 */
import { devices, deviceOrder, finalState } from "../src/devices/registry";
import { createCompactModel } from "../src/physics/compact";
import { PoissonSolver } from "../src/physics/poisson2d";
import { buildStructure } from "../src/physics/structure";

let failures = 0;
function check(label: string, value: number, lo: number, hi: number, unit = "") {
  const ok = value >= lo && value <= hi;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${label.padEnd(30)} ${value.toPrecision(4)} ${unit}  [${lo} … ${hi}]`);
}

for (const key of deviceOrder) {
  const def = devices[key];
  console.log(`\n${def.name}`);
  const state = finalState(def);
  state.history.forEach((h) => console.log(`    ${def.recipe[h.step].title}: ${h.results.map(([a, b]) => `${a} ${b}`).join("; ")}`));
  const model = createCompactModel(def, state);
  const st = buildStructure(def, state);
  const solver = new PoissonSolver(st);
  const bias = Object.fromEntries(def.bias.map((b) => [b.key, b.value]));
  const op = model.evaluate(bias);
  const t0 = performance.now();
  const sol = solver.solve(op.terminals, { channelPhi: op.channelPhi });
  check("2-D Poisson converged (max Δψ)", sol.converged ? 0 : 1, 0, 0);
  check("solve time", performance.now() - t0, 0, 3000, "ms");
  const v = op.values;
  if (def.family === "diode") {
    check("V_bi (graded, self-consistent)", v.vbi, 0.7, 1.0, "V");
    check("I_A @ default bias", v.I, 1e-10, 1e-5, "A");
    const rev = model.evaluate({ VA: -5 });
    check("reverse leakage @ -5 V", -rev.values.I, 1e-16, 1e-10, "A");
  } else if (def.family === "bjt") {
    check("β", v.beta, def.polarity === 1 ? 50 : 10, 300);
    check("neutral base width", v.wb * 1000, 30, 250, "nm");
    check("f_T", v.ft / 1e9, 1, 60, "GHz");
    const sat = model.evaluate({ [def.bias[0].key]: 0.8, [def.bias[1].key]: 0.1 });
    check("V_BC′ in saturation", sat.values.vbc, 0.4, 0.9, "V");
  } else {
    check("|V_T|", Math.abs(v.vt), 0.3, 0.8, "V");
    check("I_D @ default bias", v.id * 1e6, 50, 2000, "μA");
    check("g_m/g_ds", v.gm / v.gds, 3, 100);
    const off = model.evaluate({ [def.bias[0].key]: 0, [def.bias[1].key]: 3.3, [def.bias[2].key]: 0 });
    check("I_off @ V_G = 0", off.values.id, 1e-15, 1e-8, "A");
  }
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
