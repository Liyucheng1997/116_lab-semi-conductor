/**
 * Physical constants and silicon material models at T = 300 K.
 * Units: cm, s, V, A, cm^-3 unless noted otherwise. Geometry elsewhere uses μm.
 */

export const Q = 1.602176634e-19; // C
export const KB = 1.380649e-23; // J/K
export const KB_EV = 8.617333e-5; // eV/K
export const T0 = 300; // K
export const VT = (KB * T0) / Q; // thermal voltage ≈ 25.85 mV
export const EPS0 = 8.8541878e-14; // F/cm
export const EPS_SI = 11.7;
export const EPS_OX = 3.9;
export const NI = 9.65e9; // intrinsic carrier density of Si, cm^-3
export const EG = 1.12; // eV
export const CHI_SI = 4.05; // electron affinity, eV
export const UM = 1e-4; // μm -> cm

/** Caughey–Thomas low-field mobility (cm²/Vs) versus total ionized doping. */
export function mobilityN(nTotal: number) {
  return 68.5 + (1414 - 68.5) / (1 + Math.pow(nTotal / 9.2e16, 0.711));
}

export function mobilityP(nTotal: number) {
  return 44.9 + (470.5 - 44.9) / (1 + Math.pow(nTotal / 2.23e17, 0.719));
}

/** Minority-carrier lifetime: doping-dependent SRH (Fossum) combined with Auger. */
export function lifetimeN(nTotal: number) {
  const srh = 1e-5 / (1 + nTotal / 7.1e15);
  const auger = 2.8e-31 * nTotal * nTotal;
  return 1 / (1 / srh + auger);
}

export function lifetimeP(nTotal: number) {
  const srh = 3e-6 / (1 + nTotal / 7.1e15);
  const auger = 9.9e-32 * nTotal * nTotal;
  return 1 / (1 / srh + auger);
}

/** Slotboom band-gap narrowing (eV) for heavily doped silicon. */
export function bandgapNarrowing(nTotal: number) {
  if (nTotal < 1e17) return 0;
  const l = Math.log(nTotal / 1e17);
  return 9e-3 * (l + Math.sqrt(l * l + 0.5));
}

export function nieSquared(nTotal: number) {
  return NI * NI * Math.exp(bandgapNarrowing(nTotal) / VT);
}

/** Resistivity (Ω·cm) of uniformly doped silicon. */
export function resistivity(nd: number, na: number) {
  const total = nd + na;
  const net = Math.abs(nd - na);
  const mu = nd >= na ? mobilityN(total) : mobilityP(total);
  return 1 / (Q * mu * Math.max(net, 1e10));
}

/** Avalanche breakdown of a one-sided planar abrupt junction (Sze), volts. */
export function planarBreakdown(nLight: number) {
  return 60 * Math.pow(EG / 1.1, 1.5) * Math.pow(nLight / 1e16, -0.75);
}

export function erfc(x: number): number {
  // Numerical Recipes erfc with fractional error < 1.2e-7
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
    );
  return x >= 0 ? r : 2 - r;
}

export function erf(x: number) {
  return 1 - erfc(x);
}
