/**
 * Compact (circuit-level) models whose parameters are extracted from the simulated process:
 *  - PN diode: Shockley diffusion current from Gummel numbers (with band-gap narrowing and the n/n⁺
 *    high–low junction), SRH space-charge recombination, high injection, series resistance, avalanche.
 *  - BJT: Moll–Ross/Gummel–Poon charge-control model with base-width modulation from the real base
 *    profile, emitter back-injection, base/SCR recombination, high injection + Kirk effect,
 *    parasitic resistances and BC avalanche.
 *  - MOSFET: EKV charge-based model (valid from weak to strong inversion) with body effect,
 *    mobility degradation, velocity saturation, CLM and DIBL; also provides the gradual-channel
 *    quasi-Fermi potential φ(x) that drives the 2-D channel solution.
 */
import type { DeviceDefinition } from "../devices/types";
import {
  EPS0,
  EPS_OX,
  EPS_SI,
  NI,
  Q,
  VT,
  bandgapNarrowing,
  lifetimeN,
  lifetimeP,
  mobilityN,
  mobilityP,
  planarBreakdown,
  resistivity
} from "./constants";
import { averageDoping, charge, junctionIndices, lookupEdges, makeProfile, tabulateEdges, type EdgeTable, type Profile1D } from "./junction1d";
import { depthProfile, type ProcessState } from "./process";

export interface Readout {
  label: string;
  value: string;
  hint?: string;
}

export interface CurveSeries {
  label: string;
  x: number[];
  y: number[];
  emphasis?: boolean;
}

export interface CurveView {
  id: string;
  title: string;
  /** short tab label */
  short: string;
  xLabel: string;
  yLabel: string;
  xUnit: string;
  yUnit: string;
  yScale: "lin" | "log";
  series: CurveSeries[];
  marker?: { x: number; y: number };
  /** bias key controlled by clicking on the x axis */
  xBias?: string;
  xSign?: number;
  bands?: Array<{ from: number; to: number; label: string; tone: "off" | "mid" | "on" | "warn" }>;
}

export interface OperatingPoint {
  region: string;
  tone: "off" | "mid" | "on" | "warn";
  /** potentials applied to the 2-D structure (internal nodes, after IR drops) */
  terminals: Record<string, number>;
  channelPhi?: (x: number) => number;
  readouts: Readout[];
  values: Record<string, number>;
}

export interface CompactModel {
  params: Readout[];
  evaluate(bias: Record<string, number>): OperatingPoint;
  curves(bias: Record<string, number>): CurveView[];
}

const cm2 = 1e-8; // μm² → cm²

function fmt(v: number, unit: string, digits = 3) {
  if (!isFinite(v)) return "—";
  const a = Math.abs(v);
  const prefixes: Array<[number, string]> = [
    [1e9, "G"],
    [1e6, "M"],
    [1e3, "k"],
    [1, ""],
    [1e-3, "m"],
    [1e-6, "μ"],
    [1e-9, "n"],
    [1e-12, "p"],
    [1e-15, "f"],
    [1e-18, "a"]
  ];
  if (a === 0) return `0 ${unit}`;
  for (const [m, p] of prefixes) {
    if (a >= m * 0.9995) return `${(v / m).toPrecision(digits)} ${p}${unit}`;
  }
  return `${v.toExponential(2)} ${unit}`;
}
export { fmt as formatSI };

function cumulative(p: Profile1D, f: (i: number) => number) {
  const out = new Float64Array(p.y.length);
  let s = 0;
  for (let i = 0; i < p.y.length; i += 1) {
    s += f(i) * p.dy * 1e-4;
    out[i] = s;
  }
  return out;
}

function interpCum(p: Profile1D, cum: Float64Array, y: number) {
  const f = (y - p.y[0]) / p.dy;
  if (f <= 0) return 0;
  if (f >= p.y.length - 1) return cum[cum.length - 1];
  const i = Math.floor(f);
  const w = f - i;
  return cum[i] * (1 - w) + cum[i + 1] * w;
}

function linspace(a: number, b: number, n: number) {
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}

function profileAt(state: ProcessState, x: number, depth: number, count: number) {
  const raw = depthProfile(state, x, 0, 0, depth, count);
  return makeProfile(raw.y, raw.nd, raw.na);
}

