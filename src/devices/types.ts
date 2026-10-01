import type { ProcessState, Prism, Rect } from "../physics/process";

export type DeviceKey = "diode" | "npn" | "pnp" | "nmos" | "pmos";
export type DeviceFamily = "diode" | "bjt" | "mos";

export type StepCategory =
  | "substrate"
  | "epi"
  | "oxidation"
  | "litho"
  | "etch"
  | "implant"
  | "anneal"
  | "deposition"
  | "cmp"
  | "metal"
  | "strip";

export const categoryName: Record<StepCategory, string> = {
  substrate: "衬底",
  epi: "外延",
  oxidation: "氧化",
  litho: "光刻",
  etch: "刻蚀",
  implant: "注入",
  anneal: "热处理",
  deposition: "淀积",
  cmp: "平坦化",
  metal: "金属化",
  strip: "去胶/清洗"
};

export interface ProcessStepDef {
  id: string;
  category: StepCategory;
  title: string;
  equipment: string;
  params: Array<[string, string]>;
  description: string;
  apply: (s: ProcessState) => void;
}

export interface ContactDef {
  terminal: string;
  kind: "ohmic" | "gate";
  side: "top" | "bottom";
  x0: number;
  x1: number;
}

export interface CutlineDef {
  id: string;
  name: string;
  orientation: "vertical" | "horizontal";
  /** x for vertical cutlines, y for horizontal ones (μm). */
  at: number;
  from: number;
  to: number;
}

export interface BiasControl {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit: string;
}

export interface RegionLabel {
  text: string;
  x: number;
  y: number;
  z?: number;
  kind?: "region" | "terminal" | "layer";
}

export interface Domain {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

export interface DeviceDefinition {
  key: DeviceKey;
  name: string;
  english: string;
  family: DeviceFamily;
  /** +1 for n-type channel/NPN/p+n diode reference, -1 for the complementary device. */
  polarity: 1 | -1;
  domain: Domain;
  recipe: ProcessStepDef[];
  contacts: ContactDef[];
  cutlines: CutlineDef[];
  bias: BiasControl[];
  labels: RegionLabel[];
  /** Mesh refinement hints in x (μm). */
  xRefine: number[];
  /** Plan-view extents used by the compact model. */
  geometry: Record<string, number>;
}

/** Decompose a rectangular slab minus rectangular holes into boxes (all in plan view). */
export function slabWithHoles(y0: number, y1: number, area: Rect, holes: Rect[]): Prism[] {
  const xs = new Set<number>([area.x0, area.x1]);
  const zs = new Set<number>([area.z0, area.z1]);
  holes.forEach((h) => {
    [h.x0, h.x1].forEach((v) => {
      if (v > area.x0 && v < area.x1) xs.add(v);
    });
    [h.z0, h.z1].forEach((v) => {
      if (v > area.z0 && v < area.z1) zs.add(v);
    });
  });
  const xa = Array.from(xs).sort((a, b) => a - b);
  const za = Array.from(zs).sort((a, b) => a - b);
  const cells: boolean[][] = [];
  for (let i = 0; i < xa.length - 1; i += 1) {
    cells.push([]);
    for (let k = 0; k < za.length - 1; k += 1) {
      const cx = 0.5 * (xa[i] + xa[i + 1]);
      const cz = 0.5 * (za[k] + za[k + 1]);
      const inHole = holes.some((h) => cx > h.x0 && cx < h.x1 && cz > h.z0 && cz < h.z1);
      cells[i].push(!inHole);
    }
  }
  // Merge runs along z for fewer prisms.
  const prisms: Prism[] = [];
  for (let i = 0; i < xa.length - 1; i += 1) {
    let k = 0;
    while (k < za.length - 1) {
      if (!cells[i][k]) {
        k += 1;
        continue;
      }
      let k1 = k;
      while (k1 + 1 < za.length - 1 && cells[i][k1 + 1]) k1 += 1;
      prisms.push({
        poly: [
          [xa[i], y0],
          [xa[i + 1], y0],
          [xa[i + 1], y1],
          [xa[i], y1]
        ],
        z0: za[k],
        z1: za[k1 + 1]
      });
      k = k1 + 1;
    }
  }
  return prisms;
}

export function rect(x0: number, x1: number, z0: number, z1: number): Rect {
  return { x0, x1, z0, z1 };
}
