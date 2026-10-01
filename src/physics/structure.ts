/**
 * Builds the 2-D simulation structure (tensor-product mesh, materials, doping, contacts,
 * doping-connected regions) for the z = 0 cross-section of a processed device.
 */
import type { ContactDef, DeviceDefinition, DeviceKey } from "../devices/types";
import { EPS_OX, EPS_SI } from "./constants";
import type { ProcessState } from "./process";

export interface DeviceStructure {
  key: DeviceKey;
  nx: number;
  ny: number;
  xs: Float64Array; // μm
  ys: Float64Array; // μm
  nd: Float64Array;
  na: Float64Array;
  net: Float64Array;
  /** node touches at least one silicon cell */
  si: Uint8Array;
  /** silicon part of the control volume (cm²) */
  siArea: Float64Array;
  cellSi: Uint8Array;
  /** geometric couplings ε_r·(face / distance) */
  cX: Float64Array;
  cY: Float64Array;
  contacts: ContactDef[];
  /** index into contacts for Dirichlet nodes, -1 otherwise */
  contactOf: Int16Array;
  comp: Int32Array;
  compType: number[];
  compTerminal: Array<string | null>;
  nearestN: Int32Array;
  nearestP: Int32Array;
  jSurface: number;
  tox: number;
  gateWorkOffset: number;
  channel: { xs: number; xd: number } | null;
  polarity: 1 | -1;
}

interface Refine {
  at: number;
  h: number;
}

function segmentMesh(a: number, b: number, size: (x: number) => number) {
  const pts = [a];
  let x = a;
  let guard = 0;
  while (x < b && guard < 5000) {
    guard += 1;
    let h = size(x);
    h = Math.min(h, size(x + h));
    if (x + h >= b - 0.35 * h) {
      pts.push(b);
      break;
    }
    x += h;
    pts.push(x);
  }
  if (pts[pts.length - 1] !== b) pts.push(b);
  return pts;
}

export function gradedMesh(a: number, b: number, keys: number[], refine: Refine[], hmax: number, ratio: number) {
  const size = (x: number) => {
    let h = hmax;
    for (const r of refine) h = Math.min(h, r.h + (ratio - 1) * Math.abs(x - r.at));
    return h;
  };
  const cuts = Array.from(new Set([a, b, ...keys.filter((k) => k > a && k < b)])).sort((p, q) => p - q);
  const merged: number[] = [];
  for (let s = 0; s < cuts.length - 1; s += 1) {
    const seg = segmentMesh(cuts[s], cuts[s + 1], size);
    if (s > 0) seg.shift();
    merged.push(...seg);
  }
  // drop degenerate intervals
  const out: number[] = [merged[0]];
  for (let i = 1; i < merged.length; i += 1) {
    if (merged[i] - out[out.length - 1] > 1e-6) out.push(merged[i]);
  }
  return Float64Array.from(out);
}

function signChanges(sample: (t: number) => number, a: number, b: number, step: number) {
  const out: number[] = [];
  let prev = sample(a);
  for (let t = a + step; t <= b + 1e-9; t += step) {
    const v = sample(t);
    if (prev !== 0 && v !== 0 && prev * v < 0) out.push(t - step / 2);
    prev = v;
  }
  return out;
}