/* ------------------------------------------------------------------------------------------------ */
/*  PN diode                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

export class DiodeModel implements CompactModel {
  params: Readout[] = [];
  private prof: Profile1D;
  private edges: EdgeTable;
  private area: number; // cm²
  private cumGn: Float64Array;
  private cumGp: Float64Array;
  private ndEpi: number;
  private naSurf: number;
  private epiEnd: number;
  private gSub: number;
  private vbi: number;
  private bv: number;
  private rs: number;
  private tauGR = 2e-7;
  private ikf: number;
  private dp: number;

  constructor(def: DeviceDefinition, state: ProcessState) {
    const depth = def.domain.y1;
    this.prof = profileAt(state, def.cutlines[0].at, depth, 1600);
    const p = this.prof;
    const j = junctionIndices(p)[0];
    const xj = p.y[j];
    this.naSurf = Math.abs(p.net[2]);
    // epi doping and the n/n⁺ interface
    const mid = Math.round((j + p.y.length * (def.geometry.epi / depth)) / 2);
    this.ndEpi = Math.abs(p.net[mid]);
    let e = mid;
    while (e < p.y.length - 1 && Math.abs(p.net[e]) < 10 * this.ndEpi) e += 1;
    this.epiEnd = p.y[e];
    this.edges = tabulateEdges(p, j, -40, 0.95, 120, 0, e);
    const perim = def.geometry.perimeter;
    this.area = (def.geometry.area + perim * (Math.PI / 2) * xj) * cm2;
    this.cumGn = cumulative(p, (i) => {
      const t = p.total[i];
      return p.net[i] < 0 ? Math.abs(p.net[i]) / (VT * mobilityN(t) * Math.exp(bandgapNarrowing(t) / VT)) : 0;
    });
    this.cumGp = cumulative(p, (i) => {
      const t = p.total[i];
      return p.net[i] > 0 ? Math.abs(p.net[i]) / (VT * mobilityP(t) * Math.exp(bandgapNarrowing(t) / VT)) : 0;
    });
    // n⁺ substrate acts as a high–low junction: effective Gummel number of a long n⁺ region
    const nSub = Math.abs(p.net[p.y.length - 1]);
    const dSub = VT * mobilityP(nSub);
    const lSub = Math.sqrt(dSub * lifetimeP(nSub));
    this.gSub = (nSub * lSub) / (dSub * Math.exp(bandgapNarrowing(nSub) / VT));
    // graded (Gaussian-tail) junction: V_bi set by the doping at the zero-bias depletion edges
    this.vbi = this.edges.vbi;
    // planar breakdown corrected for cylindrical junction curvature (Baliga) and the field plate
    const bvPP = planarBreakdown(this.ndEpi);
    const wc = Math.sqrt((2 * EPS0 * EPS_SI * bvPP) / (Q * this.ndEpi)) * 1e4;
    const r = xj / wc;
    const cyl = Math.sqrt(r * r + 2 * Math.pow(r, 6 / 7)) - r;
    this.bv = bvPP * Math.min(1, cyl * 1.35);
    const wNeutral = (this.epiEnd - xj - 0.3) * 1e-4;
    const aEff = this.area;
    this.rs = (resistivity(this.ndEpi, 0) * wNeutral) / aEff + 0.01 / (4 * Math.sqrt(aEff / Math.PI)) + 2;
    this.dp = VT * mobilityP(this.ndEpi);
    this.ikf = (Q * aEff * this.dp * this.ndEpi) / wNeutral;
    const is0 = this.saturation(0);
    this.params = [
      { label: "结面积 (含侧壁)", value: `${(this.area / cm2).toFixed(1)} μm²` },
      { label: "P⁺ 表面浓度", value: `${this.naSurf.toExponential(2)} cm⁻³` },
      { label: "外延掺杂 N_D", value: `${this.ndEpi.toExponential(2)} cm⁻³` },
      { label: "冶金结深 x_j", value: `${xj.toFixed(3)} μm` },
      { label: "内建电势 V_bi (缓变结自洽)", value: `${this.vbi.toFixed(3)} V` },
      { label: "饱和电流 I_S", value: fmt(is0.total, "A") },
      { label: "  其中 注入 n⁺ 衬底侧空穴", value: fmt(is0.holes, "A") },
      { label: "  其中 注入 p⁺ 区电子", value: fmt(is0.electrons, "A") },
      { label: "击穿电压 BV (含曲率修正)", value: `${this.bv.toFixed(1)} V` },
      { label: "串联电阻 R_S", value: `${this.rs.toFixed(0)} Ω` },
      { label: "大注入拐点 I_KF", value: fmt(this.ikf, "A") }
    ];
  }

  private saturation(v: number) {
    const [left, right] = lookupEdges(this.edges, v);
    const gp = interpCum(this.prof, this.cumGn, left); // electrons injected into p⁺
    const gn = interpCum(this.prof, this.cumGp, this.epiEnd) - interpCum(this.prof, this.cumGp, right) + this.gSub;
    const electrons = (Q * this.area * NI * NI) / Math.max(gp, 1e-30);
    const holes = (Q * this.area * NI * NI) / Math.max(gn, 1e-30);
    return { electrons, holes, total: electrons + holes, width: right - left, left, right };
  }

  junctionCurrent(v: number) {
    const s = this.saturation(v);
    const ideal = s.total * (Math.exp(v / VT) - 1);
    const hi = ideal > 0 ? ideal / (0.5 * (1 + Math.sqrt(1 + (4 * ideal) / this.ikf))) : ideal;
    const gr = ((Q * this.area * NI * s.width * 1e-4) / (2 * this.tauGR)) * (v >= 0 ? Math.exp(v / (2 * VT)) - 1 : -1);
    let i = hi + gr;
    if (v < 0) {
      const ratio = Math.min(-v / this.bv, 0.9995);
      const m = 1 / (1 - Math.pow(ratio, 4));
      i *= m;
      if (-v > this.bv) i -= (-v - this.bv) / 150;
    }
    return { i, ideal: hi, gr, s };
  }

  private solve(vext: number) {
    let lo = Math.min(vext, 0) - 1;
    let hi = vext + 1e-9;
    if (vext <= 0) {
      const r = this.junctionCurrent(vext);
      // reverse: IR drop is negligible except in breakdown
      if (-vext < this.bv) return { vj: vext, ...r };
    }
    for (let it = 0; it < 80; it += 1) {
      const mid = 0.5 * (lo + hi);
      const f = mid + this.junctionCurrent(mid).i * this.rs - vext;
      if (f > 0) hi = mid;
      else lo = mid;
    }
    const vj = 0.5 * (lo + hi);
    return { vj, ...this.junctionCurrent(vj) };
  }

  evaluate(bias: Record<string, number>): OperatingPoint {
    const v = bias.VA;
    const r = this.solve(v);
    const i = r.i;
    const w = r.s.width;
    const vt = this.vbi - r.vj;
    const emax = vt > 0 ? (2 * vt) / (w * 1e-4) : 0;
    const cj = (EPS0 * EPS_SI * this.area) / (w * 1e-4);
    const tauT = Math.pow((this.epiEnd - r.s.right) * 1e-4, 2) / (2 * this.dp);
    const cd = Math.max(i, 0) * (tauT / VT);
    const dv = 1e-3;
    const nIdeal = i > 0 ? dv / (VT * Math.log(this.junctionCurrent(r.vj + dv).i / Math.max(this.junctionCurrent(r.vj).i, 1e-30))) : NaN;
    let region = "零偏：平衡态";
    let tone: OperatingPoint["tone"] = "off";
    if (v < 0 && -v >= this.bv * 0.98) {
      region = "雪崩击穿区";
      tone = "warn";
    } else if (v < -0.05) {
      region = "反向偏置：截止";
      tone = "off";
    } else if (v > 0.05 && i < 1e-9) {
      region = "正偏：扩散电流很小";
      tone = "mid";
    } else if (i >= 1e-9 && r.ideal < 5 * Math.abs(r.gr)) {
      region = "正偏：复合电流主导 (n≈2)";
      tone = "mid";
    } else if (i >= 1e-9) {
      region = r.ideal > 0.3 * this.ikf ? "正偏：大注入 / 串阻限流" : "正偏导通：扩散电流主导";
      tone = "on";
    }
    return {
      region,
      tone,
      terminals: { A: r.vj, K: 0 },
      values: { I: i, vj: r.vj, width: w, emax, cj, left: r.s.left, right: r.s.right, vbi: this.vbi, bv: this.bv },
      readouts: [
        { label: "阳极电流 I_A", value: fmt(i, "A") },
        { label: "结电压 V_j (扣除 I·R_S)", value: `${r.vj.toFixed(3)} V` },
        { label: "耗尽层宽度 W", value: `${w.toFixed(3)} μm` },
        { label: "势垒高度 q(V_bi − V_j)", value: `${Math.max(vt, 0).toFixed(3)} eV` },
        { label: "峰值电场 (耗尽近似)", value: `${(emax / 1e3).toFixed(1)} kV/cm` },
        { label: "结电容 C_j", value: fmt(cj, "F") },
        { label: "扩散电容 C_d", value: fmt(cd, "F") },
        { label: "局部理想因子 n", value: isFinite(nIdeal) ? nIdeal.toFixed(2) : "—" }
      ]
    };
  }

  curves(bias: Record<string, number>): CurveView[] {
    const op = this.solve(bias.VA);
    const vf = linspace(0, 0.95, 220);
    const fwd = vf.map((v) => this.solve(v));
    const vr = linspace(-36, 0, 220);
    const rev = vr.map((v) => this.solve(v).i);
    const vl = linspace(-36, 0.95, 400);
    const lin = vl.map((v) => this.solve(v).i);
    const cv = linspace(-30, 0.4, 120);
    const cap = (v: number) => (EPS0 * EPS_SI * this.area) / (this.saturation(v).width * 1e-4);
    const floor = (v: number) => Math.max(Math.abs(v), 1e-18);
    return [
      {
        id: "fwd",
        short: "正向",
        title: "正向 I–V (半对数)",
        xLabel: "V_AK",
        yLabel: "I_A",
        xUnit: "V",
        yUnit: "A",
        yScale: "log",
        series: [
          { label: "I_A", x: vf, y: fwd.map((r) => floor(r.i)), emphasis: true },
          { label: "扩散分量 (n=1)", x: vf, y: fwd.map((r) => floor(r.ideal)) },
          { label: "复合分量 (n=2)", x: vf, y: fwd.map((r) => floor(r.gr)) }
        ],
        marker: bias.VA >= 0 ? { x: bias.VA, y: floor(op.i) } : undefined,
        xBias: "VA"
      },
      {
        id: "rev",
        short: "反向",
        title: "反向 I–V (含击穿)",
        xLabel: "V_AK",
        yLabel: "|I_A|",
        xUnit: "V",
        yUnit: "A",
        yScale: "log",
        series: [{ label: "|I_A|", x: vr, y: rev.map(floor), emphasis: true }],
        marker: bias.VA <= 0 ? { x: bias.VA, y: floor(op.i) } : undefined,
        xBias: "VA",
        bands: [
          { from: -36, to: -this.bv, label: "雪崩击穿", tone: "warn" },
          { from: -this.bv, to: 0, label: "反向截止", tone: "off" }
        ]
      },
      {
        id: "lin",
        short: "线性",
        title: "I–V 线性",
        xLabel: "V_AK",
        yLabel: "I_A",
        xUnit: "V",
        yUnit: "A",
        yScale: "lin",
        series: [{ label: "I_A", x: vl, y: lin, emphasis: true }],
        marker: { x: bias.VA, y: op.i },
        xBias: "VA"
      },
      {
        id: "cv",
        short: "C–V",
        title: "C–V",
        xLabel: "V_AK",
        yLabel: "C_j",
        xUnit: "V",
        yUnit: "F",
        yScale: "lin",
        series: [{ label: "C_j", x: cv, y: cv.map(cap), emphasis: true }],
        marker: bias.VA <= 0.4 ? { x: bias.VA, y: cap(bias.VA) } : undefined,
        xBias: "VA"
      }
    ];
  }
}

/* ------------------------------------------------------------------------------------------------ */
/*  Bipolar transistor                                                                               */
/* ------------------------------------------------------------------------------------------------ */

