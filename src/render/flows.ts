/**
 * Current-flow paths for the carrier animation. Geometry comes from the device definition and the
 * operating point (depletion edges, pinch-off point); particle rates from the terminal currents.
 */
import type { DeviceDefinition } from "../devices/types";
import type { OperatingPoint } from "../physics/compact";
import type { Carrier, FlowPath } from "./particles";

/** Map a current to a visual particle rate (log scale): 1 pA → ~1/s, 1 mA → ~38/s. */
function rateFor(i: number) {
  const a = Math.abs(i);
  if (a < 3e-14) return 0;
  return Math.min(Math.max(3.2 * (Math.log10(a) + 12.3), 0.4), 42);
}

function share(total: number, part: number, minRate = 0.6) {
  if (total <= 0 || part <= 0) return 0;
  const r = rateFor(total) * (part / total);
  return part / total > 2e-3 ? Math.max(r, minRate) : 0;
}

export function buildFlows(def: DeviceDefinition, op: OperatingPoint): FlowPath[] {
  if (def.family === "diode") return diodeFlows(def, op);
  if (def.family === "bjt") return bjtFlows(def, op);
  return mosFlows(def, op);
}

function diodeFlows(def: DeviceDefinition, op: OperatingPoint): FlowPath[] {
  const v = op.values;
  const i = v.I;
  const left = v.left; // p⁺-side depletion edge
  const right = v.right; // n-side depletion edge
  const bottom = def.domain.y1 - 0.05;
  const epiEnd = def.geometry.epi;
  const out: FlowPath[] = [];
  if (i > 0) {
    const r = rateFor(i);
    for (const x of [2.8, 4, 5.2]) {
      // holes from the anode, across the junction, recombining in the n drift region
      out.push({
        carrier: "p",
        pts: [
          [x, 0.02],
          [x, left],
          [x, right],
          [x + (Math.random() - 0.5) * 0.6, Math.min(right + 1.4, epiEnd + 0.3)]
        ],
        speed: [0.8, 2.6, 0.55],
        jitter: [0.01, 0.005, 0.05],
        rate: (r * 0.55) / 3,
        fate: "recombine",
        recombineFrom: 0.72,
        spread: 1.0
      });
      // electrons from the cathode, up through the substrate and epi, into the p⁺ region
      out.push({
        carrier: "n",
        pts: [
          [x + (x - 4) * 0.6, bottom],
          [x, epiEnd],
          [x, right],
          [x, left],
          [x, Math.max(left - 0.35, 0.05)]
        ],
        speed: [1.1, 1.0, 2.6, 0.5],
        jitter: [0.01, 0.01, 0.004, 0.03],
        rate: (r * 0.45) / 3,
        fate: "recombine",
        recombineFrom: 0.8,
        spread: 1.0
      });
    }
  } else if (i < 0) {
    // reverse: thermal generation inside the space-charge region; avalanche multiplies it
    const r = Math.min(rateFor(i) * (op.tone === "warn" ? 2.5 : 1), 45);
    for (const x of [2.6, 3.6, 4.6, 5.4]) {
      const y = (left + right) / 2 + (Math.random() - 0.5) * (right - left) * 0.6;
      out.push({ carrier: "n", pts: [[x, y], [x, right], [x, bottom]], speed: [2.8, 1.4], jitter: [0.004, 0.01], rate: r / 4, fate: "exit", spread: 0.8, spreadY: (right - left) * 0.6, birthFlash: true });
      out.push({ carrier: "p", pts: [[x, y], [x, left], [x, 0.02]], speed: [2.8, 1.0], jitter: [0.004, 0.01], rate: r / 4, fate: "exit", spread: 0.8, spreadY: (right - left) * 0.6 });
    }
  }
  return out;
}

