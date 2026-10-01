/**
 * Analytic process simulator.
 *
 * Doping is modelled the way a first-order process simulator (SUPREM-I style) would:
 *  - ion implants are Gaussian in depth (LSS Rp / ΔRp tables) with an erf lateral edge at mask openings,
 *  - every thermal step adds D(T)·t per dopant species; profiles broaden as σ² = ΔRp² + 2Dt,
 *  - substrate / epitaxial background doping out-diffuses across the epi interface (erfc),
 *  - thermal oxidation follows the Deal–Grove linear-parabolic law.
 *
 * Geometry is in μm: x lateral, y depth (positive into silicon, surface at 0), z along device width.
 */
import { KB_EV, erf, erfc, mobilityN, mobilityP, Q } from "./constants";

export type Species = "B" | "P" | "As" | "Sb";
export const isDonor: Record<Species, boolean> = { B: false, P: true, As: true, Sb: true };
export const speciesName: Record<Species, string> = { B: "硼 B", P: "磷 P", As: "砷 As", Sb: "锑 Sb" };

/** Intrinsic diffusivity prefactor (cm²/s) and activation energy (eV). */
const DIFFUSIVITY: Record<Species, { d0: number; ea: number }> = {
  B: { d0: 0.76, ea: 3.46 },
  P: { d0: 3.85, ea: 3.66 },
  As: { d0: 0.066, ea: 3.44 },
  Sb: { d0: 0.214, ea: 3.65 }
};

/** Diffusivity in μm²/s at temperature tC (°C). */
export function diffusivity(species: Species, tC: number) {
  const { d0, ea } = DIFFUSIVITY[species];
  return d0 * Math.exp(-ea / (KB_EV * (tC + 273.15))) * 1e8;
}

/** LSS projected range tables: energy keV -> [Rp μm, ΔRp μm]. */
const RANGE_TABLE: Record<Species, Array<[number, number, number]>> = {
  B: [
    [5, 0.0182, 0.0104],
    [10, 0.0333, 0.0171],
    [20, 0.0662, 0.0283],
    [30, 0.0987, 0.0371],
    [50, 0.1609, 0.0504],
    [80, 0.2474, 0.0653],
    [100, 0.3007, 0.0729],
    [150, 0.4213, 0.0869],
    [200, 0.5291, 0.0971],
    [400, 0.892, 0.118]
  ],
  P: [
    [10, 0.0139, 0.0069],
    [20, 0.0253, 0.0119],
    [30, 0.0368, 0.0166],
    [50, 0.0607, 0.0256],
    [80, 0.0976, 0.0381],
    [100, 0.1238, 0.0462],
    [150, 0.1887, 0.0648],
    [200, 0.2539, 0.0809],
    [400, 0.505, 0.126]
  ],
  As: [
    [10, 0.0097, 0.0036],
    [20, 0.0159, 0.0059],
    [30, 0.0215, 0.008],
    [50, 0.0322, 0.0118],
    [80, 0.048, 0.0172],
    [100, 0.0582, 0.0207],
    [150, 0.0838, 0.0288],
    [200, 0.1087, 0.0363]
  ],
  Sb: [
    [20, 0.0132, 0.0045],
    [50, 0.0262, 0.0086],
    [100, 0.0444, 0.0142],
    [150, 0.0618, 0.0192],
    [200, 0.0786, 0.0238]
  ]
};

export function implantRange(species: Species, energyKeV: number): [number, number] {
  const table = RANGE_TABLE[species];
  const le = Math.log(energyKeV);
  if (energyKeV <= table[0][0]) {
    const s = energyKeV / table[0][0];
    return [table[0][1] * s, table[0][2] * s];
  }
  for (let i = 1; i < table.length; i += 1) {
    if (energyKeV <= table[i][0]) {
      const [e0, r0, d0] = table[i - 1];
      const [e1, r1, d1] = table[i];
      const f = (le - Math.log(e0)) / (Math.log(e1) - Math.log(e0));
      return [Math.exp(Math.log(r0) + f * (Math.log(r1) - Math.log(r0))), Math.exp(Math.log(d0) + f * (Math.log(d1) - Math.log(d0)))];
    }
  }
  const last = table[table.length - 1];
  const s = energyKeV / last[0];
  return [last[1] * s, last[2] * Math.sqrt(s)];
}