interface BjtState {
  ic: number;
  ib: number;
  ie: number;
  it: number;
  vbe: number;
  vbc: number;
  wb: number;
  eR: number;
  cL: number;
  cR: number;
  eL: number;
  qb: number;
  n0: number;
  ibRec: number;
}

export class BjtModel implements CompactModel {
  params: Readout[] = [];
  private prof: Profile1D;
  private eb: EdgeTable;
  private bc: EdgeTable;
  private cumGB: Float64Array;
  private cumGE: Float64Array;
  private cumGC: Float64Array;
  private cumQ: Float64Array;
  private aE: number;
  private aB: number;
  private blTop: number;
  private gBL: number;
  private rb: number;
  private rc: number;
  private re: number;
  private bvcbo: number;
  private ndC: number;
  private tauScr = 3e-8;
  private sign: number;
  private kIn: string[];

  constructor(def: DeviceDefinition, state: ProcessState) {
    this.sign = def.polarity;
    this.kIn = def.polarity === 1 ? ["VBE", "VCE"] : ["VEB", "VEC"];
    const g = def.geometry;
    const depth = def.domain.y1;
    this.prof = profileAt(state, g.cutX, depth, 2000);
    const p = this.prof;
    const js = junctionIndices(p);
    const jE = js[0];
    const jC = js[1];
    // collector epi doping = the minimum just below the BC junction (the buried layer up-diffuses into
    // the epi), buried-layer top = first point below it where the doping exceeds 10× that level
    const start = jC + Math.round(0.05 / p.dy);
    let epiIdx = start;
    for (let i = start; i < Math.min(p.y.length, jC + Math.round(1.2 / p.dy)); i += 1) {
      if (Math.abs(p.net[i]) < Math.abs(p.net[epiIdx])) epiIdx = i;
    }
    this.ndC = Math.abs(p.net[epiIdx]);
    let b = epiIdx;
    while (b < p.y.length - 1 && Math.abs(p.net[b]) < 10 * this.ndC) b += 1;
    this.blTop = p.y[b];
    this.eb = tabulateEdges(p, jE, -4, 1.05, 140, 0, jC - 1);
    this.bc = tabulateEdges(p, jC, -20, 0.95, 160, jE, b);
    const inv = (t: number, mob: (n: number) => number) => 1 / (VT * mob(t) * Math.exp(bandgapNarrowing(t) / VT));
    this.cumGB = cumulative(p, (i) => (i >= jE && i < jC ? Math.abs(p.net[i]) * inv(p.total[i], this.sign === 1 ? mobilityN : mobilityP) : 0));
    this.cumGE = cumulative(p, (i) => (i < jE ? Math.abs(p.net[i]) * inv(p.total[i], this.sign === 1 ? mobilityP : mobilityN) : 0));
    this.cumGC = cumulative(p, (i) => (i >= jC ? Math.abs(p.net[i]) * inv(p.total[i], this.sign === 1 ? mobilityP : mobilityN) : 0));
    this.cumQ = cumulative(p, (i) => (i >= jE && i < jC ? Math.abs(p.net[i]) : 0));
    const nBL = Math.abs(p.net[Math.min(b + 40, p.y.length - 1)]);
    const dBL = VT * (this.sign === 1 ? mobilityP(nBL) : mobilityN(nBL));
    const tBL = this.sign === 1 ? lifetimeP(nBL) : lifetimeN(nBL);
    this.gBL = (nBL * Math.sqrt(dBL * tBL)) / (dBL * Math.exp(bandgapNarrowing(nBL) / VT));

    this.aE = g.emitterArea * cm2;
    this.aB = g.baseArea * cm2;
    // parasitic resistances from the process sheet resistances
    const xjE = p.y[jE];
    const xjC = p.y[jC];
    const rsqBase = 1 / (Q * (this.sign === 1 ? mobilityP : mobilityN)(averageDoping(p, xjE, xjC)) * charge(p, xjE + 0.02, xjC - 0.03));
    const rsqExt = rsqBase * 0.35;
    this.rb = rsqBase * (g.emitterWidth / (3 * g.emitterLength)) + rsqExt * (g.baseContactGap / g.emitterLength) + 25;
    const spread = (g.emitterWidth + (this.blTop - xjC)) * (g.emitterLength + (this.blTop - xjC)) * cm2;
    this.rc = (resistivity(this.ndC, 0) * (this.blTop - xjC) * 1e-4) / spread + 25 * (g.sinkerDistance / 4.8) + 15;
    this.re = 4 + 2e-7 / this.aE;
    const bvPP = planarBreakdown(this.ndC);
    const wEpi = (this.blTop - xjC) * 1e-4;
    const vReach = (Q * this.ndC * wEpi * wEpi) / (2 * EPS0 * EPS_SI);
    this.bvcbo = Math.min(bvPP, vReach + 3e5 * wEpi * 0.9) * 0.85;

    const op = this.core(0.7, -2);
    const beta = op.it / (op.ib || 1);
    const tauF = this.tauF(op);
    const va = this.earlyVoltage();
    this.params = [
      { label: "发射区面积 A_E", value: `${g.emitterArea.toFixed(2)} μm²` },
      { label: "冶金基区宽度", value: `${((xjC - xjE) * 1000).toFixed(0)} nm` },
      { label: "基区 Gummel 数 G_B", value: `${interpCum(p, this.cumGB, xjC).toExponential(2)} s·cm⁻⁴` },
      { label: "发射区 Gummel 数 G_E", value: `${interpCum(p, this.cumGE, xjE).toExponential(2)} s·cm⁻⁴` },
      { label: "饱和电流 I_S", value: fmt((Q * this.aE * NI * NI) / (interpCum(p, this.cumGB, xjC) - 0), "A") },
      { label: "理想 β (V_BE = 0.7 V)", value: beta.toFixed(0) },
      { label: "Early 电压 V_A", value: `${va.toFixed(1)} V` },
      { label: "基区渡越时间 τ_F", value: fmt(tauF, "s") },
      { label: "集电区掺杂", value: `${this.ndC.toExponential(2)} cm⁻³` },
      { label: "BV_CBO (估算)", value: `${this.bvcbo.toFixed(1)} V` },
      { label: "r_B / r_C / r_E", value: `${this.rb.toFixed(0)} / ${this.rc.toFixed(0)} / ${this.re.toFixed(1)} Ω` }
    ];
  }