export function buildStructure(def: DeviceDefinition, state: ProcessState): DeviceStructure {
  const d = def.domain;
  const mos = def.family === "mos";
  const tox = mos ? state.params.tox : 0;

  // --- mesh refinement from doping topology -------------------------------------------------
  const xRef: Refine[] = def.xRefine.map((at) => ({ at, h: mos ? 0.01 : 0.045 }));
  const yRef: Refine[] = [{ at: 0, h: mos ? 0.0006 : 0.012 }];
  const lateralLines = mos ? [0.005, 0.03, 0.08, 0.15] : [0.05, 0.2];
  lateralLines.forEach((y) => {
    signChanges((x) => (state.isSilicon(x, y, 0) ? state.net(x, y, 0) : 0), d.x0, d.x1, 0.004).forEach((at) =>
      xRef.push({ at, h: mos ? 0.006 : 0.035 })
    );
  });
  // vertical junctions: resolved finely under the cutlines, coarser elsewhere
  const verticalLines: Array<[number, number]> = [];
  for (let x = d.x0 + 0.1; x < d.x1; x += mos ? 0.1 : 0.5) verticalLines.push([x, mos ? 0.004 : 0.02]);
  def.cutlines.filter((c) => c.orientation === "vertical").forEach((c) => verticalLines.push([c.at, mos ? 0.004 : 0.008]));
  verticalLines.forEach(([x, h]) => {
    signChanges((y) => (state.isSilicon(x, y, 0) ? state.net(x, y, 0) : 0), 0.001, d.y1, 0.002).forEach((at) => yRef.push({ at, h }));
  });
  const xKeys = [...def.xRefine];
  def.contacts.forEach((c) => {
    if (c.side === "top") xKeys.push(c.x0, c.x1);
  });
  const xs = gradedMesh(d.x0, d.x1, xKeys, xRef, mos ? 0.05 : 0.22, 1.3);
  const ySi = gradedMesh(0, d.y1, [], yRef, mos ? 0.05 : 0.15, 1.28);
  let ys: Float64Array;
  if (mos) {
    const oxRows = 4;
    const arr: number[] = [];
    for (let i = 0; i < oxRows; i += 1) arr.push(-tox + (tox * i) / oxRows);
    ys = Float64Array.from([...arr, ...ySi]);
  } else {
    ys = ySi;
  }
  const jSurface = mos ? 4 : 0;
  const nx = xs.length;
  const ny = ys.length;
  const N = nx * ny;

  // --- cells ---------------------------------------------------------------------------------
  const cellSi = new Uint8Array((nx - 1) * (ny - 1));
  const cellEps = new Float64Array((nx - 1) * (ny - 1));
  for (let j = 0; j < ny - 1; j += 1) {
    for (let i = 0; i < nx - 1; i += 1) {
      const cx = 0.5 * (xs[i] + xs[i + 1]);
      const cy = 0.5 * (ys[j] + ys[j + 1]);
      const m = cy < 0 ? 1 : state.materialAt(cx, cy, 0);
      const c = j * (nx - 1) + i;
      cellSi[c] = m === 0 ? 1 : 0;
      cellEps[c] = m === 0 ? EPS_SI : EPS_OX;
    }
  }

  // --- nodes ---------------------------------------------------------------------------------
  const nd = new Float64Array(N);
  const na = new Float64Array(N);
  const net = new Float64Array(N);
  const si = new Uint8Array(N);
  const siArea = new Float64Array(N);
  const cX = new Float64Array(N);
  const cY = new Float64Array(N);
  const tmp = { nd: 0, na: 0 };
  const cm = 1e-4;
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const k = j * nx + i;
      let area = 0;
      for (const [di, dj] of [
        [-1, -1],
        [0, -1],
        [-1, 0],
        [0, 0]
      ]) {
        const ci = i + di;
        const cj = j + dj;
        if (ci < 0 || cj < 0 || ci >= nx - 1 || cj >= ny - 1) continue;
        const c = cj * (nx - 1) + ci;
        if (cellSi[c]) area += 0.25 * (xs[ci + 1] - xs[ci]) * (ys[cj + 1] - ys[cj]) * cm * cm;
      }
      siArea[k] = area;
      if (area > 0) {
        si[k] = 1;
        state.doping(xs[i], Math.max(ys[j], 0), 0, tmp);
        nd[k] = tmp.nd;
        na[k] = tmp.na;
        net[k] = tmp.nd - tmp.na;
      }
      if (i < nx - 1) {
        const hx = xs[i + 1] - xs[i];
        let face = 0;
        if (j > 0) face += cellEps[(j - 1) * (nx - 1) + i] * 0.5 * (ys[j] - ys[j - 1]);
        if (j < ny - 1) face += cellEps[j * (nx - 1) + i] * 0.5 * (ys[j + 1] - ys[j]);
        cX[k] = face / hx;
      }
      if (j < ny - 1) {
        const hy = ys[j + 1] - ys[j];
        let face = 0;
        if (i > 0) face += cellEps[j * (nx - 1) + i - 1] * 0.5 * (xs[i] - xs[i - 1]);
        if (i < nx - 1) face += cellEps[j * (nx - 1) + i] * 0.5 * (xs[i + 1] - xs[i]);
        cY[k] = face / hy;
      }
    }
  }

  // --- contacts --------------------------------------------------------------------------------
  const contactOf = new Int16Array(N).fill(-1);
  def.contacts.forEach((c, ci) => {
    const j = c.kind === "gate" ? 0 : c.side === "top" ? jSurface : ny - 1;
    for (let i = 0; i < nx; i += 1) {
      if (xs[i] < c.x0 - 1e-9 || xs[i] > c.x1 + 1e-9) continue;
      const k = j * nx + i;
      if (c.kind === "ohmic" && !si[k]) continue;
      contactOf[k] = ci;
    }
  });

  // --- doping-connected regions ---------------------------------------------------------------
  const comp = new Int32Array(N).fill(-1);
  const compType: number[] = [];
  const compTerminal: Array<string | null> = [];
  const stack: number[] = [];
  for (let k0 = 0; k0 < N; k0 += 1) {
    if (!si[k0] || comp[k0] >= 0) continue;
    const type = net[k0] >= 0 ? 1 : -1;
    const id = compType.length;
    compType.push(type);
    compTerminal.push(null);
    comp[k0] = id;
    stack.push(k0);
    while (stack.length) {
      const k = stack.pop() as number;
      if (contactOf[k] >= 0 && def.contacts[contactOf[k]].kind === "ohmic" && compTerminal[id] === null) {
        compTerminal[id] = def.contacts[contactOf[k]].terminal;
      }
      const i = k % nx;
      const nb = [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, k - nx, k + nx];
      for (const m of nb) {
        if (m < 0 || m >= N || !si[m] || comp[m] >= 0) continue;
        if ((net[m] >= 0 ? 1 : -1) !== type) continue;
        comp[m] = id;
        stack.push(m);
      }
    }
  }

  const nearestN = nearestComponent(nx, ny, xs, ys, si, comp, compType, 1);
  const nearestP = nearestComponent(nx, ny, xs, ys, si, comp, compType, -1);

  let gateWorkOffset = 0;
  if (mos) {
    // n⁺ poly gate: Φ_M = χ ⇒ ψ_gate = V_G + E_g/2 ; p⁺ poly: ψ_gate = V_G − E_g/2
    gateWorkOffset = def.polarity === 1 ? 0.56 : -0.56;
  }

  return {
    key: def.key,
    nx,
    ny,
    xs,
    ys,
    nd,
    na,
    net,
    si,
    siArea,
    cellSi,
    cX,
    cY,
    contacts: def.contacts,
    contactOf,
    comp,
    compType,
    compTerminal,
    nearestN,
    nearestP,
    jSurface,
    tox,
    gateWorkOffset,
    channel: mos && state.params.xs !== undefined ? { xs: state.params.xs, xd: state.params.xd } : null,
    polarity: def.polarity
  };
}

