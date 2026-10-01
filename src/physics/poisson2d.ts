/**
 * 2-D quasi-equilibrium device solver.
 *
 *  1. Non-linear Poisson  ∇·(ε∇ψ) = −q(p − n + N_D − N_A), with n = nᵢe^{(ψ−φn)/V_T}, p = nᵢe^{(φp−ψ)/V_T},
 *     solved by damped Newton iteration; every Newton step is an SPD 5-point system solved by IC(0)-PCG.
 *  2. Quasi-Fermi potentials: majority carriers take the potential of the contact that owns their doped
 *     region; inside space-charge regions both quasi-Fermi levels are flat (the standard junction
 *     approximation). In MOSFET channels φn follows the gradual-channel solution.
 *  3. Minority-carrier continuity in every quasi-neutral region, written in Kroemer/Slotboom form
 *     ∇·(D nᵢ²/N ∇w) − (nᵢ²/N)(w − 1)/τ = 0,  n_minority = (nᵢ²/N)·w,
 *     with w fixed at space-charge-region edges (law of the junction) and w = 1 at ohmic contacts.
 *     The resulting quasi-Fermi levels are fed back into Poisson (a simplified Gummel loop).
 */
import { EPS0, NI, Q, VT, lifetimeN, lifetimeP, mobilityN, mobilityP } from "./constants";
import { Stencil5 } from "./linalg";
import type { DeviceStructure } from "./structure";

export interface SolveOptions {
  /** channel quasi-Fermi potential φ(x) for MOSFETs (absolute, V) */
  channelPhi?: (x: number) => number;
  maxNewton?: number;
  minority?: boolean;
}

export interface SolveResult {
  psi: Float64Array;
  n: Float64Array;
  p: Float64Array;
  phin: Float64Array;
  phip: Float64Array;
  ex: Float64Array; // V/cm
  ey: Float64Array; // V/cm
  neutral: Int8Array; // +1 neutral n, -1 neutral p, 0 space charge / other
  newton: number;
  cg: number;
  update: number;
  converged: boolean;
  ms: number;
}

const QE = Q / EPS0; // V·cm

export class PoissonSolver {
  readonly psi: Float64Array;
  private readonly phin: Float64Array;
  private readonly phip: Float64Array;
  private readonly dirichlet: Float64Array;
  private readonly isDir: Uint8Array;
  private readonly A: Stencil5;
  private readonly rhs: Float64Array;
  private readonly delta: Float64Array;
  private initialized = false;
  private lastNeutral: Int8Array | null = null;

  constructor(readonly s: DeviceStructure) {
    const N = s.nx * s.ny;
    this.psi = new Float64Array(N);
    this.phin = new Float64Array(N);
    this.phip = new Float64Array(N);
    this.dirichlet = new Float64Array(N);
    this.isDir = new Uint8Array(N);
    this.A = new Stencil5(s.nx, s.ny);
    this.rhs = new Float64Array(N);
    this.delta = new Float64Array(N);
  }

  private contactPotential(k: number, v: number, gate: boolean) {
    if (gate) return v + this.s.gateWorkOffset;
    const net = this.s.net[k];
    return v + VT * Math.asinh(net / (2 * NI));
  }

  private assignQuasiFermi(bias: Record<string, number>, opts: SolveOptions) {
    const s = this.s;
    const volt = s.compTerminal.map((t) => (t ? bias[t] ?? 0 : 0));
    const N = s.nx * s.ny;
    for (let k = 0; k < N; k += 1) {
      if (!s.si[k]) continue;
      this.phin[k] = s.nearestN[k] >= 0 ? volt[s.nearestN[k]] : volt[s.comp[k]];
      this.phip[k] = s.nearestP[k] >= 0 ? volt[s.nearestP[k]] : volt[s.comp[k]];
    }
    if (opts.channelPhi && s.channel) {
      const { xs, xd } = s.channel;
      for (let j = s.jSurface; j < s.ny; j += 1) {
        if (s.ys[j] > 0.08) break;
        for (let i = 0; i < s.nx; i += 1) {
          const x = s.xs[i];
          if (x <= xs || x >= xd) continue;
          const k = j * s.nx + i;
          if (!s.si[k]) continue;
          if (s.polarity * s.net[k] < 0) {
            if (s.polarity === 1) this.phin[k] = opts.channelPhi(x);
            else this.phip[k] = opts.channelPhi(x);
          }
        }
      }
    }
  }