  private tauF(s: BjtState) {
    const nb = s.wb > 0 ? charge(this.prof, s.eR, s.cL) / (s.wb * 1e-4) : 1e17;
    const d = VT * (this.sign === 1 ? mobilityN(nb) : mobilityP(nb));
    return Math.pow(Math.max(s.wb, 0.005) * 1e-4, 2) / (2 * d);
  }

  private earlyVoltage() {
    const a = this.core(0.7, -1);
    const b = this.core(0.7, -3);
    const slope = (b.it - a.it) / 2;
    return slope > 0 ? a.it / slope - 1 : Infinity;
  }

  /** Intrinsic transistor currents for internal junction voltages (device polarity-normalised). */
  private core(vbe: number, vbc: number): BjtState {
    const p = this.prof;
    const [eL, eR] = lookupEdges(this.eb, vbe);
    const [cL, cR] = lookupEdges(this.bc, vbc);
    const wb = Math.max(cL - eR, 0.004);
    const gB = Math.max(interpCum(p, this.cumGB, cL) - interpCum(p, this.cumGB, eR), 1e3);
    const qB0 = Q * this.aE * Math.max(interpCum(p, this.cumQ, cL) - interpCum(p, this.cumQ, eR), 1e9);
    const is = (Q * this.aE * NI * NI) / gB;
    const ef = Math.exp(Math.min(vbe / VT, 80));
    const er = Math.exp(Math.min(vbc / VT, 80));
    const nb = qB0 / (Q * this.aE * wb * 1e-4);
    const dn = VT * (this.sign === 1 ? mobilityN(nb) : mobilityP(nb));
    const tauF = Math.pow(wb * 1e-4, 2) / (2 * dn);
    const ikf0 = qB0 / tauF;
    const vsat = 1e7;
    const ikirk = Q * this.aE * 2.2 * vsat * this.ndC * (1 + (2 * EPS0 * EPS_SI * Math.max(0.7 - vbc, 0.1)) / (Q * this.ndC * Math.pow((this.blTop - cL) * 1e-4, 2)));
    const ikf = 1 / (1 / ikf0 + 1 / ikirk);
    const q2 = (is * ef) / ikf + (is * er) / ikf0;
    const qb = 0.5 * (1 + Math.sqrt(1 + 4 * q2));
    let it = (is * (ef - er)) / qb;
    // BC avalanche multiplication
    const vcb = -vbc;
    const m = vcb > 0 ? 1 / (1 - Math.pow(Math.min(vcb / this.bvcbo, 0.97), 4)) : 1;
    const gE = Math.max(interpCum(p, this.cumGE, eL), 1e3);
    const ibe = ((Q * this.aE * NI * NI) / gE) * (ef - 1);
    const tauN = this.sign === 1 ? lifetimeN(nb) : lifetimeP(nb);
    const ibRec = (Math.max(it, 0) * tauF) / tauN;
    const ibScr = ((Q * this.aE * NI * (eR - eL) * 1e-4) / (2 * this.tauScr)) * (vbe > 0 ? Math.exp(vbe / (2 * VT)) - 1 : -1);
    const gC = Math.max(interpCum(p, this.cumGC, this.blTop) - interpCum(p, this.cumGC, cR), 1e3) + this.gBL;
    const ibc = ((Q * this.aB * NI * NI) / gC) * (er - 1);
    const ibcScr = ((Q * this.aB * NI * (cR - cL) * 1e-4) / (2 * this.tauScr)) * (vbc > 0 ? Math.exp(vbc / (2 * VT)) - 1 : -1);
    const icbo = ibc + ibcScr;
    const itM = it * m;
    const ic = itM - icbo * m;
    const ib = ibe + ibRec + ibScr + icbo * m - (m - 1) * it;
    it = itM;
    const n0 = ((NI * NI) / Math.max(nb, 1)) * ef;
    return { ic, ib, ie: -(ic + ib), it, vbe, vbc, wb, eR, cL, cR, eL, qb, n0, ibRec };
  }

