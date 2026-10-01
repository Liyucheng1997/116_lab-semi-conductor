/**
 * Paints the silicon faces of the 3-D block: doping maps from the process simulator and
 * solution fields sampled from the non-uniform device mesh, with contour overlays.
 */
import type { FaceMap, MeshInfo, SolveResultMsg } from "../worker/protocol";
import { LUT, OXIDE_RGB, VOID_RGB, dopingColor, type LutName } from "./colormap";
import { VT } from "../physics/constants";
import { neutralPotential } from "../physics/poisson2d";

export type FieldKey = "doping" | "psi" | "efield" | "n" | "p" | "rho";

export interface FieldInfo {
  key: FieldKey;
  label: string;
  unit: string;
  lut: LutName | "doping";
  log: boolean;
}

export const FIELDS: FieldInfo[] = [
  { key: "doping", label: "净掺杂 N_D − N_A", unit: "cm⁻³", lut: "doping", log: true },
  { key: "psi", label: "静电势 ψ", unit: "V", lut: "turbo", log: false },
  { key: "efield", label: "电场强度 |E|", unit: "kV/cm", lut: "inferno", log: false },
  { key: "n", label: "电子浓度 n", unit: "cm⁻³", lut: "electrons", log: true },
  { key: "p", label: "空穴浓度 p", unit: "cm⁻³", lut: "holes", log: true },
  { key: "rho", label: "空间电荷 ρ/q", unit: "cm⁻³", lut: "diverging", log: true }
];

export interface ColorScale {
  min: number;
  max: number;
  log: boolean;
  lut: LutName | "doping";
  unit: string;
  label: string;
  ticks: Array<{ t: number; text: string }>;
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function paintMaterial(data: Uint8ClampedArray, k: number, m: number, r: number, c: number) {
  const o = k * 4;
  if (m === 1) {
    const hatch = (r + c) % 7 === 0 ? 14 : 0;
    data[o] = OXIDE_RGB[0] + hatch;
    data[o + 1] = OXIDE_RGB[1] + hatch;
    data[o + 2] = OXIDE_RGB[2] + hatch;
  } else {
    data[o] = VOID_RGB[0];
    data[o + 1] = VOID_RGB[1];
    data[o + 2] = VOID_RGB[2];
  }
  data[o + 3] = 255;
}

/** Marching squares on a regular grid; returns line segments in pixel coordinates. */
export function contour(values: Float32Array, w: number, h: number, level: number, valid?: (k: number) => boolean) {
  const segs: number[] = [];
  const interp = (a: number, b: number) => (level - a) / (b - a);
  for (let r = 0; r < h - 1; r += 1) {
    for (let c = 0; c < w - 1; c += 1) {
      const k = r * w + c;
      if (valid && !(valid(k) && valid(k + 1) && valid(k + w) && valid(k + w + 1))) continue;
      const v0 = values[k];
      const v1 = values[k + 1];
      const v2 = values[k + w + 1];
      const v3 = values[k + w];
      let idx = 0;
      if (v0 > level) idx |= 1;
      if (v1 > level) idx |= 2;
      if (v2 > level) idx |= 4;
      if (v3 > level) idx |= 8;
      if (idx === 0 || idx === 15) continue;
      const x = c + 0.5;
      const y = r + 0.5;
      const top = () => [x + interp(v0, v1), y];
      const right = () => [x + 1, y + interp(v1, v2)];
      const bottom = () => [x + interp(v3, v2), y + 1];
      const left = () => [x, y + interp(v0, v3)];
      const add = (a: number[], b: number[]) => segs.push(a[0], a[1], b[0], b[1]);
      switch (idx) {
        case 1:
        case 14:
          add(left(), top());
          break;
        case 2:
        case 13:
          add(top(), right());
          break;
        case 3:
        case 12:
          add(left(), right());
          break;
        case 4:
        case 11:
          add(right(), bottom());
          break;
        case 5:
          add(left(), top());
          add(right(), bottom());
          break;
        case 6:
        case 9:
          add(top(), bottom());
          break;
        case 7:
        case 8:
          add(left(), bottom());
          break;
        case 10:
          add(top(), right());
          add(left(), bottom());
          break;
      }
    }
  }
  return segs;
}

function strokeSegments(ctx: CanvasRenderingContext2D, segs: number[], color: string, width: number, dash: number[] = []) {
  if (!segs.length) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let i = 0; i < segs.length; i += 4) {
    ctx.moveTo(segs[i], segs[i + 1]);
    ctx.lineTo(segs[i + 2], segs[i + 3]);
  }
  ctx.stroke();
  ctx.restore();
}

function asinhDoping(map: FaceMap) {
  const out = new Float32Array(map.net.length);
  for (let i = 0; i < out.length; i += 1) out[i] = Math.asinh(map.net[i] / 1e12);
  return out;
}

