/// <reference lib="webworker" />
import { devices, finalState, runProcess } from "../devices/registry";
import type { DeviceKey } from "../devices/types";
import { createCompactModel, type CompactModel } from "../physics/compact";
import { PoissonSolver } from "../physics/poisson2d";
import type { ProcessState } from "../physics/process";
import { buildStructure, type DeviceStructure } from "../physics/structure";
import type { FaceMap, WorkerRequest, WorkerResponse } from "./protocol";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

interface DeviceSim {
  structure: DeviceStructure;
  solver: PoissonSolver;
  model: CompactModel;
}

const sims = new Map<DeviceKey, DeviceSim>();

function sim(key: DeviceKey) {
  let s = sims.get(key);
  if (!s) {
    const def = devices[key];
    const state = finalState(def);
    const structure = buildStructure(def, state);
    s = { structure, solver: new PoissonSolver(structure), model: createCompactModel(def, state) };
    sims.set(key, s);
  }
  return s;
}

function face(
  state: ProcessState,
  width: number,
  height: number,
  point: (u: number, v: number) => [number, number, number]
): FaceMap {
  const net = new Float32Array(width * height);
  const mat = new Uint8Array(width * height);
  const tmp = { nd: 0, na: 0 };
  for (let r = 0; r < height; r += 1) {
    const v = (r + 0.5) / height;
    for (let c = 0; c < width; c += 1) {
      const u = (c + 0.5) / width;
      const [x, y, z] = point(u, v);
      const k = r * width + c;
      const m = state.materialAt(x, y, z);
      mat[k] = m;
      if (m === 0) {
        state.doping(x, y, z, tmp);
        net[k] = tmp.nd - tmp.na;
      }
    }
  }
  return { width, height, net, mat };
}

function processMaps(key: DeviceKey, step: number, fraction: number, ppm: number) {
  const def = devices[key];
  const state = runProcess(def, step, fraction);
  const d = def.domain;
  const top = state.siliconTop;
  const w = Math.max(8, Math.round((d.x1 - d.x0) * ppm));
  const h = Math.max(8, Math.round((d.y1 - top) * ppm));
  const dz = Math.max(8, Math.round((d.z1 - d.z0) * ppm * 0.6));
  const front = face(state, w, h, (u, v) => [d.x0 + u * (d.x1 - d.x0), top + v * (d.y1 - top), d.z1 - 1e-4]);
  const topMap = face(state, w, dz, (u, v) => [d.x0 + u * (d.x1 - d.x0), top + 0.004, d.z0 + v * (d.z1 - d.z0)]);
  const hs = Math.max(8, Math.round(h * 0.6));
  const right = face(state, dz, hs, (u, v) => [d.x1 - 1e-4, top + v * (d.y1 - top), d.z1 - u * (d.z1 - d.z0)]);
  const left = face(state, dz, hs, (u, v) => [d.x0 + 1e-4, top + v * (d.y1 - top), d.z0 + u * (d.z1 - d.z0)]);
  const profiles: Record<string, { t: Float32Array; nd: Float32Array; na: Float32Array }> = {};
  const tmp = { nd: 0, na: 0 };
  def.cutlines.forEach((c) => {
    const count = 700;
    const t = new Float32Array(count);
    const nd = new Float32Array(count);
    const na = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      const s = c.from + ((c.to - c.from) * i) / (count - 1);
      t[i] = s;
      const [x, y] = c.orientation === "vertical" ? [c.at, s] : [s, c.at];
      if (y < top || !state.isSilicon(x, y, 0)) continue;
      state.doping(x, y, 0, tmp);
      nd[i] = tmp.nd;
      na[i] = tmp.na;
    }
    profiles[c.id] = { t, nd, na };
  });
  const msg: WorkerResponse = {
    type: "processMaps",
    id: 0,
    device: key,
    step,
    fraction,
    siliconTop: top,
    front,
    top: topMap,
    right,
    left,
    profiles
  };
  return msg;
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    if (req.type === "processMaps") {
      const msg = processMaps(req.device, req.step, req.fraction, req.pxPerUm) as Extract<WorkerResponse, { type: "processMaps" }>;
      msg.id = req.id;
      const transfer: Transferable[] = [];
      [msg.front, msg.top, msg.right, msg.left].forEach((f) => transfer.push(f.net.buffer, f.mat.buffer));
      ctx.postMessage(msg, transfer);
    } else if (req.type === "mesh") {
      const s = sim(req.device).structure;
      const msg: WorkerResponse = {
        type: "mesh",
        id: req.id,
        device: req.device,
        nx: s.nx,
        ny: s.ny,
        xs: s.xs,
        ys: s.ys,
        net: s.net,
        si: s.si,
        cellSi: s.cellSi,
        jSurface: s.jSurface
      };
      ctx.postMessage(msg);
    } else if (req.type === "solve") {
      const s = sim(req.device);
      const op = s.model.evaluate(req.bias);
      const r = s.solver.solve(op.terminals, { channelPhi: op.channelPhi });
      const msg: WorkerResponse = {
        type: "solve",
        id: req.id,
        device: req.device,
        bias: req.bias,
        psi: r.psi,
        n: r.n,
        p: r.p,
        phin: r.phin,
        phip: r.phip,
        ex: r.ex,
        ey: r.ey,
        neutral: r.neutral,
        newton: r.newton,
        cg: r.cg,
        converged: r.converged,
        ms: r.ms,
        nodes: s.structure.nx * s.structure.ny
      };
      ctx.postMessage(msg, [r.psi.buffer, r.n.buffer, r.p.buffer, r.phin.buffer, r.phip.buffer, r.ex.buffer, r.ey.buffer, r.neutral.buffer]);
    }
  } catch (err) {
    ctx.postMessage({ type: "error", id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
