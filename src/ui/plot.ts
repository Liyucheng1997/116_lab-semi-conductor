/** Minimal engineering plot: lin/log axes, twin y axis, bands, markers, hover read-out, click-to-set. */

export interface PlotSeries {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  color: string;
  width?: number;
  dash?: number[];
  label?: string;
  axis?: "left" | "right";
  fill?: string;
  hideInTooltip?: boolean;
}

export interface PlotSpec {
  xLabel: string;
  yLabel: string;
  y2Label?: string;
  xUnit?: string;
  yUnit?: string;
  y2Unit?: string;
  yScale: "lin" | "log";
  xRange?: [number, number];
  yRange?: [number, number];
  y2Range?: [number, number];
  series: PlotSeries[];
  bands?: Array<{ x0: number; x1: number; color: string; label?: string }>;
  vlines?: Array<{ x: number; color: string; dash?: number[]; label?: string }>;
  markers?: Array<{ x: number; y: number; color: string; axis?: "left" | "right"; label?: string }>;
  texts?: Array<{ x: number; y: number; text: string; color: string; axis?: "left" | "right"; align?: CanvasTextAlign }>;
  legend?: boolean;
  /** SI-prefix the linear y axis (e.g. currents in A → mA) */
  siY?: boolean;
  siY2?: boolean;
}

const THEME = {
  grid: "rgba(160,180,200,0.08)",
  axis: "rgba(160,180,200,0.45)",
  text: "#93a3b4",
  strong: "#d8e2ec",
  font: "11px Inter, 'Segoe UI', 'Microsoft YaHei', sans-serif"
};

const SUP: Record<string, string> = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
const sup = (n: number) =>
  String(n)
    .split("")
    .map((c) => SUP[c] ?? c)
    .join("");