/**
 * Thermal oxide thickness (μm) grown on <100> Si.
 * Wet: Deal–Grove linear-parabolic law. Dry: Deal–Grove plus Massoud's thin-regime term
 * dx/dt = B/(2x+A) + C·exp(-x/L), which captures the fast initial growth of gate oxides.
 */
export function dealGrove(ambient: "dry" | "wet", tC: number, minutes: number, initialUm = 0.001) {
  const kT = KB_EV * (tC + 273.15);
  const hours = minutes / 60;
  if (ambient === "wet") {
    const B = 386 * Math.exp(-0.78 / kT);
    const BA = (1.63e8 * Math.exp(-2.05 / kT)) / 1.68;
    const A = B / BA;
    const tau = (initialUm * initialUm + A * initialUm) / B;
    return (-A + Math.sqrt(A * A + 4 * B * (hours + tau))) / 2;
  }
  const B = 772 * Math.exp(-1.23 / kT);
  const BA = (6.23e6 * Math.exp(-2.0 / kT)) / 1.68;
  const A = B / BA;
  const C = 3.6e8 * Math.exp(-2.35 / kT);
  const L = 0.007;
  let x = initialUm;
  const steps = 400;
  const dt = hours / steps;
  for (let i = 0; i < steps; i += 1) {
    x += dt * (B / (2 * x + A) + C * Math.exp(-x / L));
  }
  return x;
}

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface Prism {
  /** Cross-section polygon in (x, y) μm; y is depth (negative above the silicon surface). */
  poly: Array<[number, number]>;
  z0: number;
  z1: number;
}

export type MaterialKey =
  | "oxide"
  | "thermalOxide"
  | "nitride"
  | "poly"
  | "polyP"
  | "resist"
  | "resistExposed"
  | "silicide"
  | "tungsten"
  | "aluminum"
  | "backMetal"
  | "passivation"
  | "bpsg";

export interface Layer {
  id: string;
  material: MaterialKey;
  prisms: Prism[];
  name: string;
}

interface ImplantRecord {
  species: Species;
  dose: number; // cm^-2
  rp: number; // μm
  drp: number; // μm
  lateral: number; // μm
  openings: Rect[];
  surface: number; // y of the silicon surface at implant time (final coordinates)
  reflect: boolean;
  dt: number; // accumulated D·t, μm²
  /** D·t at the moment the implant was buried by epitaxy (null while at the surface) */
  buriedAt: number | null;
}

export interface TrenchBox {
  fill: "oxide" | "void";
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

export type StepAnimation =
  | { kind: "implant"; species: Species; energy: number; dose: number; openings: Rect[]; tilt?: number }
  | { kind: "litho"; openings: Rect[]; resistId: string }
  | { kind: "anneal"; tC: number; minutes: number }
  | { kind: "grow" }
  | { kind: "deposit" }
  | { kind: "etch" }
  | { kind: "cmp" }
  | { kind: "epi" }
  | { kind: "none" };

export interface BackgroundSpec {
  species: Species;
  conc: number;
}

export class ProcessState {
  siliconTop = 0;
  substrate: BackgroundSpec = { species: "B", conc: 1e15 };
  epi: (BackgroundSpec & { thickness: number }) | null = null;
  implants: ImplantRecord[] = [];
  epiDt: Record<Species, number> = { B: 0, P: 0, As: 0, Sb: 0 };
  trenches: TrenchBox[] = [];
  layers = new Map<string, Layer>();
  anim: StepAnimation = { kind: "none" };
  results: Array<[string, string]> = [];
  params: Record<string, number> = {};
  history: Array<{ step: number; results: Array<[string, string]> }> = [];
  heat = 0;

  setSubstrate(species: Species, conc: number, epiThickness = 0) {
    this.substrate = { species, conc };
    this.siliconTop = epiThickness;
  }