function bjtFlows(def: DeviceDefinition, op: OperatingPoint): FlowPath[] {
  const v = op.values;
  const g = def.geometry;
  const npn = def.polarity === 1;
  const inj: Carrier = npn ? "n" : "p";
  const maj: Carrier = npn ? "p" : "n";
  const ic = Math.max(v.ic, 0);
  const ib = Math.max(v.ib, 0);
  const total = ic + ib;
  const out: FlowPath[] = [];
  if (total <= 0) return out;
  const cx = g.cutX;
  const eL = v.eL;
  const eR = v.eR;
  const cL = v.cL;
  const cR = v.cR;
  const bl = v.blTop + 0.25;
  const sinkX = 8.1;
  const baseMid = (eR + cL) / 2;
  const recFrac = Math.min(Math.max(v.ibRec / Math.max(ib, 1e-30), 0.05), 0.6);
  const rIc = share(total, ic);
  const rIb = share(total, ib, 1.2);
  const saturated = v.vbc > 0.35;
  for (const dx of [-0.35, 0, 0.35]) {
    const x = cx + dx;
    // injected carriers: emitter → base (diffusion) → BC field → epi → buried layer → sinker → collector
    out.push({
      carrier: inj,
      pts: [
        [x, 0.01],
        [x, eL],
        [x, eR],
        [x + dx * 0.2, cL],
        [x + dx * 0.4, cR],
        [x + dx * 0.8 + 0.4, bl],
        [sinkX - 0.25, bl],
        [sinkX + dx * 0.5, 0.35],
        [sinkX + dx * 0.5, 0.01]
      ],
      speed: [0.9, 2.6, 0.45, 3.2, 1.3, 1.6, 1.4, 1.0],
      jitter: [0.004, 0.002, 0.012, 0.002, 0.02, 0.02, 0.02, 0.01],
      rate: rIc / 3,
      fate: "exit",
      spread: 0.25
    });
  }
  // base current (majority carriers from the base contact)
  const bx = 2.0;
  const back = 1 - recFrac;
  out.push({
    carrier: maj,
    pts: [
      [bx, 0.01],
      [bx, baseMid],
      [g.cutX - 0.55, baseMid],
      [g.cutX - 0.2, eR],
      [g.cutX - 0.2, eL],
      [g.cutX - 0.1, 0.03]
    ],
    speed: [0.7, 0.9, 0.7, 2.4, 0.6],
    jitter: [0.01, 0.01, 0.01, 0.003, 0.01],
    rate: rIb * back,
    fate: "recombine",
    recombineFrom: 0.8,
    spread: 0.35
  });
  // base recombination: majority carriers meet injected minority carriers inside the neutral base
  out.push({
    carrier: maj,
    pts: [
      [bx, 0.01],
      [bx, baseMid],
      [g.cutX + 0.2, baseMid]
    ],
    speed: [0.7, 0.8],
    jitter: [0.01, 0.015],
    rate: rIb * recFrac,
    fate: "recombine",
    recombineFrom: 0.6,
    spread: 0.3
  });
  if (saturated) {
    // forward-biased collector junction: majority carriers of the base flood the collector
    out.push({
      carrier: maj,
      pts: [
        [bx, 0.01],
        [bx + 0.6, baseMid],
        [g.cutX + 0.5, cL],
        [g.cutX + 0.6, cR + 0.4]
      ],
      speed: [0.7, 0.8, 1.2],
      jitter: [0.01, 0.01, 0.03],
      rate: Math.max(rIb * 0.5, 1),
      fate: "recombine",
      recombineFrom: 0.8,
      spread: 0.3
    });
  }
  return out;
}

function mosFlows(def: DeviceDefinition, op: OperatingPoint): FlowPath[] {
  const v = op.values;
  const id = Math.max(v.id, 0);
  const carrier: Carrier = def.polarity === 1 ? "n" : "p";
  const r = rateFor(id);
  if (r <= 0) return [];
  const xs = v.xs;
  const xd = v.xd;
  const sub = op.tone === "off";
  const yc = sub ? 0.018 : 0.004;
  const pinch = isFinite(v.xPinch) ? v.xPinch : xd;
  const sx = 0.78;
  const dxp = 2.42;
  const pts: Array<[number, number]> = [
    [sx, 0.005],
    [sx + 0.15, 0.07],
    [xs - 0.08, 0.04],
    [xs, yc],
    [pinch, yc]
  ];
  const speed = [0.35, 0.35, 0.35, 0.4];
  const jitter = [0.004, 0.004, 0.003, 0.0012];
  if (pinch < xd - 0.01) {
    // pinch-off: carriers are injected into the drain depletion region and spread below the surface
    pts.push([xd + 0.02, 0.05]);
    speed.push(1.4);
    jitter.push(0.004);
  }
  pts.push([dxp - 0.1, 0.07], [dxp, 0.005]);
  speed.push(0.35, 0.35);
  jitter.push(0.004, 0.004);
  return [{ carrier, pts, speed, jitter, rate: r, fate: "exit", spread: 0.06, spreadY: sub ? 0.02 : 0.004 }];
}
