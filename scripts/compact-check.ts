import { devices, finalState } from "../src/devices/registry";
import { createCompactModel } from "../src/physics/compact";
const biases: Record<string, Record<string, number>[]> = {
  diode: [{ VA: -20 }, { VA: -1 }, { VA: 0 }, { VA: 0.3 }, { VA: 0.6 }, { VA: 0.7 }, { VA: 0.85 }],
  npn: [{ VBE: 0.5, VCE: 3 }, { VBE: 0.7, VCE: 3 }, { VBE: 0.78, VCE: 3 }, { VBE: 0.85, VCE: 3 }, { VBE: 0.78, VCE: 0.1 }, { VBE: 0.78, VCE: 0.4 }],
  pnp: [{ VEB: 0.7, VEC: 3 }, { VEB: 0.78, VEC: 3 }],
  nmos: [{ VGS: 0, VDS: 1.5, VBS: 0 }, { VGS: 0.6, VDS: 1.5, VBS: 0 }, { VGS: 1.8, VDS: 0.1, VBS: 0 }, { VGS: 1.8, VDS: 1.5, VBS: 0 }, { VGS: 3.3, VDS: 3.3, VBS: 0 }, { VGS: 1.8, VDS: 1.5, VBS: -2 }],
  pmos: [{ VSG: 1.8, VSD: 1.5, VSB: 0 }, { VSG: 1.8, VSD: 1.5, VSB: 0 }],
};
for (const key of Object.keys(biases)) {
  const def = (devices as any)[key];
  const t0 = performance.now();
  const m = createCompactModel(def, finalState(def));
  console.log(`\n=== ${key} (${(performance.now() - t0).toFixed(0)} ms)`);
  m.params.forEach((p) => console.log(`   ${p.label}: ${p.value}`));
  for (const b of biases[key]) {
    const op = m.evaluate(b);
    console.log(`  ${JSON.stringify(b)} -> ${op.region} | ` + op.readouts.slice(0, 5).map((r) => `${r.label}=${r.value}`).join("; "), JSON.stringify(op.terminals));
  }
  const t1 = performance.now();
  const c = m.curves(biases[key][1]);
  console.log(`  curves in ${(performance.now() - t1).toFixed(0)} ms:`, c.map((v) => v.id + ":" + v.series.length).join(" "));
  if (key === "npn") { const out = c[0]; out.series.forEach(s => console.log("    ", s.label, [0,5,10,30,60,89].map(i=> `${s.x[i].toFixed(2)}:${(s.y[i]*1e3).toFixed(3)}mA`).join(" "))); }
  if (key === "nmos") { const out = c[0]; out.series.forEach(s => console.log("    ", s.label, [0,10,30,60,99].map(i=> `${s.x[i]?.toFixed(2)}:${(s.y[i]*1e3).toFixed(3)}mA`).join(" "))); }
}
