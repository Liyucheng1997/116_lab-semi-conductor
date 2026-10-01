import { devices, finalState } from "../src/devices/registry";
import { buildStructure } from "../src/physics/structure";
import { PoissonSolver } from "../src/physics/poisson2d";
import { createCompactModel } from "../src/physics/compact";
for (const key of ["npn", "diode", "nmos"] as const) {
  const def = devices[key];
  const st = buildStructure(def, finalState(def));
  const model = createCompactModel(def, finalState(def));
  const solver = new PoissonSolver(st);
  const k = def.bias.map((b) => b.key);
  const seq = key === "npn" ? [[0.78, 3], [0.79, 3], [0.8, 3], [0.8, 2.5], [0.6, 2.5], [0.9, 0.2], [0.3, 5]] : key === "diode" ? [[0.7], [0.65], [0.5], [-2], [-10], [-30], [0.9]] : [[1.8, 1.5, 0], [1.9, 1.5, 0], [1.9, 1.0, 0], [0.3, 1, 0], [3.3, 3.3, -2]];
  let out = `${key} nodes=${st.nx * st.ny}:`;
  for (const v of seq) {
    const bias: Record<string, number> = {};
    v.forEach((x, i) => (bias[k[i]] = x));
    const op = model.evaluate(bias);
    const r = solver.solve(op.terminals, { channelPhi: op.channelPhi });
    out += ` [${v.join(",")}] N${r.newton}/CG${r.cg}/${r.ms.toFixed(0)}ms${r.converged ? "" : "!"}`;
  }
  console.log(out);
}