/** Multi-source Dijkstra: for every silicon node, the closest region of the given doping type. */
function nearestComponent(
  nx: number,
  ny: number,
  xs: Float64Array,
  ys: Float64Array,
  si: Uint8Array,
  comp: Int32Array,
  compType: number[],
  type: number
) {
  const N = nx * ny;
  const label = new Int32Array(N).fill(-1);
  const dist = new Float64Array(N).fill(Infinity);
  const heap = new MinHeap();
  for (let k = 0; k < N; k += 1) {
    if (si[k] && comp[k] >= 0 && compType[comp[k]] === type) {
      dist[k] = 0;
      label[k] = comp[k];
      heap.push(k, 0);
    }
  }
  while (heap.size) {
    const [k, dk] = heap.pop();
    if (dk > dist[k]) continue;
    const i = k % nx;
    const j = (k - i) / nx;
    const visit = (m: number, w: number) => {
      if (!si[m]) return;
      const nd = dk + w;
      if (nd < dist[m]) {
        dist[m] = nd;
        label[m] = label[k];
        heap.push(m, nd);
      }
    };
    if (i > 0) visit(k - 1, xs[i] - xs[i - 1]);
    if (i < nx - 1) visit(k + 1, xs[i + 1] - xs[i]);
    if (j > 0) visit(k - nx, ys[j] - ys[j - 1]);
    if (j < ny - 1) visit(k + nx, ys[j + 1] - ys[j]);
  }
  return label;
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, val: number) {
    this.keys.push(key);
    this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.vals[p] <= this.vals[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.keys[0], this.vals[0]];
    const lastK = this.keys.pop() as number;
    const lastV = this.vals.pop() as number;
    if (this.keys.length) {
      this.keys[0] = lastK;
      this.vals[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.vals[l] < this.vals[m]) m = l;
        if (r < this.keys.length && this.vals[r] < this.vals[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.vals[a], this.vals[b]] = [this.vals[b], this.vals[a]];
  }
}
