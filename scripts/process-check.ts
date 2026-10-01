import { devices, deviceOrder, runProcess } from "../src/devices/registry";
import { depthProfile, findJunctions, formatConc } from "../src/physics/process";

for (const key of deviceOrder) {
  const def = devices[key];
  console.log(`\n=== ${def.name} ===`);
  for (let i = 0; i < def.recipe.length; i++) {
    const s = runProcess(def, i);
    if (s.results.length) console.log(`  [${i}] ${def.recipe[i].title}: ` + s.results.map(([a, b]) => `${a}=${b}`).join(", "));
  }
  const s = runProcess(def);
  const cut = def.cutlines.find((c) => c.orientation === "vertical")!;
  const prof = depthProfile(s, cut.at, 0, 0, def.domain.y1, 1200);
  console.log("  junctions:", findJunctions(prof).map((v) => v.toFixed(3)).join(", "));
  const pts = [0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0, 1.5, 1.8, 2.0, 2.5, 3.0, 3.4];
  console.log("  profile:", pts.filter(p=>p<def.domain.y1).map((p) => { const n = s.net(cut.at, p, 0); return `${p}:${n>=0?"n":"p"}${formatConc(Math.abs(n))}`; }).join("  "));
  if (s.params.tox) console.log("  tox", s.params.tox, "leff", s.params.leff, s.params.xs, s.params.xd);
}