  /** Solve the internal node voltages with r_B, r_C, r_E for external VBE/VCE (polarity-normalised). */
  solve(vbeExt: number, vceExt: number) {
    let x1 = Math.min(vbeExt, 0.85);
    let x2 = Math.min(vbeExt - vceExt, 0.8);
    const resid = (a: number, b: number) => {
      const s = this.core(a, b);
      const ie = s.ic + s.ib;
      return [a - (vbeExt - s.ib * this.rb - ie * this.re), a - b - (vceExt - s.ic * this.rc - ie * this.re), s] as const;
    };
    for (let it = 0; it < 60; it += 1) {
      const [f1, f2] = resid(x1, x2);
      if (Math.abs(f1) < 1e-9 && Math.abs(f2) < 1e-9) break;
      const h = 1e-6;
      const [a1, a2] = resid(x1 + h, x2);
      const [b1, b2] = resid(x1, x2 + h);
      const j11 = (a1 - f1) / h;
      const j21 = (a2 - f2) / h;
      const j12 = (b1 - f1) / h;
      const j22 = (b2 - f2) / h;
      const det = j11 * j22 - j12 * j21;
      if (!isFinite(det) || Math.abs(det) < 1e-18) break;
      let d1 = (-f1 * j22 + f2 * j12) / det;
      let d2 = (-f2 * j11 + f1 * j21) / det;
      const lim = 0.08;
      const sc = Math.max(Math.abs(d1), Math.abs(d2)) > lim ? lim / Math.max(Math.abs(d1), Math.abs(d2)) : 1;
      d1 *= sc;
      d2 *= sc;
      x1 += d1;
      x2 += d2;
    }
    return this.core(x1, x2);
  }

  private ibFromVbe(vbe: number, vce: number) {
    return this.solve(vbe, vce).ib;
  }

  private vbeForIb(ib: number, vce: number) {
    let lo = 0.2;
    let hi = 1.3;
    for (let it = 0; it < 48; it += 1) {
      const mid = 0.5 * (lo + hi);
      if (this.ibFromVbe(mid, vce) > ib) hi = mid;
      else lo = mid;
    }
    return 0.5 * (lo + hi);
  }

  evaluate(bias: Record<string, number>): OperatingPoint {
    const [kb, kc] = this.kIn;
    const vbe = bias[kb];
    const vce = bias[kc];
    const s = this.solve(vbe, vce);
    const beta = s.ic / s.ib;
    const d = 1e-4;
    const gm = (this.solve(vbe + d, vce).ic - s.ic) / d;
    const go = (this.solve(vbe, vce + 0.01).ic - s.ic) / 0.01;
    const tauF = this.tauF(s);
    const cje = (EPS0 * EPS_SI * this.aE) / (Math.max(s.eR - s.eL, 0.005) * 1e-4);
    const cjc = (EPS0 * EPS_SI * this.aB) / (Math.max(s.cR - s.cL, 0.005) * 1e-4);
    const cpi = tauF * gm + cje;
    const ft = gm / (2 * Math.PI * (cpi + cjc));
    let region: string;
    let tone: OperatingPoint["tone"];
    if (s.vbe < 0.45 && s.vbc < 0.45) {
      region = "截止区：两结均未导通";
      tone = "off";
    } else if (s.vbc > 0.5 && s.vbe > 0.5) {
      region = "饱和区：两结均正偏";
      tone = "mid";
    } else if (s.vbc > 0.45) {
      region = "反向放大区";
      tone = "warn";
    } else if (s.vbc > 0.2) {
      region = "准饱和：集电区串阻压降";
      tone = "mid";
    } else {
      region = "正向放大区：发射结正偏、集电结反偏";
      tone = "on";
    }
    const sg = this.sign;
    const names = sg === 1 ? { be: "V_B′E′", bc: "V_B′C′", ic: "I_C", ib: "I_B" } : { be: "V_E′B′", bc: "V_C′B′", ic: "I_C", ib: "I_B" };
    return {
      region,
      tone,
      terminals: sg === 1 ? { E: 0, B: s.vbe, C: s.vbe - s.vbc, S: 0 } : { E: 0, B: -s.vbe, C: -(s.vbe - s.vbc), S: 0 },
      values: {
        ic: s.ic,
        ib: s.ib,
        beta,
        gm,
        vbe: s.vbe,
        vbc: s.vbc,
        wb: s.wb,
        eL: s.eL,
        eR: s.eR,
        cL: s.cL,
        cR: s.cR,
        n0: s.n0,
        ft,
        ibRec: s.ibRec,
        blTop: this.blTop,
        tauF
      },
      readouts: [
        { label: `集电极电流 ${names.ic}`, value: fmt(s.ic, "A") },
        { label: `基极电流 ${names.ib}`, value: fmt(s.ib, "A") },
        { label: "电流增益 β = I_C/I_B", value: isFinite(beta) && beta > 0 ? beta.toFixed(1) : "—" },
        { label: `内部结电压 ${names.be}`, value: `${s.vbe.toFixed(3)} V` },
        { label: `内部结电压 ${names.bc}`, value: `${s.vbc.toFixed(3)} V` },
        { label: "中性基区宽度 W_B", value: `${(s.wb * 1000).toFixed(0)} nm` },
        { label: "基区注入少子 n(0)", value: `${s.n0.toExponential(2)} cm⁻³` },
        { label: "跨导 g_m", value: fmt(gm, "S") },
        { label: "输出电阻 r_o", value: go > 0 ? fmt(1 / go, "Ω") : "—" },
        { label: "特征频率 f_T", value: fmt(ft, "Hz") }
      ]
    };
  }

