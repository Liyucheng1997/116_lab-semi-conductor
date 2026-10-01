import type { DeviceKey } from "../devices/types";

export interface FaceMap {
  width: number;
  height: number;
  /** signed net doping N_D − N_A (cm⁻³) */
  net: Float32Array;
  /** 0 silicon, 1 oxide, 2 void, 3 outside */
  mat: Uint8Array;
}

export interface ProcessMapsResult {
  type: "processMaps";
  id: number;
  device: DeviceKey;
  step: number;
  fraction: number;
  siliconTop: number;
  front: FaceMap;
  top: FaceMap;
  right: FaceMap;
  left: FaceMap;
  profiles: Record<string, { t: Float32Array; nd: Float32Array; na: Float32Array }>;
}

export interface MeshInfo {
  type: "mesh";
  id: number;
  device: DeviceKey;
  nx: number;
  ny: number;
  xs: Float64Array;
  ys: Float64Array;
  net: Float64Array;
  si: Uint8Array;
  cellSi: Uint8Array;
  jSurface: number;
}

export interface SolveResultMsg {
  type: "solve";
  id: number;
  device: DeviceKey;
  bias: Record<string, number>;
  psi: Float64Array;
  n: Float64Array;
  p: Float64Array;
  phin: Float64Array;
  phip: Float64Array;
  ex: Float64Array;
  ey: Float64Array;
  neutral: Int8Array;
  newton: number;
  cg: number;
  converged: boolean;
  ms: number;
  nodes: number;
}

export type WorkerRequest =
  | { type: "processMaps"; id: number; device: DeviceKey; step: number; fraction: number; pxPerUm: number }
  | { type: "mesh"; id: number; device: DeviceKey }
  | { type: "solve"; id: number; device: DeviceKey; bias: Record<string, number> };

export type WorkerResponse = ProcessMapsResult | MeshInfo | SolveResultMsg | { type: "error"; id: number; message: string };
