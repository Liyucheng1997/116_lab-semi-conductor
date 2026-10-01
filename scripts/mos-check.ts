import { devices, finalState } from "../src/devices/registry";
import { buildStructure } from "../src/physics/structure";
import { PoissonSolver } from "../src/physics/poisson2d";
import { createCompactModel } from "../src/physics/compact";
for (const key of ["nmos", "pmos"] as const) {
  const def = devices[key];
  const st = buildStructure(def, finalState(def));
  const model = createCompactModel(def, finalState(def));
  console.log(`\n=== ${key} mesh ${st.nx}x${st.ny}=${st.nx * st.ny}; comps`, st.compType.map((t, i) => `${i}:${t > 0 ? "n" : "p"}->${st.compTerminal[i]}`).join(" "), "channel", st.channel);
  const solver = new PoissonSolver(st);
  const k = def.bias.map((b) => b.key);
  for (const v of [[0, 0, 0], [1.8, 0.05, 0], [1.8, 1.5, 0], [3.3, 3.3, 0], [0.3, 1.5, 0], [1.8, 1.5, -2]]) {
    const bias = { [k[0]]: v[0], [k[1]]: v[1], [k[2]]: v[2] };
    const op = model.evaluate(bias);
    const r = solver.solve(op.terminals, { channelPhi: op.channelPhi });
    // surface electron density along channel at y≈1nm
    let j = st.jSurface; while (st.ys[j] < 0.001) j++;
    const xsProbe = [1.3, 1.45, 1.6, 1.7, 1.75, 1.78];
    const line = xsProbe.map((x) => { let i = 0; while (st.xs[i + 1] <= x) i++; const kk = j * st.nx + i; return `${x}:${(key==="nmos"?r.n[kk]:r.p[kk]).toExponential(1)}`; }).join(" ");
    console.log(` ${JSON.stringify(bias)} newton=${r.newton} cg=${r.cg} ${r.ms.toFixed(0)}ms conv=${r.converged} | ${op.region} | carriers@1nm ${line}`);
  }
}