  curves(bias: Record<string, number>): CurveView[] {
    const [kb, kc] = this.kIn;
    const sg = this.sign;
    const vceOp = bias[kc];
    const vbeOp = bias[kb];
    const op = this.solve(vbeOp, vceOp);
    // choose I_B steps from the transistor itself
    const ibTop = this.solve(0.84, 3).ib;
    const step = niceStep(ibTop / 5);
    const vces = linspace(0, 6, 90);
    const fam: CurveSeries[] = [];
    for (let k = 1; k <= 5; k += 1) {
      const ib = step * k;
      fam.push({
        label: `I_B = ${fmt(ib, "A", 2)}`,
        x: vces,
        y: vces.map((v) => this.solve(this.vbeForIb(ib, v), v).ic)
      });
    }
    fam.push({ label: "工作点曲线", x: vces, y: vces.map((v) => this.solve(vbeOp, v).ic), emphasis: true });
    const vbes = linspace(0.3, 0.98, 120);
    const gum = vbes.map((v) => this.solve(v, vceOp));
    const icName = sg === 1 ? "V_CE" : "V_EC";
    const beName = sg === 1 ? "V_BE" : "V_EB";
    return [
      {
        id: "out",
        short: "输出",
        title: "输出特性 I_C–" + icName,
        xLabel: icName,
        yLabel: "I_C",
        xUnit: "V",
        yUnit: "A",
        yScale: "lin",
        series: fam,
        marker: { x: vceOp, y: op.ic },
        xBias: kc,
        bands: [
          { from: 0, to: 0.35, label: "饱和", tone: "mid" },
          { from: 0.35, to: 6, label: "放大", tone: "on" }
        ]
      },
      {
        id: "gummel",
        short: "Gummel",
        title: "Gummel 图",
        xLabel: beName,
        yLabel: "I_C, I_B",
        xUnit: "V",
        yUnit: "A",
        yScale: "log",
        series: [
          { label: "I_C", x: vbes, y: gum.map((s) => Math.max(s.ic, 1e-16)), emphasis: true },
          { label: "I_B", x: vbes, y: gum.map((s) => Math.max(s.ib, 1e-16)) }
        ],
        marker: { x: vbeOp, y: Math.max(op.ic, 1e-16) },
        xBias: kb
      },
      {
        id: "beta",
        short: "β",
        title: "β – I_C",
        xLabel: beName,
        yLabel: "β",
        xUnit: "V",
        yUnit: "",
        yScale: "lin",
        series: [{ label: "β", x: vbes, y: gum.map((s) => (s.ib > 0 ? s.ic / s.ib : 0)), emphasis: true }],
        marker: { x: vbeOp, y: op.ib > 0 ? op.ic / op.ib : 0 },
        xBias: kb
      }
    ];
  }
}

function niceStep(v: number) {
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / e;
  const n = m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10;
  return n * e;
}