function niceStep(span: number, count: number) {
  const raw = span / Math.max(count, 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / mag;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * mag;
}

function linTicks(min: number, max: number, count: number) {
  const step = niceStep(max - min || 1, count);
  const out: number[] = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

const PREFIX: Array<[number, string]> = [
  [1e9, "G"],
  [1e6, "M"],
  [1e3, "k"],
  [1, ""],
  [1e-3, "m"],
  [1e-6, "μ"],
  [1e-9, "n"],
  [1e-12, "p"],
  [1e-15, "f"]
];

function siScale(maxAbs: number) {
  for (const [m, p] of PREFIX) if (maxAbs >= m * 0.999) return { m, p };
  return { m: 1e-15, p: "f" };
}

function fmtTick(v: number, step: number) {
  const d = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return v.toFixed(Math.min(d, 4));
}

export function formatValue(v: number, unit = "") {
  if (!isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a === 0) return `0 ${unit}`;
  if (!unit || unit === "V" || unit === "eV" || unit === "μm" || unit === "kV/cm") {
    if (a >= 1e4 || a < 1e-3) return `${v.toExponential(2)} ${unit}`;
    return `${v.toPrecision(4)} ${unit}`;
  }
  if (unit.startsWith("cm")) return `${v.toExponential(2)} ${unit}`;
  const { m, p } = siScale(a);
  return `${(v / m).toPrecision(3)} ${p}${unit}`;
}

interface Frame {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  y2: [number, number] | null;
  ylog: boolean;
  yScale: { m: number; p: string };
  y2Scale: { m: number; p: string };
}

export class Plot {
  private ctx: CanvasRenderingContext2D;
  private spec: PlotSpec | null = null;
  private frame: Frame | null = null;
  private hoverX: number | null = null;
  private dragging = false;
  onPick: ((x: number) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    new ResizeObserver(() => this.render()).observe(canvas);
    canvas.addEventListener("pointermove", (e) => {
      this.hoverX = e.offsetX;
      if (this.dragging) this.pick(e.offsetX);
      this.render();
    });
    canvas.addEventListener("pointerleave", () => {
      this.hoverX = null;
      this.render();
    });
    canvas.addEventListener("pointerdown", (e) => {
      if (!this.onPick) return;
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      this.pick(e.offsetX);
    });
    canvas.addEventListener("pointerup", (e) => {
      this.dragging = false;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    });
  }

  private pick(px: number) {
    const f = this.frame;
    if (!f || !this.onPick) return;
    const t = Math.min(Math.max((px - f.left) / (f.right - f.left), 0), 1);
    this.onPick(f.x0 + t * (f.x1 - f.x0));
  }

  draw(spec: PlotSpec) {
    this.spec = spec;
    this.render();
  }

  private computeFrame(spec: PlotSpec, w: number, h: number): Frame {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    let a0 = Infinity;
    let a1 = -Infinity;
    for (const s of spec.series) {
      for (let i = 0; i < s.x.length; i += 1) {
        const x = s.x[i];
        const y = s.y[i];
        if (!isFinite(x) || !isFinite(y)) continue;
        if (spec.yScale === "log" && s.axis !== "right" && y <= 0) continue;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        if (s.axis === "right") {
          a0 = Math.min(a0, y);
          a1 = Math.max(a1, y);
        } else {
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
      }
    }
    if (spec.xRange) [x0, x1] = spec.xRange;
    if (!isFinite(x0)) [x0, x1] = [0, 1];
    if (spec.yRange) [y0, y1] = spec.yRange;
    if (!isFinite(y0)) [y0, y1] = spec.yScale === "log" ? [1e-12, 1] : [0, 1];
    if (spec.yScale === "log") {
      y0 = Math.pow(10, Math.floor(Math.log10(y0)));
      y1 = Math.pow(10, Math.ceil(Math.log10(y1)));
      if (y1 <= y0) y1 = y0 * 10;
    } else if (!spec.yRange) {
      const pad = (y1 - y0) * 0.06 || Math.abs(y1) * 0.1 || 1;
      y0 -= pad;
      y1 += pad;
    }
    let y2: [number, number] | null = null;
    if (spec.series.some((s) => s.axis === "right")) {
      if (spec.y2Range) y2 = spec.y2Range;
      else {
        const pad = (a1 - a0) * 0.06 || 1;
        y2 = [a0 - pad, a1 + pad];
      }
    }
    const yScale = spec.siY && spec.yScale === "lin" ? siScale(Math.max(Math.abs(y0), Math.abs(y1))) : { m: 1, p: "" };
    const y2Scale = spec.siY2 && y2 ? siScale(Math.max(Math.abs(y2[0]), Math.abs(y2[1]))) : { m: 1, p: "" };
    const left = 50;
    const right = w - (y2 ? 46 : 12);
    return { x0, x1, y0, y1, left, right, top: 10, bottom: h - 30, y2, ylog: spec.yScale === "log", yScale, y2Scale };
  }

  private render() {
    const canvas = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w < 10 || h < 10) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const spec = this.spec;
    if (!spec) return;
    const f = this.computeFrame(spec, w, h);
    this.frame = f;
    const X = (x: number) => f.left + ((x - f.x0) / (f.x1 - f.x0)) * (f.right - f.left);
    const Y = (y: number) => {
      if (f.ylog) {
        const l = Math.log10(Math.max(y, 1e-300));
        return f.bottom - ((l - Math.log10(f.y0)) / (Math.log10(f.y1) - Math.log10(f.y0))) * (f.bottom - f.top);
      }
      return f.bottom - ((y - f.y0) / (f.y1 - f.y0)) * (f.bottom - f.top);
    };
    const Y2 = (y: number) => (f.y2 ? f.bottom - ((y - f.y2[0]) / (f.y2[1] - f.y2[0])) * (f.bottom - f.top) : 0);
    ctx.font = THEME.font;

    // bands
    for (const b of spec.bands ?? []) {
      const a = Math.max(X(b.x0), f.left);
      const c = Math.min(X(b.x1), f.right);
      if (c <= a) continue;
      ctx.fillStyle = b.color;
      ctx.fillRect(a, f.top, c - a, f.bottom - f.top);
      if (b.label && c - a > 26) {
        ctx.fillStyle = THEME.text;
        ctx.textAlign = "left";
        ctx.fillText(b.label, a + 4, f.top + 12);
      }
    }

    // grid + ticks
    ctx.strokeStyle = THEME.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = THEME.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const xt = linTicks(f.x0, f.x1, Math.max(3, Math.floor((f.right - f.left) / 70)));
    const xstep = xt.length > 1 ? xt[1] - xt[0] : 1;
    for (const t of xt) {
      const px = X(t);
      ctx.beginPath();
      ctx.moveTo(px, f.top);
      ctx.lineTo(px, f.bottom);
      ctx.stroke();
      ctx.fillText(fmtTick(t, xstep), px, f.bottom + 4);
    }
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    if (f.ylog) {
      const e0 = Math.round(Math.log10(f.y0));
      const e1 = Math.round(Math.log10(f.y1));
      const span = e1 - e0;
      const every = Math.max(1, Math.ceil(span / Math.max(2, Math.floor((f.bottom - f.top) / 22))));
      for (let e = e0; e <= e1; e += 1) {
        const py = Y(Math.pow(10, e));
        ctx.beginPath();
        ctx.moveTo(f.left, py);
        ctx.lineTo(f.right, py);
        ctx.stroke();
        if ((e - e0) % every === 0) ctx.fillText(`10${sup(e)}`, f.left - 5, py);
      }
    } else {
      const yt = linTicks(f.y0, f.y1, Math.max(3, Math.floor((f.bottom - f.top) / 34)));
      const ystep = yt.length > 1 ? yt[1] - yt[0] : 1;
      for (const t of yt) {
        const py = Y(t);
        ctx.beginPath();
        ctx.moveTo(f.left, py);
        ctx.lineTo(f.right, py);
        ctx.stroke();
        ctx.fillText(fmtTick(t / f.yScale.m, ystep / f.yScale.m), f.left - 5, py);
      }
      if (f.y0 < 0 && f.y1 > 0) {
        ctx.strokeStyle = THEME.axis;
        ctx.beginPath();
        ctx.moveTo(f.left, Y(0));
        ctx.lineTo(f.right, Y(0));
        ctx.stroke();
        ctx.strokeStyle = THEME.grid;
      }
    }
    if (f.y2) {
      ctx.textAlign = "left";
      const yt = linTicks(f.y2[0], f.y2[1], Math.max(3, Math.floor((f.bottom - f.top) / 34)));
      const ystep = yt.length > 1 ? yt[1] - yt[0] : 1;
      for (const t of yt) ctx.fillText(fmtTick(t / f.y2Scale.m, ystep / f.y2Scale.m), f.right + 5, Y2(t));
    }
    if (f.x0 < 0 && f.x1 > 0) {
      ctx.strokeStyle = THEME.axis;
      ctx.beginPath();
      ctx.moveTo(X(0), f.top);
      ctx.lineTo(X(0), f.bottom);
      ctx.stroke();
    }
    // frame
    ctx.strokeStyle = THEME.axis;
    ctx.strokeRect(f.left + 0.5, f.top + 0.5, f.right - f.left, f.bottom - f.top);

    // axis labels
    ctx.fillStyle = THEME.text;
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(`${spec.xLabel}${spec.xUnit ? ` (${spec.xUnit})` : ""}`, f.right, h - 3);
    ctx.save();
    ctx.translate(11, (f.top + f.bottom) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    const yu = spec.yUnit ? ` (${f.yScale.p}${spec.yUnit})` : "";
    ctx.fillText(`${spec.yLabel}${yu}`, 0, 0);
    ctx.restore();
    if (f.y2 && spec.y2Label) {
      ctx.save();
      ctx.translate(w - 6, (f.top + f.bottom) / 2);
      ctx.rotate(Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillText(`${spec.y2Label}${spec.y2Unit ? ` (${f.y2Scale.p}${spec.y2Unit})` : ""}`, 0, 0);
      ctx.restore();
    }

    // series
    ctx.save();
    ctx.beginPath();
    ctx.rect(f.left, f.top, f.right - f.left, f.bottom - f.top);
    ctx.clip();
    for (const s of spec.series) {
      const yy = s.axis === "right" ? Y2 : Y;
      if (s.fill) {
        ctx.beginPath();
        let started = false;
        let firstX = 0;
        let lastX = 0;
        for (let i = 0; i < s.x.length; i += 1) {
          const y = s.y[i];
          if (!isFinite(y)) continue;
          const px = X(s.x[i]);
          if (!started) {
            ctx.moveTo(px, yy(0));
            firstX = px;
            started = true;
          }
          ctx.lineTo(px, yy(y));
          lastX = px;
        }
        ctx.lineTo(lastX, yy(0));
        ctx.lineTo(firstX, yy(0));
        ctx.fillStyle = s.fill;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width ?? 1.6;
      ctx.setLineDash(s.dash ?? []);
      let pen = false;
      for (let i = 0; i < s.x.length; i += 1) {
        const y = s.y[i];
        if (!isFinite(y) || (f.ylog && s.axis !== "right" && y <= 0)) {
          pen = false;
          continue;
        }
        const px = X(s.x[i]);
        const py = Math.min(Math.max(yy(y), -1e4), 1e4);
        if (!pen) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
        pen = true;
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const v of spec.vlines ?? []) {
      const px = X(v.x);
      ctx.strokeStyle = v.color;
      ctx.setLineDash(v.dash ?? [3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, f.top);
      ctx.lineTo(px, f.bottom);
      ctx.stroke();
      if (v.label) {
        ctx.fillStyle = v.color;
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(v.label, px + 3, f.bottom - 3);
      }
    }
    ctx.setLineDash([]);
    for (const t of spec.texts ?? []) {
      const yy = t.axis === "right" ? Y2 : Y;
      ctx.fillStyle = t.color;
      ctx.textAlign = t.align ?? "left";
      ctx.textBaseline = "bottom";
      ctx.font = "600 11px Inter, 'Segoe UI', sans-serif";
      ctx.fillText(t.text, X(t.x), yy(t.y) - 2);
      ctx.font = THEME.font;
    }
    for (const m of spec.markers ?? []) {
      const yy = m.axis === "right" ? Y2 : Y;
      const px = X(m.x);
      const py = yy(m.y);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(px, f.bottom);
      ctx.lineTo(px, py);
      ctx.lineTo(f.left, py);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.arc(px, py, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#0d1117";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();

    // legend (top-right, right-aligned rows)
    if (spec.legend) {
      const items = spec.series.filter((s) => s.label && !s.hideInTooltip);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const rows: Array<Array<{ s: PlotSeries; w: number }>> = [[]];
      let rowW = 0;
      const maxW = (f.right - f.left) * 0.9;
      for (const s of items) {
        const w = ctx.measureText(s.label as string).width + 26;
        if (rowW + w > maxW && rows[rows.length - 1].length) {
          rows.push([]);
          rowW = 0;
        }
        rows[rows.length - 1].push({ s, w });
        rowW += w;
      }
      rows.forEach((row, r) => {
        const total = row.reduce((acc, q) => acc + q.w, 0);
        let lx = f.right - 6 - total;
        const ly = f.top + 10 + r * 14;
        ctx.fillStyle = "rgba(13,18,24,0.72)";
        ctx.fillRect(lx - 4, ly - 7, total + 4, 14);
        for (const { s, w } of row) {
          ctx.strokeStyle = s.color;
          ctx.lineWidth = 2;
          ctx.setLineDash(s.dash ?? []);
          ctx.beginPath();
          ctx.moveTo(lx, ly);
          ctx.lineTo(lx + 14, ly);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = THEME.strong;
          ctx.fillText(s.label as string, lx + 18, ly);
          lx += w;
        }
      });
    }

    // hover read-out
    if (this.hoverX !== null && this.hoverX >= f.left && this.hoverX <= f.right) {
      const xv = f.x0 + ((this.hoverX - f.left) / (f.right - f.left)) * (f.x1 - f.x0);
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(this.hoverX, f.top);
      ctx.lineTo(this.hoverX, f.bottom);
      ctx.stroke();
      const rows: Array<[string, string, string]> = [["", `${spec.xLabel} = ${formatValue(xv, spec.xUnit)}`, THEME.strong]];
      for (const s of spec.series) {
        if (!s.label || s.hideInTooltip) continue;
        const y = interp(s.x, s.y, xv);
        if (y === null) continue;
        const unit = s.axis === "right" ? spec.y2Unit : spec.yUnit;
        rows.push([s.color, `${s.label}: ${formatValue(y, unit)}`, THEME.strong]);
        const py = (s.axis === "right" ? Y2 : Y)(y);
        if (py >= f.top && py <= f.bottom) {
          ctx.fillStyle = s.color;
          ctx.beginPath();
          ctx.arc(this.hoverX, py, 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      const shown = rows.slice(0, 8);
      const bw = Math.max(...shown.map((r) => ctx.measureText(r[1]).width)) + 22;
      const bh = shown.length * 15 + 8;
      let bx = this.hoverX + 10;
      if (bx + bw > f.right) bx = this.hoverX - 10 - bw;
      const by = f.top + 6;
      ctx.fillStyle = "rgba(10,14,20,0.9)";
      ctx.strokeStyle = "rgba(160,180,200,0.25)";
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 5);
      ctx.fill();
      ctx.stroke();
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      shown.forEach((r, i) => {
        const yy = by + 11 + i * 15;
        if (r[0]) {
          ctx.fillStyle = r[0];
          ctx.fillRect(bx + 7, yy - 3, 7, 7);
        }
        ctx.fillStyle = r[2];
        ctx.fillText(r[1], bx + (r[0] ? 18 : 7), yy);
      });
    }
  }
}

function interp(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const asc = xs[n - 1] > xs[0];
  const lo0 = asc ? xs[0] : xs[n - 1];
  const hi0 = asc ? xs[n - 1] : xs[0];
  if (x < lo0 || x > hi0) return null;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (asc ? xs[mid] <= x : xs[mid] >= x) lo = mid;
    else hi = mid;
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo] || 1);
  const y = ys[lo] + (ys[hi] - ys[lo]) * t;
  return isFinite(y) ? y : null;
}