  private setBoundary(bias: Record<string, number>) {
    const s = this.s;
    const N = s.nx * s.ny;
    for (let k = 0; k < N; k += 1) {
      const c = s.contactOf[k];
      if (c < 0) {
        this.isDir[k] = 0;
        continue;
      }
      const def = s.contacts[c];
      this.isDir[k] = 1;
      this.dirichlet[k] = this.contactPotential(k, bias[def.terminal] ?? 0, def.kind === "gate");
    }
  }

  private initialGuess() {
    const s = this.s;
    const { nx, ny } = s;
    for (let k = 0; k < nx * ny; k += 1) {
      if (!s.si[k]) continue;
      this.psi[k] = neutralPotential(s.net[k], this.phin[k], this.phip[k]);
    }
    // dielectric nodes: copy from the nearest silicon node below/above, then contacts
    for (let i = 0; i < nx; i += 1) {
      for (let j = 0; j < ny; j += 1) {
        const k = j * nx + i;
        if (s.si[k]) continue;
        let v = 0;
        for (let jj = j + 1; jj < ny; jj += 1) {
          if (s.si[jj * nx + i]) {
            v = this.psi[jj * nx + i];
            break;
          }
        }
        this.psi[k] = v;
      }
    }
    for (let k = 0; k < nx * ny; k += 1) if (this.isDir[k]) this.psi[k] = this.dirichlet[k];
    this.clampToPhysical();
  }

  private newton(maxIter: number) {
    const s = this.s;
    const { nx, ny } = s;
    const N = nx * ny;
    const A = this.A;
    const psi = this.psi;
    let it = 0;
    let cgTotal = 0;
    let maxUpdate = Infinity;
    // inexact Newton: loose linear solves while the update is large, tight near convergence
    let eta = 1e-3;
    for (; it < maxIter; it += 1) {
      A.clear();
      for (let k = 0; k < N; k += 1) {
        if (this.isDir[k]) {
          A.diag[k] = 1;
          this.rhs[k] = 0;
          continue;
        }
        const i = k % nx;
        let f = 0;
        let dg = 0;
        if (i < nx - 1) {
          const c = s.cX[k];
          f += c * (psi[k + 1] - psi[k]);
          dg += c;
          if (!this.isDir[k + 1]) A.ex[k] = -c;
        }
        if (i > 0) {
          const c = s.cX[k - 1];
          f += c * (psi[k - 1] - psi[k]);
          dg += c;
        }
        if (k + nx < N) {
          const c = s.cY[k];
          f += c * (psi[k + nx] - psi[k]);
          dg += c;
          if (!this.isDir[k + nx]) A.ey[k] = -c;
        }
        if (k >= nx) {
          const c = s.cY[k - nx];
          f += c * (psi[k - nx] - psi[k]);
          dg += c;
        }
        if (s.si[k]) {
          const nn = NI * Math.exp(clampExp((psi[k] - this.phin[k]) / VT));
          const pp = NI * Math.exp(clampExp((this.phip[k] - psi[k]) / VT));
          const w = QE * s.siArea[k];
          f += w * (pp - nn + s.net[k]);
          dg += (w * (nn + pp)) / VT;
        }
        A.diag[k] = dg;
        this.rhs[k] = f;
      }
      // couplings from Dirichlet nodes must also be removed on the lower triangle
      for (let k = 0; k < N; k += 1) {
        if (!this.isDir[k]) continue;
        const i = k % nx;
        if (i > 0) A.ex[k - 1] = 0;
        if (k >= nx) A.ey[k - nx] = 0;
        if (i < nx - 1) A.ex[k] = 0;
        A.ey[k] = 0;
      }
      for (let k = 0; k < N; k += 1) if (k % nx === nx - 1) A.ex[k] = 0;

      this.delta.fill(0);
      cgTotal += A.solve(this.rhs, this.delta, eta, 3000);
      maxUpdate = 0;
      for (let k = 0; k < N; k += 1) {
        const d = this.delta[k];
        const ad = Math.abs(d);
        if (ad > maxUpdate) maxUpdate = ad;
        // logarithmic damping keeps Newton stable far from the solution
        psi[k] += ad > VT ? Math.sign(d) * VT * (1 + Math.log(ad / VT)) : d;
      }
      if (maxUpdate < 2e-6 && eta <= 1e-8) {
        it += 1;
        break;
      }
      eta = Math.min(1e-3, Math.max(1e-10, maxUpdate * 1e-4));
    }
    return { it, cgTotal, maxUpdate };
  }