  growEpi(species: Species, conc: number, thickness: number, tC: number, minutes: number) {
    for (const imp of this.implants) if (imp.buriedAt === null) imp.buriedAt = imp.dt;
    this.epi = { species, conc, thickness };
    this.siliconTop = 0;
    this.anneal(tC, minutes);
    this.anim = { kind: "epi" };
  }

  implant(species: Species, energyKeV: number, dose: number, openings: Rect[], opts: { rp?: number; drp?: number; tilt?: number } = {}) {
    const [rp0, drp0] = implantRange(species, energyKeV);
    const rp = opts.rp ?? rp0;
    const drp = opts.drp ?? drp0;
    this.implants.push({
      species,
      dose,
      rp,
      drp,
      lateral: drp * 0.75,
      openings,
      surface: this.siliconTop,
      reflect: true,
      dt: 0,
      buriedAt: null
    });
    this.anim = { kind: "implant", species, energy: energyKeV, dose, openings, tilt: opts.tilt };
  }

  anneal(tC: number, minutes: number, fraction = 1) {
    const seconds = minutes * 60 * fraction;
    for (const imp of this.implants) {
      imp.dt += diffusivity(imp.species, tC) * seconds;
    }
    if (this.epi) {
      (Object.keys(this.epiDt) as Species[]).forEach((s) => {
        this.epiDt[s] += diffusivity(s, tC) * seconds;
      });
    }
    this.heat = tC;
    this.anim = { kind: "anneal", tC, minutes };
  }

  addLayer(layer: Layer) {
    this.layers.set(layer.id, layer);
  }

  removeLayer(id: string) {
    this.layers.delete(id);
  }

  addTrench(box: TrenchBox) {
    this.trenches.push(box);
  }

  /** 0 = silicon, 1 = embedded oxide, 2 = void (etched, unfilled), 3 = above the silicon surface. */
  materialAt(x: number, y: number, z: number) {
    if (y < this.siliconTop) return 3;
    for (const t of this.trenches) {
      if (x >= t.x0 && x <= t.x1 && y >= t.y0 && y <= t.y1 && z >= t.z0 && z <= t.z1) return t.fill === "oxide" ? 1 : 2;
    }
    return 0;
  }

  isSilicon(x: number, y: number, z: number) {
    return this.materialAt(x, y, z) === 0;
  }

  fillTrenches() {
    this.trenches.forEach((t) => {
      t.fill = "oxide";
    });
  }

  /** Donor and acceptor concentration (cm^-3) at a point. */
  doping(x: number, y: number, z: number, out: { nd: number; na: number }) {
    let nd = 0;
    let na = 0;
    const add = (species: Species, value: number) => {
      if (isDonor[species]) nd += value;
      else na += value;
    };

    if (this.epi) {
      const yi = this.epi.thickness;
      const subSpread = 2 * Math.sqrt(Math.max(this.epiDt[this.substrate.species], 1e-8));
      const epiSpread = 2 * Math.sqrt(Math.max(this.epiDt[this.epi.species], 1e-8));
      add(this.substrate.species, 0.5 * this.substrate.conc * erfc((yi - y) / subSpread));
      add(this.epi.species, 0.5 * this.epi.conc * erfc((y - yi) / epiSpread));
    } else {
      add(this.substrate.species, this.substrate.conc);
    }

    for (const imp of this.implants) {
      const d = y - imp.surface;
      let sigma: number;
      let vertical: number;
      if (imp.buriedAt === null) {
        // surface implant: Gaussian with a reflecting (no out-diffusion) surface
        sigma = Math.sqrt(imp.drp * imp.drp + 2 * imp.dt);
        if (d < -0.02) continue;
        const g1 = (d - imp.rp) / sigma;
        if (g1 > 7) continue;
        vertical = Math.exp(-0.5 * g1 * g1);
        if (imp.reflect) {
          const g2 = (d + imp.rp) / sigma;
          vertical += Math.exp(-0.5 * g2 * g2);
        }
      } else {
        // buried by epitaxy: the half-Gaussian left at the old surface keeps diffusing into the epi
        // (exact convolution of a reflected Gaussian with the post-epi diffusion kernel)
        const sPre2 = imp.drp * imp.drp + 2 * imp.buriedAt;
        const sPost = Math.sqrt(Math.max(2 * (imp.dt - imp.buriedAt), 1e-10));
        sigma = Math.sqrt(sPre2 + sPost * sPost);
        const g1 = (d - imp.rp) / sigma;
        if (Math.abs(g1) > 7) continue;
        vertical = Math.exp(-0.5 * g1 * g1) * (1 + erf((d * Math.sqrt(sPre2)) / (Math.SQRT2 * sPost * sigma)));
      }
      if (vertical < 1e-12) continue;
      const peak = (imp.dose / (Math.sqrt(2 * Math.PI) * sigma * 1e-4)) * vertical;
      const sl = Math.sqrt(imp.lateral * imp.lateral + 2 * imp.dt) * Math.SQRT2;
      let lateral = 0;
      for (const o of imp.openings) {
        const fx = 0.5 * (erf((x - o.x0) / sl) - erf((x - o.x1) / sl));
        if (fx < 1e-9) continue;
        const fz = 0.5 * (erf((z - o.z0) / sl) - erf((z - o.z1) / sl));
        lateral += fx * fz;
      }
      if (lateral > 0) add(imp.species, peak * Math.min(lateral, 1));
    }

    out.nd = nd;
    out.na = na;
    return out;
  }

