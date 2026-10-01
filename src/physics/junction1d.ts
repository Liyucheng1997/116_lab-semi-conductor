/**
 * 1-D helpers on a doping profile: depletion edges of an arbitrary (graded) junction by the
 * depletion approximation, Gummel numbers, and tabulated depletion edges versus bias.
 */
import { EPS0, EPS_SI, NI, Q, VT, mobilityN, mobilityP, nieSquared } from "./constants";

export interface Profile1D {
  /** depth in μm, uniformly spaced */
  y: Float64Array;
  /** net doping N_D − N_A */
  net: Float64Array;
  total: Float64Array;
  dy: number;
}

export function makeProfile(y: Float64Array, nd: Float64Array, na: Float64Array): Profile1D {
  const net = new Float64Array(y.length);
  const total = new Float64Array(y.length);
  for (let i = 0; i < y.length; i += 1) {
    net[i] = nd[i] - na[i];
    total[i] = nd[i] + na[i];
  }
  return { y, net, total, dy: y[1] - y[0] };
}

export function junctionIndices(p: Profile1D) {
  const out: number[] = [];
  for (let i = 1; i < p.y.length; i += 1) {
    if (p.net[i - 1] !== 0 && p.net[i] !== 0 && p.net[i - 1] * p.net[i] < 0) out.push(i);
  }
  return out;
}

/**
 * Depletion edges [left, right] (μm) of the junction whose metallurgical boundary lies between
 * indices j−1 and j, for forward voltage v across it (depletion approximation, arbitrary profile).
 */
export function depletionEdges(
  p: Profile1D,
  j: number,
  v: number,
  leftLimit = 0,
  rightLimit = p.y.length - 1,
  vbiFixed?: number
): [number, number, number] {
  const k = (Q / (EPS0 * EPS_SI)) * (p.dy * 1e-4) * (p.dy * 1e-4);
  const evaluate = (a: number) => {
    // a: extent into the left side in samples (fractional). Returns potential drop and right extent b.
    const whole = Math.floor(a);
    const frac = a - whole;
    let field = 0; // normalised: Σ|N|·k/dy
    let psi = 0;
    let qLeft = 0;
    const i0 = j - whole - 1;
    if (frac > 0 && i0 >= leftLimit) {
      const n = Math.abs(p.net[i0]) * frac;
      qLeft += n;
      field += n;
      psi += field * frac;
    }
    for (let i = j - whole; i < j; i += 1) {
      if (i < leftLimit) continue;
      const n = Math.abs(p.net[i]);
      qLeft += n;
      field += n;
      psi += field;
    }
    let b = 0;
    let qRight = 0;
    for (let i = j; i <= rightLimit; i += 1) {
      const n = Math.abs(p.net[i]);
      if (qRight + n >= qLeft) {
        const f = (qLeft - qRight) / Math.max(n, 1e-30);
        psi += (field - 0.5 * n * f) * f;
        b += f;
        field = 0;
        break;
      }
      qRight += n;
      field -= n;
      psi += field;
      b += 1;
    }
    const li = Math.max(j - Math.ceil(a), leftLimit);
    const ri = Math.min(j + Math.ceil(b), rightLimit);
    const nl = Math.abs(p.net[li]);
    const nr = Math.abs(p.net[ri]);
    const vbi = VT * Math.log(Math.max((nl * nr) / (NI * NI), 10)) - 2 * VT;
    return { drop: psi * k, vbi, b };
  };
  const aMax = Math.max(j - leftLimit, 1);
  // Built-in potential: evaluated self-consistently at zero bias (largest root of drop = V_bi(edges)),
  // then held fixed so the depletion width is a monotonic function of bias.
  let vbi = vbiFixed;
  if (vbi === undefined) {
    let aStar = 0.5;
    const steps = 120;
    for (let i = 0; i <= steps; i += 1) {
      const a = 0.5 * Math.pow(aMax / 0.5, i / steps);
      const r = evaluate(a);
      if (r.drop <= r.vbi) aStar = a;
    }
    vbi = evaluate(aStar).vbi;
  }
  const want = Math.max(vbi - v, 1e-4);
  let lo = 0.01;
  let hi = aMax;
  if (evaluate(hi).drop < want) {
    const r = evaluate(hi);
    return [p.y[j] - hi * p.dy, p.y[j] + r.b * p.dy, vbi];
  }
  for (let it = 0; it < 60; it += 1) {
    const mid = Math.sqrt(lo * hi);
    if (evaluate(mid).drop > want) hi = mid;
    else lo = mid;
  }
  const r = evaluate(lo);
  return [p.y[j] - lo * p.dy, p.y[j] + r.b * p.dy, vbi];
}

export interface EdgeTable {
  v: Float64Array;
  left: Float64Array;
  right: Float64Array;
  vbi: number;
}

export function tabulateEdges(p: Profile1D, j: number, vMin: number, vMax: number, count: number, leftLimit = 0, rightLimit = p.y.length - 1): EdgeTable {
  const v = new Float64Array(count);
  const left = new Float64Array(count);
  const right = new Float64Array(count);
  const vbi = depletionEdges(p, j, 0, leftLimit, rightLimit)[2];
  for (let i = 0; i < count; i += 1) {
    v[i] = vMin + ((vMax - vMin) * i) / (count - 1);
    const [a, b] = depletionEdges(p, j, v[i], leftLimit, rightLimit, vbi);
    left[i] = a;
    right[i] = b;
  }
  return { v, left, right, vbi };
}

export function lookupEdges(t: EdgeTable, v: number): [number, number] {
  const n = t.v.length;
  if (v <= t.v[0]) return [t.left[0], t.right[0]];
  if (v >= t.v[n - 1]) return [t.left[n - 1], t.right[n - 1]];
  const f = ((v - t.v[0]) / (t.v[n - 1] - t.v[0])) * (n - 1);
  const i = Math.floor(f);
  const w = f - i;
  return [t.left[i] * (1 - w) + t.left[i + 1] * w, t.right[i] * (1 - w) + t.right[i + 1] * w];
}

/**
 * Gummel number ∫ N/(D·nie²/ni²) dy (s·cm⁻⁴) of the minority carrier between two depths.
 * `minority` = "n" for electrons in p-type material, "p" for holes in n-type material.
 */
export function gummel(p: Profile1D, from: number, to: number, minority: "n" | "p") {
  let g = 0;
  const dy = p.dy * 1e-4;
  for (let i = 0; i < p.y.length; i += 1) {
    const y = p.y[i];
    if (y < from || y > to) continue;
    const n = Math.abs(p.net[i]);
    const tot = p.total[i];
    const d = VT * (minority === "n" ? mobilityN(tot) : mobilityP(tot));
    g += (n / (d * (nieSquared(tot) / (NI * NI)))) * dy;
  }
  return g;
}

/** Integrated |net doping| (cm⁻²) between two depths. */
export function charge(p: Profile1D, from: number, to: number) {
  let s = 0;
  for (let i = 0; i < p.y.length; i += 1) {
    if (p.y[i] >= from && p.y[i] <= to) s += Math.abs(p.net[i]) * p.dy * 1e-4;
  }
  return s;
}

export function averageDoping(p: Profile1D, from: number, to: number) {
  return charge(p, from, to) / Math.max((to - from) * 1e-4, 1e-12);
}

export function valueAt(p: Profile1D, y: number) {
  const i = Math.min(Math.max(Math.round((y - p.y[0]) / p.dy), 0), p.y.length - 1);
  return p.net[i];
}