  /** Minority continuity in quasi-neutral regions; updates φn/φp there. */
  private minority(neutral: Int8Array) {
    const s = this.s;
    const { nx, ny } = s;
    const N = nx * ny;
    const A = this.A;
    const w = new Float64Array(N);
    for (const carrier of [1, -1]) {
      // carrier = +1: electrons in neutral p-regions; −1: holes in neutral n-regions
      const regionType = -carrier;
      A.clear();
      const unknown = new Uint8Array(N);
      const coef = new Float64Array(N);
      const fixed = new Float64Array(N);
      const isFixed = new Uint8Array(N);
      for (let k = 0; k < N; k += 1) {
        if (neutral[k] !== regionType) continue;
        const nTot = s.nd[k] + s.na[k];
        const D = VT * (carrier === 1 ? mobilityN(nTot) : mobilityP(nTot));
        coef[k] = (D * NI * NI) / Math.max(Math.abs(s.net[k]), 1e10);
        const own = carrier === 1 ? this.phip[k] : this.phin[k];
        // Dirichlet at contacts and at the edge of space-charge regions. The minority quasi-Fermi level
        // at an SCR edge is the majority level of the region across that SCR (flat through the SCR);
        // it is taken from the adjacent SCR node, which knows which junction it belongs to.
        let edge = false;
        let other = carrier === 1 ? -Infinity : Infinity;
        const i = k % nx;
        const nbs = [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, k >= nx ? k - nx : -1, k + nx < N ? k + nx : -1];
        for (const m of nbs) {
          if (m >= 0 && s.si[m] && neutral[m] !== regionType) {
            edge = true;
            other = carrier === 1 ? Math.max(other, this.phin[m]) : Math.min(other, this.phip[m]);
          }
        }
        if (s.contactOf[k] >= 0) {
          isFixed[k] = 1;
          fixed[k] = 1;
        } else if (edge) {
          isFixed[k] = 1;
          fixed[k] = Math.exp(clampExp((carrier === 1 ? own - other : other - own) / VT));
        } else {
          unknown[k] = 1;
        }
      }
      const b = this.rhs;
      b.fill(0);
      for (let k = 0; k < N; k += 1) {
        if (!unknown[k]) {
          A.diag[k] = 1;
          b[k] = isFixed[k] ? fixed[k] : 0;
          continue;
        }
        const i = k % nx;
        const nTot = s.nd[k] + s.na[k];
        const tau = carrier === 1 ? lifetimeN(nTot) : lifetimeP(nTot);
        const r = (s.siArea[k] * NI * NI) / (Math.max(Math.abs(s.net[k]), 1e10) * tau);
        let dg = r;
        let f = r; // equilibrium source term r·1
        const link = (m: number, geo: number, store: (v: number) => void) => {
          if (m < 0 || !(unknown[m] || isFixed[m])) return;
          const g = geo * Math.sqrt(coef[k] * coef[m]); // geometric mean of Kroemer coefficients
          dg += g;
          if (unknown[m]) store(-g);
          else f += g * fixed[m];
        };
        const geoX1 = i < nx - 1 ? s.cX[k] / 11.7 : 0;
        const geoX0 = i > 0 ? s.cX[k - 1] / 11.7 : 0;
        const geoY1 = k + nx < N ? s.cY[k] / 11.7 : 0;
        const geoY0 = k >= nx ? s.cY[k - nx] / 11.7 : 0;
        if (i < nx - 1) link(k + 1, geoX1, (v) => (A.ex[k] = v));
        if (i > 0) link(k - 1, geoX0, () => undefined);
        if (k + nx < N) link(k + nx, geoY1, (v) => (A.ey[k] = v));
        if (k >= nx) link(k - nx, geoY0, () => undefined);
        A.diag[k] = dg;
        b[k] = f;
      }
      for (let k = 0; k < N; k += 1) {
        if (unknown[k]) continue;
        const i = k % nx;
        if (i > 0) A.ex[k - 1] = 0;
        if (k >= nx) A.ey[k - nx] = 0;
        if (i < nx - 1) A.ex[k] = 0;
        A.ey[k] = 0;
      }
      for (let k = 0; k < N; k += 1) if (k % nx === nx - 1) A.ex[k] = 0;
      w.fill(0);
      for (let k = 0; k < N; k += 1) w[k] = unknown[k] ? 1 : b[k];
      A.solve(b, w, 1e-11, 4000);
      for (let k = 0; k < N; k += 1) {
        if (neutral[k] !== regionType) continue;
        const wk = Math.max(w[k], 1e-300);
        if (carrier === 1) this.phin[k] = this.phip[k] - VT * Math.log(wk);
        else this.phip[k] = this.phin[k] + VT * Math.log(wk);
      }
    }
  }