/** Doping face with metallurgical junction contour. `dim` fades toward grey for context faces. */
export function paintDoping(map: FaceMap, opts: { dim?: number; junctions?: boolean; glow?: number } = {}) {
  const { width: w, height: h } = map;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const dim = opts.dim ?? 0;
  const glow = opts.glow ?? 0;
  const tmp = [0, 0, 0];
  for (let r = 0; r < h; r += 1) {
    for (let c = 0; c < w; c += 1) {
      const k = r * w + c;
      const m = map.mat[k];
      if (m !== 0) {
        paintMaterial(d, k, m, r, c);
        continue;
      }
      dopingColor(map.net[k], tmp);
      const o = k * 4;
      const g = (tmp[0] + tmp[1] + tmp[2]) / 3;
      d[o] = Math.min(255, tmp[0] * (1 - dim) + g * dim * 0.8 + glow * 120);
      d[o + 1] = Math.min(255, tmp[1] * (1 - dim) + g * dim * 0.8 + glow * 50);
      d[o + 2] = tmp[2] * (1 - dim) + g * dim * 0.8;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (opts.junctions !== false) {
    const segs = contour(asinhDoping(map), w, h, 0, (k) => map.mat[k] === 0);
    strokeSegments(ctx, segs, "rgba(255,255,255,0.9)", Math.max(1, w / 520));
  }
  return canvas;
}

/** Bilinear sampler from the non-uniform solver mesh onto a face raster. */
export class MeshSampler {
  readonly idx: Int32Array;
  readonly fx: Float32Array;
  readonly fy: Float32Array;

  constructor(
    readonly mesh: MeshInfo,
    readonly w: number,
    readonly h: number,
    x0: number,
    x1: number,
    y0: number,
    y1: number
  ) {
    const n = w * h;
    this.idx = new Int32Array(n);
    this.fx = new Float32Array(n);
    this.fy = new Float32Array(n);
    const { xs, ys, nx, ny } = mesh;
    const colI = new Int32Array(w);
    const colF = new Float32Array(w);
    for (let c = 0; c < w; c += 1) {
      const x = x0 + ((c + 0.5) / w) * (x1 - x0);
      let i = 0;
      while (i < nx - 2 && xs[i + 1] < x) i += 1;
      colI[c] = i;
      colF[c] = Math.min(Math.max((x - xs[i]) / (xs[i + 1] - xs[i]), 0), 1);
    }
    for (let r = 0; r < h; r += 1) {
      const y = y0 + ((r + 0.5) / h) * (y1 - y0);
      let j = 0;
      while (j < ny - 2 && ys[j + 1] < y) j += 1;
      const fy = Math.min(Math.max((y - ys[j]) / (ys[j + 1] - ys[j]), 0), 1);
      for (let c = 0; c < w; c += 1) {
        const k = r * w + c;
        this.idx[k] = j * nx + colI[c];
        this.fx[k] = colF[c];
        this.fy[k] = fy;
      }
    }
  }

  sample(values: Float32Array | Float64Array, out: Float32Array) {
    const nx = this.mesh.nx;
    const si = this.mesh.si;
    for (let k = 0; k < out.length; k += 1) {
      const i0 = this.idx[k];
      const fx = this.fx[k];
      const fy = this.fy[k];
      let a = values[i0];
      let b = values[i0 + 1];
      let c = values[i0 + nx];
      let d = values[i0 + nx + 1];
      // fall back to silicon neighbours at dielectric boundaries
      if (!si[i0] || !si[i0 + 1] || !si[i0 + nx] || !si[i0 + nx + 1]) {
        const pts = [
          [si[i0], a],
          [si[i0 + 1], b],
          [si[i0 + nx], c],
          [si[i0 + nx + 1], d]
        ];
        const ok = pts.filter((q) => q[0]);
        const avg = ok.length ? ok.reduce((s, q) => s + q[1], 0) / ok.length : a;
        if (!si[i0]) a = avg;
        if (!si[i0 + 1]) b = avg;
        if (!si[i0 + nx]) c = avg;
        if (!si[i0 + nx + 1]) d = avg;
      }
      out[k] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
    return out;
  }
}

function niceTicksLin(min: number, max: number, count = 4) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const m = step0 / mag;
  const step = (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  return out;
}

function sup(n: number) {
  const map: Record<string, string> = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
  return String(n)
    .split("")
    .map((c) => map[c] ?? c)
    .join("");
}

export interface FieldPaintInput {
  field: FieldKey;
  solution: SolveResultMsg;
  sampler: MeshSampler;
  front: FaceMap; // process doping map at the same raster (for materials and junctions)
  equipotentials: boolean;
}

/** Paint a solution quantity onto the cross-section; returns canvas + colour scale for the legend. */
export function paintField(input: FieldPaintInput): { canvas: HTMLCanvasElement; scale: ColorScale } {
  const { field, solution, sampler, front } = input;
  const w = sampler.w;
  const h = sampler.h;
  const info = FIELDS.find((f) => f.key === field) as FieldInfo;
  if (field === "doping") {
    const canvas = paintDoping(front);
    overlayDepletion(canvas, input);
    return {
      canvas,
      scale: { min: -20.3, max: 20.3, log: true, lut: "doping", unit: info.unit, label: info.label, ticks: dopingTicks() }
    };
  }
  const N = solution.psi.length;
  const node = new Float32Array(N);
  const si = sampler.mesh.si;
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < N; k += 1) {
    let v = 0;
    switch (field) {
      case "psi":
        v = solution.psi[k];
        break;
      case "efield":
        v = Math.hypot(solution.ex[k], solution.ey[k]) / 1e3;
        break;
      case "n":
        v = Math.log10(Math.max(solution.n[k], 1));
        break;
      case "p":
        v = Math.log10(Math.max(solution.p[k], 1));
        break;
      case "rho": {
        const r = solution.p[k] - solution.n[k] + sampler.mesh.net[k];
        v = Math.sign(r) * Math.max(Math.log10(Math.abs(r) + 1) - 12, 0);
        break;
      }
    }
    node[k] = v;
    if (si[k]) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  if (field === "n" || field === "p") {
    min = 2;
    max = 21;
  } else if (field === "rho") {
    const a = Math.max(Math.abs(min), Math.abs(max), 1);
    min = -Math.min(a, 8.5);
    max = -min;
  } else if (field === "efield") {
    min = 0;
    max = Math.max(max, 10);
  } else if (max - min < 0.2) {
    const c = 0.5 * (max + min);
    min = c - 0.1;
    max = c + 0.1;
  }
  const px = new Float32Array(w * h);
  sampler.sample(node, px);
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const lut = LUT[info.lut as LutName];
  const gamma = field === "efield" ? 0.65 : 1;
  for (let r = 0; r < h; r += 1) {
    for (let c = 0; c < w; c += 1) {
      const k = r * w + c;
      const m = front.mat[k];
      if (m !== 0) {
        paintMaterial(d, k, m, r, c);
        continue;
      }
      let t = (px[k] - min) / (max - min);
      t = Math.pow(Math.min(Math.max(t, 0), 1), gamma);
      const li = Math.round(t * 255) * 3;
      const o = k * 4;
      d[o] = lut[li];
      d[o + 1] = lut[li + 1];
      d[o + 2] = lut[li + 2];
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (field === "psi" && input.equipotentials) {
    const step = niceTicksLin(min, max, 12);
    const valid = (k: number) => front.mat[k] === 0;
    const lw = Math.max(0.8, w / 900);
    step.forEach((lv) => strokeSegments(ctx, contour(px, w, h, lv, valid), "rgba(10,14,20,0.45)", lw));
  }
  // metallurgical junctions
  strokeSegments(ctx, contour(asinhDoping(front), w, h, 0, (k) => front.mat[k] === 0), "rgba(255,255,255,0.85)", Math.max(1, w / 560));
  overlayDepletion(canvas, input);

  let ticks: Array<{ t: number; text: string }>;
  if (field === "n" || field === "p") {
    ticks = [4, 8, 12, 16, 20].map((e) => ({ t: (e - min) / (max - min), text: `10${sup(e)}` }));
  } else if (field === "rho") {
    ticks = [
      { t: 0, text: `−10${sup(Math.round(-min + 12))}` },
      { t: 0.5, text: "0" },
      { t: 1, text: `+10${sup(Math.round(max + 12))}` }
    ];
  } else {
    ticks = niceTicksLin(min, max, 4).map((v) => ({
      t: Math.pow((v - min) / (max - min), gamma),
      text: field === "efield" ? v.toFixed(0) : v.toFixed(Math.abs(max - min) < 2 ? 2 : 1)
    }));
  }
  return { canvas, scale: { min, max, log: info.log, lut: info.lut, unit: info.unit, label: info.label, ticks } };
}

function overlayDepletion(canvas: HTMLCanvasElement, input: FieldPaintInput) {
  const { solution, sampler, front } = input;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  // smooth neutrality indicator (majority / |N|, damped where ψ departs from its neutral value) so the
  // contour follows the physics rather than the mesh staircase
  const node = new Float32Array(solution.neutral.length);
  const net = sampler.mesh.net;
  for (let k = 0; k < node.length; k += 1) {
    if (!sampler.mesh.si[k]) {
      node[k] = 1;
      continue;
    }
    const a = Math.max(Math.abs(net[k]), 1e10);
    const maj = net[k] >= 0 ? solution.n[k] : solution.p[k];
    const dev = Math.abs(solution.psi[k] - neutralPotential(net[k], solution.phin[k], solution.phip[k]));
    const g = Math.min(Math.max(1 - (dev - 2 * VT) / (2 * VT), 0), 1);
    node[k] = Math.min(maj / a, 1) * g;
  }
  const px = new Float32Array(sampler.w * sampler.h);
  sampler.sample(node, px);
  const segs = contour(px, sampler.w, sampler.h, 0.5, (k) => front.mat[k] === 0);
  const s = Math.max(1, sampler.w / 520);
  strokeSegments(ctx, segs, "rgba(255,236,150,0.95)", s * 1.2, [4 * s, 3 * s]);
}

function dopingTicks() {
  return [
    { t: 0, text: "p 10²⁰" },
    { t: 0.25, text: "10¹⁷" },
    { t: 0.5, text: "0" },
    { t: 0.75, text: "10¹⁷" },
    { t: 1, text: "n 10²⁰" }
  ];
}