/* ------------------------------------------------------------------------------------------------ */
/*  MOSFET (EKV)                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

export class MosModel implements CompactModel {
  params: Readout[] = [];
  private cox: number;
  private na: number;
  private phiF: number;
  private vfb: number;
  private gamma: number;
  private phi0: number;
  private vt0: number;
  private mu0: number;
  private theta: number;
  private leff: number;
  private w: number;
  private sigma: number;
  private ec: number;
  private xs: number;
  private xd: number;
  private sign: number;
  private keys: string[];
  /** pseudo-2-D characteristic length of the velocity-saturated drain region (cm) */
  private lChar: number;

  constructor(def: DeviceDefinition, state: ProcessState) {
    this.sign = def.polarity;
    this.keys = def.polarity === 1 ? ["VGS", "VDS", "VBS"] : ["VSG", "VSD", "VSB"];
    const sd = profileAt(state, 0.8, 1.0, 800);
    const js = junctionIndices(sd);
    const xj = js.length ? sd.y[js[0]] : 0.15;
    this.lChar = 0.5 * Math.sqrt((EPS_SI / EPS_OX) * state.params.tox * xj) * 1e-4;
    const tox = state.params.tox * 1e-4;
    this.cox = (EPS0 * EPS_OX) / tox;
    const prof = profileAt(state, def.geometry.cutX, 1.0, 1000);
    // effective channel doping averaged over the maximum depletion depth (iterate once)
    let na = averageDoping(prof, 0, 0.1);
    for (let it = 0; it < 4; it += 1) {
      const phiF = VT * Math.log(na / NI);
      const wd = Math.sqrt((4 * EPS0 * EPS_SI * phiF) / (Q * na)) * 1e4;
      na = averageDoping(prof, 0, wd);
    }
    this.na = na;
    this.phiF = VT * Math.log(na / NI);
    this.vfb = -(0.56 + this.phiF);
    this.gamma = Math.sqrt(2 * Q * EPS0 * EPS_SI * na) / this.cox;
    this.phi0 = 2 * this.phiF + 4 * VT;
    this.vt0 = this.vfb + 2 * this.phiF + this.gamma * Math.sqrt(2 * this.phiF);
    this.mu0 = 0.62 * (this.sign === 1 ? mobilityN(na) : mobilityP(na));
    this.theta = 0.0008 / state.params.tox;
    this.leff = state.params.leff;
    this.xs = state.params.xs;
    this.xd = state.params.xd;
    this.w = def.geometry.width;
    this.sigma = 0.012 / this.leff;
    this.ec = (2 * 1e7) / this.mu0;
    const n0 = 1 + this.gamma / (2 * Math.sqrt(this.phi0));
    this.params = [
      { label: "栅氧厚度 t_ox", value: `${(state.params.tox * 1000).toFixed(2)} nm` },
      { label: "栅电容 C_ox", value: `${(this.cox * 1e7).toFixed(2)} fF/μm²` },
      { label: "沟道有效掺杂", value: `${na.toExponential(2)} cm⁻³` },
      { label: "费米势 φ_F", value: `${this.phiF.toFixed(3)} V` },
      { label: "平带电压 V_FB", value: `${(this.sign * this.vfb).toFixed(3)} V` },
      { label: "阈值电压 V_T0", value: `${(this.sign * this.vt0).toFixed(3)} V` },
      { label: "体效应系数 γ", value: `${this.gamma.toFixed(3)} V^½` },
      { label: "亚阈斜率 SS", value: `${(n0 * VT * Math.log(10) * 1000).toFixed(0)} mV/dec` },
      { label: "有效迁移率 μ₀", value: `${this.mu0.toFixed(0)} cm²/V·s` },
      { label: "W / L_eff", value: `${this.w.toFixed(1)} μm / ${(this.leff * 1000).toFixed(0)} nm` }
    ];
  }

  private static F(v: number) {
    const l = v > 40 ? v / 2 : Math.log1p(Math.exp(v / 2));
    return l * l;
  }

  private static Finv(f: number) {
    const s = Math.sqrt(Math.max(f, 1e-300));
    return s > 20 ? 2 * s : 2 * Math.log(Math.expm1(s));
  }

  private pinchoff(vgb: number) {
    const a = Math.sqrt(this.phi0) + this.gamma / 2;
    const arg = vgb - this.vt0 + a * a;
    if (arg <= 0) return -this.phi0;
    return vgb - this.vt0 - this.gamma * (Math.sqrt(arg) - a);
  }

  /** Normalised-voltage core: all voltages NMOS-equivalent, referred to source. */
  core(vgs: number, vds: number, vbs: number) {
    const vgb = vgs - vbs + this.sigma * vds;
    const vsb = -vbs;
    const vdb = vds - vbs;
    const vp = this.pinchoff(vgb);
    const n = 1 + this.gamma / (2 * Math.sqrt(Math.max(this.phi0 + vp, 0.05)));
    const vt = this.vt0 + this.gamma * (Math.sqrt(this.phi0 + vsb) - Math.sqrt(this.phi0)) - this.sigma * vds;
    const vov = Math.max(vgs - vt, 0);
    const mu = this.mu0 / (1 + this.theta * vov);
    const beta = (mu * this.cox * this.w) / this.leff;
    const is = 2 * n * beta * VT * VT;
    const iff = MosModel.F((vp - vsb) / VT);
    // saturation voltage: long-channel (EKV) value combined with velocity saturation
    const vdsatLong = 2 * VT * Math.sqrt(iff) + 3 * VT;
    const ecl = this.ec * this.leff * 1e-4;
    const vdsat = 1 / (1 / vdsatLong + 1 / ecl);
    const vdsEff = vds / Math.pow(1 + Math.pow(vds / vdsat, 6), 1 / 6);
    const ir = MosModel.F((vp - vsb - vdsEff) / VT);
    const vsatFactor = 1 + vdsEff / ecl;
    const over = Math.max(vds - vdsEff, 0);
    // channel-length modulation from the pseudo-2-D velocity-saturation region length ΔL
    const deltaL = Math.min(this.lChar * Math.log1p(over / (this.ec * this.lChar)), 0.6 * this.leff * 1e-4);
    const clm = 1 / (1 - deltaL / (this.leff * 1e-4));
    const id = ((is * (iff - ir)) / vsatFactor) * clm;
    return { id, vp, n, vt, vdsat, iff, ir, mu, vsb, vdb, vdsEff, deltaL: deltaL * 1e4 };
  }

  /**
   * Channel quasi-Fermi potential φ(x), absolute (NMOS-equivalent, source = 0): gradual-channel (EKV)
   * solution from the source to the pinch-off point, then the pseudo-2-D sinh ramp up to the drain.
   */
  private channel(vgs: number, vds: number, vbs: number) {
    const c = this.core(vgs, vds, vbs);
    const vdEffB = c.vdsEff - vbs;
    const fs = MosModel.F((c.vp - c.vsb) / VT);
    const fd = MosModel.F((c.vp - vdEffB) / VT);
    const xp = this.xd - c.deltaL;
    const L = xp - this.xs;
    const l = this.lChar * 1e4;
    const vAtPinch = Math.min(c.vp - VT * MosModel.Finv(fd), vdEffB) + vbs;
    return (x: number) => {
      if (x <= xp || c.deltaL <= 1e-6) {
        const t = Math.min(Math.max((x - this.xs) / L, 0), 1);
        const f = fs - (fs - fd) * t;
        const vbody = c.vp - VT * MosModel.Finv(f);
        return Math.min(vbody, vdEffB) + vbs;
      }
      const r = Math.sinh(Math.min(x - xp, c.deltaL) / l) / Math.sinh(c.deltaL / l);
      return vAtPinch + (vds - vAtPinch) * r;
    };
  }

  evaluate(bias: Record<string, number>): OperatingPoint {
    const [kg, kd, kb] = this.keys;
    const vgs = bias[kg];
    const vds = bias[kd];
    const vbs = bias[kb];
    const c = this.core(vgs, vds, vbs);
    const d = 1e-3;
    const gm = (this.core(vgs + d, vds, vbs).id - c.id) / d;
    const gds = (this.core(vgs, vds + d, vbs).id - c.id) / d;
    const ch = this.channel(vgs, vds, vbs);
    let region: string;
    let tone: OperatingPoint["tone"];
    if (vgs < c.vt - 0.08) {
      region = "亚阈值区：弱反型，扩散电流";
      tone = "off";
    } else if (vgs < c.vt + 0.1) {
      region = "中等反型：阈值附近";
      tone = "mid";
    } else if (vds < c.vdsat) {
      region = "线性区：沟道连续";
      tone = "mid";
    } else {
      region = "饱和区：漏端夹断";
      tone = "on";
    }
    const sg = this.sign;
    // pinch-off position: start of the velocity-saturated drain region
    const xPinch = vds > c.vdsat && vgs > c.vt && c.deltaL > 1e-4 ? this.xd - c.deltaL : NaN;
    const phi = sg === 1 ? ch : (x: number) => -ch(x);
    return {
      region,
      tone,
      terminals: sg === 1 ? { S: 0, D: vds, G: vgs, B: vbs } : { S: 0, D: -vds, G: -vgs, B: -vbs },
      channelPhi: phi,
      values: { id: c.id, vt: c.vt, vdsat: c.vdsat, gm, gds, xPinch, xs: this.xs, xd: this.xd, n: c.n },
      readouts: [
        { label: sg === 1 ? "漏极电流 I_D" : "漏极电流 |I_D|", value: fmt(c.id, "A") },
        { label: "阈值电压 V_T (含体效应, DIBL)", value: `${(sg * c.vt).toFixed(3)} V` },
        { label: "过驱动电压 V_GS − V_T", value: `${(vgs - c.vt).toFixed(3)} V` },
        { label: "饱和电压 V_Dsat", value: `${c.vdsat.toFixed(3)} V` },
        { label: "跨导 g_m", value: fmt(gm, "S") },
        { label: "输出电导 g_ds", value: fmt(gds, "S") },
        { label: "本征增益 g_m/g_ds", value: gds > 0 ? (gm / gds).toFixed(1) : "—" },
        { label: "g_m / I_D", value: c.id > 0 ? `${(gm / c.id).toFixed(1)} V⁻¹` : "—" },
        { label: "夹断区长度 ΔL", value: isFinite(xPinch) ? `${(c.deltaL * 1000).toFixed(0)} nm` : "未夹断" },
        { label: "有效迁移率 μ_eff", value: `${c.mu.toFixed(0)} cm²/V·s` }
      ]
    };
  }

  curves(bias: Record<string, number>): CurveView[] {
    const [kg, kd, kb] = this.keys;
    const vgsOp = bias[kg];
    const vdsOp = bias[kd];
    const vbs = bias[kb];
    const vdss = linspace(0, 3.3, 100);
    const steps = [1.0, 1.5, 2.0, 2.5, 3.0, 3.3];
    const fam: CurveSeries[] = steps.map((vg) => ({ label: `${kg.replace("V", "V_")} = ${vg.toFixed(1)} V`, x: vdss, y: vdss.map((v) => this.core(vg, v, vbs).id) }));
    fam.push({ label: "工作点曲线", x: vdss, y: vdss.map((v) => this.core(vgsOp, v, vbs).id), emphasis: true });
    const vdsatLine = linspace(0.3, 3.3, 40).map((vg) => {
      const c = this.core(vg, 3.3, vbs);
      return [Math.min(c.vdsat, 3.3), this.core(vg, c.vdsat, vbs).id] as const;
    });
    fam.push({ label: "V_Dsat 轨迹", x: vdsatLine.map((p) => p[0]), y: vdsatLine.map((p) => p[1]) });
    const vgss = linspace(-0.3, 3.3, 160);
    const op = this.core(vgsOp, vdsOp, vbs);
    const gName = kg.replace("V", "V_");
    const dName = kd.replace("V", "V_");
    return [
      {
        id: "out",
        short: "输出",
        title: "输出特性 I_D–" + dName,
        xLabel: dName,
        yLabel: "I_D",
        xUnit: "V",
        yUnit: "A",
        yScale: "lin",
        series: fam,
        marker: { x: vdsOp, y: op.id },
        xBias: kd
      },
      {
        id: "transfer",
        short: "转移 log",
        title: "转移特性 (半对数)",
        xLabel: gName,
        yLabel: "I_D",
        xUnit: "V",
        yUnit: "A",
        yScale: "log",
        series: [
          { label: `${dName} = ${vdsOp.toFixed(2)} V`, x: vgss, y: vgss.map((v) => Math.max(this.core(v, vdsOp, vbs).id, 1e-16)), emphasis: true },
          { label: `${dName} = 0.05 V`, x: vgss, y: vgss.map((v) => Math.max(this.core(v, 0.05, vbs).id, 1e-16)) }
        ],
        marker: { x: vgsOp, y: Math.max(op.id, 1e-16) },
        xBias: kg,
        bands: [
          { from: -0.3, to: op.vt, label: "亚阈值", tone: "off" },
          { from: op.vt, to: 3.3, label: "强反型", tone: "on" }
        ]
      },
      {
        id: "transferLin",
        short: "转移 lin",
        title: "转移特性 (线性)",
        xLabel: gName,
        yLabel: "I_D",
        xUnit: "V",
        yUnit: "A",
        yScale: "lin",
        series: [{ label: `${dName} = ${vdsOp.toFixed(2)} V`, x: vgss, y: vgss.map((v) => this.core(v, vdsOp, vbs).id), emphasis: true }],
        marker: { x: vgsOp, y: op.id },
        xBias: kg
      }
    ];
  }
}

export function createCompactModel(def: DeviceDefinition, state: ProcessState): CompactModel {
  if (def.family === "diode") return new DiodeModel(def, state);
  if (def.family === "bjt") return new BjtModel(def, state);
  return new MosModel(def, state);
}
