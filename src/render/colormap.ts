/** Colormaps as 256-entry RGB lookup tables. */

type Stop = [number, number, number, number];

function build(stops: Stop[]) {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i += 1) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k += 1;
    const [t0, r0, g0, b0] = stops[k];
    const [t1, r1, g1, b1] = stops[k + 1];
    const f = t1 > t0 ? Math.min(Math.max((t - t0) / (t1 - t0), 0), 1) : 0;
    lut[i * 3] = Math.round(r0 + (r1 - r0) * f);
    lut[i * 3 + 1] = Math.round(g0 + (g1 - g0) * f);
    lut[i * 3 + 2] = Math.round(b0 + (b1 - b0) * f);
  }
  return lut;
}

export const LUT = {
  turbo: build([
    [0, 48, 18, 59],
    [0.1, 70, 88, 200],
    [0.2, 62, 156, 254],
    [0.3, 24, 214, 203],
    [0.4, 49, 244, 117],
    [0.5, 164, 252, 60],
    [0.6, 226, 220, 56],
    [0.7, 254, 164, 49],
    [0.8, 245, 97, 25],
    [0.9, 200, 41, 4],
    [1, 122, 4, 3]
  ]),
  inferno: build([
    [0, 0, 0, 4],
    [0.15, 31, 12, 72],
    [0.3, 85, 15, 109],
    [0.45, 136, 34, 106],
    [0.6, 186, 54, 85],
    [0.72, 227, 89, 51],
    [0.84, 249, 140, 10],
    [0.93, 249, 201, 50],
    [1, 252, 255, 164]
  ]),
  viridis: build([
    [0, 68, 1, 84],
    [0.15, 72, 40, 120],
    [0.3, 62, 74, 137],
    [0.45, 49, 104, 142],
    [0.6, 38, 130, 142],
    [0.72, 31, 158, 137],
    [0.84, 53, 183, 121],
    [0.93, 143, 215, 68],
    [1, 253, 231, 37]
  ]),
  electrons: build([
    [0, 8, 12, 24],
    [0.25, 16, 40, 92],
    [0.5, 24, 96, 170],
    [0.75, 64, 170, 232],
    [1, 214, 244, 255]
  ]),
  holes: build([
    [0, 20, 8, 12],
    [0.25, 80, 18, 34],
    [0.5, 160, 36, 52],
    [0.75, 236, 104, 84],
    [1, 255, 226, 196]
  ]),
  diverging: build([
    [0, 40, 110, 210],
    [0.25, 110, 170, 235],
    [0.5, 20, 22, 28],
    [0.75, 240, 130, 110],
    [1, 225, 50, 60]
  ]),
  coolwarm: build([
    [0, 59, 76, 192],
    [0.25, 124, 159, 249],
    [0.5, 221, 221, 221],
    [0.75, 246, 149, 115],
    [1, 180, 4, 38]
  ])
};

export type LutName = keyof typeof LUT;

/**
 * TCAD-style net-doping palette: n-type in blues/cyans, p-type in reds/oranges,
 * brightness ∝ log10|N|. Returns [r, g, b].
 */
export function dopingColor(net: number, out: number[] | Uint8ClampedArray, o = 0) {
  const a = Math.abs(net);
  const t = Math.min(Math.max((Math.log10(Math.max(a, 1e13)) - 14) / 6.3, 0), 1);
  const e = Math.pow(t, 0.9);
  if (net >= 0) {
    out[o] = 18 + 40 * e * e;
    out[o + 1] = 40 + 170 * e;
    out[o + 2] = 70 + 185 * e;
  } else {
    out[o] = 70 + 185 * e;
    out[o + 1] = 26 + 110 * e * e;
    out[o + 2] = 38 + 40 * e * e;
  }
  return out;
}

export function dopingGradientCss() {
  const stops: string[] = [];
  const tmp = [0, 0, 0];
  for (let i = 0; i <= 10; i += 1) {
    const v = -Math.pow(10, 20.3 - (6.3 * i) / 10);
    dopingColor(v, tmp);
    stops.push(`rgb(${tmp.map(Math.round).join(",")}) ${i * 5}%`);
  }
  for (let i = 0; i <= 10; i += 1) {
    const v = Math.pow(10, 14 + (6.3 * i) / 10);
    dopingColor(v, tmp);
    stops.push(`rgb(${tmp.map(Math.round).join(",")}) ${50 + i * 5}%`);
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

export function lutGradientCss(name: LutName) {
  const lut = LUT[name];
  const stops: string[] = [];
  for (let i = 0; i <= 16; i += 1) {
    const k = Math.round((i / 16) * 255) * 3;
    stops.push(`rgb(${lut[k]},${lut[k + 1]},${lut[k + 2]}) ${(i / 16) * 100}%`);
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

export const OXIDE_RGB = [128, 150, 168];
export const VOID_RGB = [10, 12, 16];