  /**
   * Quasi-neutral if the majority carrier still balances at least half of the net doping AND the
   * potential sits within 2 V_T of its local charge-neutral value (the second test catches the
   * centre of graded junctions, where |N| → 0 and injected carriers alone would pass the first).
   */
  private classify() {
    const s = this.s;
    const N = s.nx * s.ny;
    const neutral = new Int8Array(N);
    for (let k = 0; k < N; k += 1) {
      if (!s.si[k]) continue;
      const net = s.net[k];
      const dev = Math.abs(this.psi[k] - neutralPotential(net, this.phin[k], this.phip[k]));
      if (dev > 2 * VT) continue;
      if (net > 0) {
        const nn = NI * Math.exp(clampExp((this.psi[k] - this.phin[k]) / VT));
        if (nn >= 0.5 * net) neutral[k] = 1;
      } else if (net < 0) {
        const pp = NI * Math.exp(clampExp((this.phip[k] - this.psi[k]) / VT));
        if (pp >= -0.5 * net) neutral[k] = -1;
      }
    }
    return neutral;
  }

  solve(bias: Record<string, number>, opts: SolveOptions = {}): SolveResult {
    const t0 = performance.now();
    this.assignQuasiFermi(bias, opts);
    this.setBoundary(bias);
    if (!this.initialized || !this.lastNeutral) {
      this.initialGuess();
      this.initialized = true;
    } else {
      this.laplaceShift(this.lastNeutral);
    }
    const maxNewton = opts.maxNewton ?? 120;
    let r = this.newton(maxNewton);
    let newton = r.it;
    let cg = r.cgTotal;
    let neutral = this.classify();
    if (opts.minority !== false && !opts.channelPhi) {
      this.minority(neutral);
      r = this.newton(maxNewton);
      newton += r.it;
      cg += r.cgTotal;
      neutral = this.classify();
    }
    this.lastNeutral = r.maxUpdate < 1e-3 ? neutral : null;
    return this.collect(neutral, newton, cg, r.maxUpdate, performance.now() - t0);
  }

