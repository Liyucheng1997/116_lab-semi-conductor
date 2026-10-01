import type { CutlineDef } from "../devices/types";
import type { MeshInfo, SolveResultMsg } from "../worker/protocol";
import { EG } from "./constants";

export interface CutData {
  t: number[];
  ec: number[];
  ev: number[];
  ei: number[];
  efn: number[];
  efp: number[];
  psi: number[];
  field: number[]; // kV/cm, component along the cut direction
  n: number[];
  p: number[];
  nd: number[];
  na: number[];
  net: number[];
  rho: number[];
  neutral: number[];
}

/** Extract 1-D profiles from the 2-D solution along a cutline (interpolating across the mesh). */
export function extractCut(mesh: MeshInfo, sol: SolveResultMsg, cut: CutlineDef): CutData {
  const { xs, ys, nx } = mesh;
  const out: CutData = { t: [], ec: [], ev: [], ei: [], efn: [], efp: [], psi: [], field: [], n: [], p: [], nd: [], na: [], net: [], rho: [], neutral: [] };
  const vertical = cut.orientation === "vertical";
  const across = vertical ? xs : ys;
  const along = vertical ? ys : xs;
  let a = 0;
  while (a < across.length - 2 && across[a + 1] <= cut.at) a += 1;
  const w = Math.min(Math.max((cut.at - across[a]) / (across[a + 1] - across[a]), 0), 1);
  for (let b = 0; b < along.length; b += 1) {
    const t = along[b];
    if (t < cut.from - 1e-9 || t > cut.to + 1e-9) continue;
    const k0 = vertical ? b * nx + a : a * nx + b;
    const k1 = vertical ? b * nx + a + 1 : (a + 1) * nx + b;
    const s0 = mesh.si[k0];
    const s1 = mesh.si[k1];
    if (!s0 && !s1) continue;
    const ww = !s0 ? 1 : !s1 ? 0 : w;
    const lin = (arr: ArrayLike<number>) => arr[k0] * (1 - ww) + arr[k1] * ww;
    const lg = (arr: ArrayLike<number>) => Math.pow(10, Math.log10(Math.max(arr[k0], 1e-30)) * (1 - ww) + Math.log10(Math.max(arr[k1], 1e-30)) * ww);
    const psi = lin(sol.psi);
    const n = lg(sol.n);
    const p = lg(sol.p);
    const net = lin(mesh.net);
    out.t.push(t);
    out.psi.push(psi);
    out.ei.push(-psi);
    out.ec.push(-psi + EG / 2);
    out.ev.push(-psi - EG / 2);
    out.efn.push(-lin(sol.phin));
    out.efp.push(-lin(sol.phip));
    out.field.push((vertical ? lin(sol.ey) : lin(sol.ex)) / 1e3);
    out.n.push(n);
    out.p.push(p);
    out.net.push(net);
    out.nd.push(Math.max(net, 0));
    out.na.push(Math.max(-net, 0));
    out.rho.push(p - n + net);
    out.neutral.push(lin(sol.neutral));
  }
  return out;
}

/** Contiguous space-charge intervals along the cut (for shading). */
export function depletionBands(c: CutData) {
  const bands: Array<[number, number]> = [];
  let start: number | null = null;
  for (let i = 0; i < c.t.length; i += 1) {
    const dep = Math.abs(c.neutral[i]) < 0.5;
    if (dep && start === null) start = c.t[i];
    if (!dep && start !== null) {
      bands.push([start, c.t[i]]);
      start = null;
    }
  }
  if (start !== null) bands.push([start, c.t[c.t.length - 1]]);
  return bands;
}