  net(x: number, y: number, z: number) {
    const o = this.doping(x, y, z, { nd: 0, na: 0 });
    return o.nd - o.na;
  }
}

export interface DepthProfile {
  y: Float64Array;
  nd: Float64Array;
  na: Float64Array;
}

export function depthProfile(state: ProcessState, x: number, z: number, y0: number, y1: number, count = 600): DepthProfile {
  const y = new Float64Array(count);
  const nd = new Float64Array(count);
  const na = new Float64Array(count);
  const tmp = { nd: 0, na: 0 };
  for (let i = 0; i < count; i += 1) {
    const yy = y0 + ((y1 - y0) * i) / (count - 1);
    y[i] = yy;
    if (!state.isSilicon(x, yy, z)) continue;
    state.doping(x, yy, z, tmp);
    nd[i] = tmp.nd;
    na[i] = tmp.na;
  }
  return { y, nd, na };
}

/** Depths where the net doping changes sign. */
export function findJunctions(profile: DepthProfile) {
  const out: number[] = [];
  for (let i = 1; i < profile.y.length; i += 1) {
    const a = profile.nd[i - 1] - profile.na[i - 1];
    const b = profile.nd[i] - profile.na[i];
    if (a === 0 || b === 0) continue;
    if (a * b < 0) {
      const f = a / (a - b);
      out.push(profile.y[i - 1] + f * (profile.y[i] - profile.y[i - 1]));
    }
  }
  return out;
}

/** Sheet resistance (Ω/□) of the layer between two depths, using majority-carrier mobility. */
export function sheetResistance(profile: DepthProfile, from: number, to: number) {
  let g = 0;
  for (let i = 1; i < profile.y.length; i += 1) {
    const ym = 0.5 * (profile.y[i] + profile.y[i - 1]);
    if (ym < from || ym > to) continue;
    const nd = 0.5 * (profile.nd[i] + profile.nd[i - 1]);
    const na = 0.5 * (profile.na[i] + profile.na[i - 1]);
    const net = Math.abs(nd - na);
    const mu = nd > na ? mobilityN(nd + na) : mobilityP(nd + na);
    g += Q * mu * net * (profile.y[i] - profile.y[i - 1]) * 1e-4;
  }
  return g > 0 ? 1 / g : Infinity;
}

export function formatConc(value: number) {
  if (!isFinite(value) || value <= 0) return "0";
  const e = Math.floor(Math.log10(value));
  const m = value / Math.pow(10, e);
  return `${m.toFixed(1)}×10${superscript(e)}`;
}

export function superscript(n: number) {
  const map: Record<string, string> = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
  return String(n)
    .split("")
    .map((c) => map[c] ?? c)
    .join("");
}

/** Axis-aligned rectangular prism helper. */
export function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Prism {
  return {
    poly: [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1]
    ],
    z0,
    z1
  };
}