  /**
   * Warm start for a new bias: quasi-neutral regions jump to their new charge-neutral potential,
   * contacts to their new boundary value, and the change is spread through space-charge regions
   * and dielectrics by solving Laplace's equation for the potential shift.
   */
  private laplaceShift(neutral: Int8Array) {
    const s = this.s;
    const { nx } = s;
    const N = nx * s.ny;
    const A = this.A;
    const fixed = new Uint8Array(N);
    const shift = this.delta;
    shift.fill(0);
    for (let k = 0; k < N; k += 1) {
      if (this.isDir[k]) {
        fixed[k] = 1;
        shift[k] = this.dirichlet[k] - this.psi[k];
      } else if (neutral[k] !== 0) {
        fixed[k] = 1;
        shift[k] = neutralPotential(s.net[k], this.phin[k], this.phip[k]) - this.psi[k];
      }
    }
    A.clear();
    const b = this.rhs;
    for (let k = 0; k < N; k += 1) {
      if (fixed[k]) {
        A.diag[k] = 1;
        b[k] = shift[k];
        continue;
      }
      const i = k % nx;
      let dg = 0;
      let f = 0;
      const link = (m: number, c: number, store?: (v: number) => void) => {
        dg += c;
        if (fixed[m]) f += c * shift[m];
        else if (store) store(-c);
      };
      if (i < nx - 1) link(k + 1, s.cX[k], (v) => (A.ex[k] = v));
      if (i > 0) link(k - 1, s.cX[k - 1]);
      if (k + nx < N) link(k + nx, s.cY[k], (v) => (A.ey[k] = v));
      if (k >= nx) link(k - nx, s.cY[k - nx]);
      A.diag[k] = dg || 1;
      b[k] = f;
    }
    for (let k = 0; k < N; k += 1) if (k % nx === nx - 1) A.ex[k] = 0;
    A.solve(b, shift, 1e-10, 3000);
    for (let k = 0; k < N; k += 1) this.psi[k] += shift[k];
    this.clampToPhysical();
  }

  /**
   * Newton needs ~1 iteration per V_T to walk down an exponential, so an initial guess with absurd
   * carrier densities (e.g. 10⁷⁰ cm⁻³) is projected back into a physically plausible window first.
   */
  private clampToPhysical() {
    const s = this.s;
    const N = s.nx * s.ny;
    for (let k = 0; k < N; k += 1) {
      if (!s.si[k] || this.isDir[k]) continue;
      const bound = VT * Math.log(Math.max(10 * Math.abs(s.net[k]), 1e20) / NI);
      const lo = this.phip[k] - bound;
      const hi = this.phin[k] + bound;
      if (lo > hi) continue;
      if (this.psi[k] < lo) this.psi[k] = lo;
      else if (this.psi[k] > hi) this.psi[k] = hi;
    }
  }

  private collect(neutral: Int8Array, newton: number, cg: number, update: number, ms: number): SolveResult {
    const s = this.s;
    const { nx, ny } = s;
    const N = nx * ny;
    const n = new Float64Array(N);
    const p = new Float64Array(N);
    const ex = new Float64Array(N);
    const ey = new Float64Array(N);
    for (let k = 0; k < N; k += 1) {
      if (!s.si[k]) continue;
      n[k] = NI * Math.exp(clampExp((this.psi[k] - this.phin[k]) / VT));
      p[k] = NI * Math.exp(clampExp((this.phip[k] - this.psi[k]) / VT));
    }
    const cm = 1e-4;
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const k = j * nx + i;
        const i0 = Math.max(i - 1, 0);
        const i1 = Math.min(i + 1, nx - 1);
        const j0 = Math.max(j - 1, 0);
        const j1 = Math.min(j + 1, ny - 1);
        ex[k] = -(this.psi[j * nx + i1] - this.psi[j * nx + i0]) / ((s.xs[i1] - s.xs[i0]) * cm);
        ey[k] = -(this.psi[j1 * nx + i] - this.psi[j0 * nx + i]) / ((s.ys[j1] - s.ys[j0]) * cm);
      }
    }
    return {
      psi: Float64Array.from(this.psi),
      n,
      p,
      phin: Float64Array.from(this.phin),
      phip: Float64Array.from(this.phip),
      ex,
      ey,
      neutral,
      newton,
      cg,
      update,
      converged: update < 1e-4,
      ms
    };
  }
}

function clampExp(v: number) {
  return v > 700 ? 700 : v < -700 ? -700 : v;
}

/** Local charge-neutral potential for given quasi-Fermi potentials. */
export function neutralPotential(net: number, phin: number, phip: number) {
  const disc = Math.sqrt(net * net + 4 * NI * NI * Math.exp(clampExp((phip - phin) / VT)));
  if (net >= 0) return phin + VT * Math.log((net + disc) / (2 * NI));
  return phip - VT * Math.log((-net + disc) / (2 * NI));
}
