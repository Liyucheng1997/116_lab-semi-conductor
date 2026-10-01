import type { DeviceKey } from "../devices/types";
import type { MeshInfo, ProcessMapsResult, SolveResultMsg, WorkerRequest, WorkerResponse } from "./protocol";

type Pending = { resolve: (v: WorkerResponse) => void; reject: (e: Error) => void };

/**
 * Two workers: one for process maps (can be slow), one for the device solver,
 * so that stepping through the process never blocks a bias sweep and vice versa.
 */
export class SimClient {
  private workers: Worker[];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private solveBusy = false;
  private queuedSolve: { device: DeviceKey; bias: Record<string, number> } | null = null;
  private solveListener: ((r: SolveResultMsg) => void) | null = null;
  private busyListener: ((busy: boolean) => void) | null = null;

  constructor() {
    this.workers = [0, 1].map(() => {
      const w = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<WorkerResponse>) => this.receive(e.data);
      return w;
    });
  }

  private receive(msg: WorkerResponse) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === "error") p.reject(new Error(msg.message));
    else p.resolve(msg);
  }

  private call<T extends WorkerResponse>(worker: number, req: WorkerRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      this.pending.set(req.id, { resolve: resolve as (v: WorkerResponse) => void, reject });
      this.workers[worker].postMessage(req);
    });
  }

  processMaps(device: DeviceKey, step: number, fraction: number, pxPerUm: number) {
    return this.call<ProcessMapsResult>(0, { type: "processMaps", id: this.nextId++, device, step, fraction, pxPerUm });
  }

  mesh(device: DeviceKey) {
    return this.call<MeshInfo>(1, { type: "mesh", id: this.nextId++, device });
  }

  onSolve(listener: (r: SolveResultMsg) => void) {
    this.solveListener = listener;
  }

  onBusy(listener: (busy: boolean) => void) {
    this.busyListener = listener;
  }

  /** Latest-wins bias solve: while the solver is busy only the newest request is kept. */
  requestSolve(device: DeviceKey, bias: Record<string, number>) {
    this.queuedSolve = { device, bias: { ...bias } };
    this.pump();
  }

  private pump() {
    if (this.solveBusy || !this.queuedSolve) return;
    const job = this.queuedSolve;
    this.queuedSolve = null;
    this.solveBusy = true;
    this.busyListener?.(true);
    this.call<SolveResultMsg>(1, { type: "solve", id: this.nextId++, device: job.device, bias: job.bias })
      .then((r) => {
        this.solveListener?.(r);
      })
      .catch((e) => console.error(e))
      .finally(() => {
        this.solveBusy = false;
        if (!this.queuedSolve) this.busyListener?.(false);
        this.pump();
      });
  }
}
