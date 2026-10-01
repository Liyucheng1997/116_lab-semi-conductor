import { devices, finalState } from "../src/devices/registry";
import { buildStructure } from "../src/physics/structure";
import { PoissonSolver } from "../src/physics/poisson2d";

function probe(st: any, res: any, x: number, ys: number[]) {
  let i = 0; while (i < st.nx - 1 && st.xs[i + 1] <= x) i++;
  return ys.map((y) => { let j = 0; while (j < st.ny - 1 && st.ys[j + 1] <= y) j++; const k = j * st.nx + i;
    return `y=${y}: ψ=${res.psi[k].toFixed(3)} n=${res.n[k].toExponential(1)} p=${res.p[k].toExponential(1)} φn=${res.phin[k].toFixed(3)} φp=${res.phip[k].toFixed(3)}`; }).join("\n    ");
}
const cases: Array<[string, Record<string, number>[], number, number[]]> = [
  ["diode", [{ A: 0, K: 0 }, { A: -10, K: 0 }, { A: 0.6, K: 0 }], 4, [0.05, 0.5, 0.84, 1.0, 1.2, 2.0, 2.9, 3.5]],
  ["npn", [{ E: 0, B: 0, C: 0, S: 0 }, { E: 0, B: 0.75, C: 3, S: 0 }], 3.7, [0.05, 0.14, 0.2, 0.25, 0.32, 0.5, 1.0, 2.0, 3.2]],
  ["pnp", [{ E: 0, B: -0.75, C: -3, S: 0 }], 3.7, [0.05, 0.14, 0.2, 0.25, 0.32, 0.5, 1.0, 2.0]],
];
for (const [key, biases, x, ys] of cases) {
  const def = (devices as any)[key];
  const t0 = performance.now();
  const st = buildStructure(def, finalState(def));
  console.log(`\n=== ${key}: mesh ${st.nx}x${st.ny}=${st.nx*st.ny} built in ${(performance.now()-t0).toFixed(0)} ms; comps`, st.compType.map((t: number, i: number) => `${i}:${t>0?"n":"p"}->${st.compTerminal[i]}`).join(" "));
  const solver = new PoissonSolver(st);
  for (const b of biases) {
    const r = solver.solve(b);
    console.log(` bias ${JSON.stringify(b)}: newton=${r.newton} cg=${r.cg} upd=${r.update.toExponential(1)} ${r.ms.toFixed(0)}ms conv=${r.converged}`);
    console.log("    " + probe(st, r, x, ys));
  }
}
