import "./styles.css";
import * as THREE from "three";
import { deviceOrder, devices, finalState, runProcess } from "./devices/registry";
import { categoryName, type BiasControl, type CutlineDef, type DeviceDefinition, type DeviceKey } from "./devices/types";
import { createCompactModel, type CompactModel, type CurveView, type OperatingPoint } from "./physics/compact";
import { extractCut, type CutData } from "./physics/cutline";
import { depthProfile, findJunctions, type ProcessState } from "./physics/process";
import { LUT, dopingGradientCss, lutGradientCss } from "./render/colormap";
import { DeviceView, type DimSpec } from "./render/device";
import { ProcessEffects, stackTopAll } from "./render/effects";
import { FIELDS, MeshSampler, paintDoping, paintField, type ColorScale, type FieldKey } from "./render/faces";
import { buildFlows } from "./render/flows";
import { CarrierAnimator } from "./render/particles";
import { Stage } from "./render/stage";
import { deviceIntro, explainPhysics, summarizeCut } from "./ui/explain";
import { Plot, type PlotSeries, type PlotSpec } from "./ui/plot";
import { schematic } from "./ui/schematic";
import { SimClient } from "./worker/client";
import type { MeshInfo, ProcessMapsResult, SolveResultMsg } from "./worker/protocol";

type Mode = "process" | "physics";

function $(sel: string) {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el as HTMLElement;
}

const ui = {
  tabs: $("#deviceTabs"),
  modeButtons: Array.from(document.querySelectorAll<HTMLButtonElement>(".mode-switch button")),
  status: $("#status"),
  devName: $("#devName"),
  devEng: $("#devEng"),
  viewButtons: Array.from(document.querySelectorAll<HTMLButtonElement>("#viewButtons button")),
  toggles: Array.from(document.querySelectorAll<HTMLInputElement>("#toggles input")),
  fieldSelect: $("#fieldSelect") as HTMLSelectElement,
  legendTitle: $("#legendTitle"),
  colorbar: $("#colorbar"),
  colorbarTicks: $("#colorbarTicks"),
  legendKeys: $("#legendKeys"),
  stepCaption: $("#stepCaption"),
  scaleBar: $("#scaleBar"),
  stepCounter: $("#stepCounter"),
  stepList: $("#stepList"),
  stepDetail: $("#stepDetail"),
  playBtn: $("#playBtn") as HTMLButtonElement,
  transport: Array.from(document.querySelectorAll<HTMLButtonElement>(".transport button")),
  biasControls: $("#biasControls"),
  schematic: $("#schematic"),
  sweepBtn: $("#sweepBtn") as HTMLButtonElement,
  region: $("#regionBadge"),
  readouts: $("#readouts"),
  explain: $("#explain"),
  params: $("#params"),
  intro: $("#intro"),
  cutSelect: $("#cutSelect") as HTMLSelectElement,
  dockNote: $("#dockNote"),
  cards: $("#cards")
};

const stage = new Stage($("#scene"));
const client = new SimClient();

interface Ctx {
  def: DeviceDefinition;
  view: DeviceView;
  effects: ProcessEffects;
  carriers: CarrierAnimator;
  model: CompactModel;
  final: ProcessState;
  mesh: MeshInfo | null;
  sampler: MeshSampler | null;
  finalMaps: ProcessMapsResult | null;
  solution: SolveResultMsg | null;
  op: OperatingPoint | null;
  curves: CurveView[];
  cut: CutData | null;
  junctionDepths: number[];
}

const state = {
  device: "npn" as DeviceKey,
  mode: "physics" as Mode,
  step: 0,
  bias: {} as Record<string, number>,
  field: "n" as FieldKey,
  cut: "v",
  iv: "out",
  toggles: { labels: true, dims: true, ild: true, metal: true, carriers: true },
  playing: false,
  sweeping: false,
  view: "iso" as "iso" | "front" | "top"
};

let ctx: Ctx | null = null;
const mapCache = new Map<string, Promise<ProcessMapsResult>>();
let mapToken = 0;
let playTimer = 0;

const PALETTE = ["#54adff", "#58d68d", "#e8c547", "#ff9f5a", "#ff5c6c", "#c792ea", "#6ff0ff"];

/* ======================================================================== helpers == */

function pxPerUm(def: DeviceDefinition) {
  return 720 / (def.domain.x1 - def.domain.x0);
}

function getMaps(key: DeviceKey, step: number, fraction = 1) {
  const id = `${key}:${step}:${fraction.toFixed(2)}`;
  let p = mapCache.get(id);
  if (!p) {
    p = client.processMaps(key, step, fraction, pxPerUm(devices[key]));
    mapCache.set(id, p);
    if (mapCache.size > 60) mapCache.delete(mapCache.keys().next().value as string);
  }
  return p;
}

function setStatus(text: string, busy = false) {
  ui.status.classList.toggle("busy", busy);
  (ui.status.querySelector("span") as HTMLElement).textContent = text;
}

function defaultField(def: DeviceDefinition): FieldKey {
  if (def.family === "diode") return "psi";
  return def.polarity === 1 ? "n" : "p";
}

function lastStep(def: DeviceDefinition) {
  return def.recipe.length - 1;
}

function currentCut(def: DeviceDefinition): CutlineDef {
  return def.cutlines.find((c) => c.id === state.cut) ?? def.cutlines[0];
}

/* =================================================================== device load == */

function buildDeviceTabs() {
  ui.tabs.innerHTML = "";
  deviceOrder.forEach((key) => {
    const b = document.createElement("button");
    b.textContent = devices[key].name.replace(" 双极型晶体管", " BJT").replace(" 沟道 MOSFET", "MOS");
    b.dataset.device = key;
    b.addEventListener("click", () => loadDevice(key));
    ui.tabs.appendChild(b);
  });
}

function loadDevice(key: DeviceKey, mode: Mode = state.mode) {
  stopPlay();
  stopSweep();
  if (ctx) {
    ctx.carriers.dispose();
    ctx.effects.dispose();
    ctx.view.dispose();
  }
  const def = devices[key];
  state.device = key;
  state.bias = Object.fromEntries(def.bias.map((b) => [b.key, b.value]));
  state.field = defaultField(def);
  state.cut = def.cutlines[0].id;
  state.iv = def.family === "diode" ? "fwd" : "out";
  const final = finalState(def);
  const view = new DeviceView(stage, def);
  const vcut = def.cutlines.find((c) => c.orientation === "vertical") ?? def.cutlines[0];
  const junctionDepths = findJunctions(depthProfile(final, vcut.at, 0, 0, def.domain.y1, 1200));
  ctx = {
    def,
    view,
    effects: new ProcessEffects(view),
    carriers: new CarrierAnimator(view),
    model: createCompactModel(def, final),
    final,
    mesh: null,
    sampler: null,
    finalMaps: null,
    solution: null,
    op: null,
    curves: [],
    cut: null,
    junctionDepths
  };
  const c = ctx;
  ui.tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.device === key));
  ui.devName.textContent = def.name;
  ui.devEng.textContent = def.english;
  ui.intro.textContent = deviceIntro(def);
  buildFieldSelect();
  buildCutSelect();
  buildBiasControls();
  buildStepList();
  view.setVisibility({ ild: state.toggles.ild, metal: state.toggles.metal });
  client.mesh(key).then((mesh) => {
    if (ctx !== c) return;
    c.mesh = mesh;
    getMaps(key, lastStep(def)).then((maps) => {
      if (ctx !== c) return;
      c.finalMaps = maps;
      const d = def.domain;
      c.sampler = new MeshSampler(mesh, maps.front.width, maps.front.height, d.x0, d.x1, maps.siliconTop, d.y1);
      if (state.mode === "physics") {
        paintFront();
        refreshPhysicsPlots();
      }
    });
  });
  state.step = lastStep(def);
  setMode(mode, true);
  frameView(state.view, 0.01);
  updateHash();
}

/* ========================================================================== modes == */

function setMode(mode: Mode, force = false) {
  if (!ctx) return;
  if (state.mode === mode && !force) return;
  state.mode = mode;
  document.body.classList.toggle("mode-process", mode === "process");
  document.body.classList.toggle("mode-physics", mode === "physics");
  ui.modeButtons.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  stopPlay();
  stopSweep();
  // interlayer dielectrics hide the cross-section: shown while building the device, hidden for physics
  setToggle("ild", mode === "process");
  buildCards();
  if (mode === "process") {
    ctx.carriers.setEnabled(false);
    setStep(state.step, false);
  } else {
    enterPhysics();
  }
  updateHash();
  frameView(state.view);
}

function enterPhysics() {
  if (!ctx) return;
  const c = ctx;
  mapToken += 1;
  c.view.setProcess(c.final, false);
  c.view.setGlow(false);
  c.effects.clear();
  c.carriers.setEnabled(state.toggles.carriers);
  c.view.setLabels(c.def, state.toggles.labels, true);
  c.view.setCutline(currentCut(c.def), 0);
  getMaps(c.def.key, lastStep(c.def)).then((maps) => {
    if (ctx !== c || state.mode !== "physics") return;
    paintContextFaces(maps);
    if (!c.solution) c.view.setFaceCanvas("front", paintDoping(maps.front));
    paintFront();
  });
  updateLegend();
  onBiasChanged(true);
}

function setToggle(key: keyof typeof state.toggles, value: boolean) {
  state.toggles[key] = value;
  const input = ui.toggles.find((t) => t.dataset.toggle === key);
  if (input) input.checked = value;
  ctx?.view.setVisibility({ ild: state.toggles.ild, metal: state.toggles.metal });
}

/* ======================================================================== process == */

function buildStepList() {
  if (!ctx) return;
  ui.stepList.innerHTML = "";
  ctx.def.recipe.forEach((step, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="chip ${step.category}">${categoryName[step.category]}</span><span>${step.title}</span>`;
    li.addEventListener("click", () => {
      stopPlay();
      setStep(i, true);
    });
    ui.stepList.appendChild(li);
  });
}

function paintContextFaces(maps: ProcessMapsResult) {
  if (!ctx) return;
  ctx.view.setFaceCanvas("top", paintDoping(maps.top, { dim: 0.12 }));
  ctx.view.setFaceCanvas("right", paintDoping(maps.right, { dim: 0.5 }));
  ctx.view.setFaceCanvas("left", paintDoping(maps.left, { dim: 0.5 }));
}

async function setStep(i: number, animate: boolean) {
  if (!ctx) return;
  const c = ctx;
  const def = c.def;
  i = Math.min(Math.max(i, 0), lastStep(def));
  state.step = i;
  const ps = runProcess(def, i);
  const finished = i === lastStep(def);
  c.view.setProcess(ps, animate);
  c.effects.show(ps.anim, ps);
  c.view.setLabels(def, state.toggles.labels && finished, finished);
  c.view.setDimensions(state.toggles.dims && finished ? processDims(c) : []);
  c.view.setCutline(state.toggles.labels ? currentCut(def) : null, ps.siliconTop);
  updateProcessPanel(ps);
  updateLegend();
  setStatus(`工艺仿真 · 共 ${def.recipe.length} 步 · 当前第 ${i + 1} 步`, false);
  const token = ++mapToken;
  const fractions = animate && ps.anim.kind === "anneal" ? [0.12, 0.3, 0.55, 0.8, 1] : [1];
  for (const f of fractions) {
    const maps = await getMaps(def.key, i, f);
    if (token !== mapToken || ctx !== c || state.mode !== "process") return;
    paintContextFaces(maps);
    c.view.setFaceCanvas("front", paintDoping(maps.front, { glow: ps.anim.kind === "anneal" && f < 1 ? 0.25 : 0 }));
    if (f === 1) refreshProcessPlots(maps, ps);
    if (fractions.length > 1 && f < 1) await new Promise((r) => setTimeout(r, 260));
  }
}

function updateProcessPanel(ps: ProcessState) {
  if (!ctx) return;
  const def = ctx.def;
  const i = state.step;
  const step = def.recipe[i];
  ui.stepCounter.textContent = `步骤 ${i + 1} / ${def.recipe.length}`;
  Array.from(ui.stepList.children).forEach((li, k) => {
    li.classList.toggle("current", k === i);
    li.classList.toggle("done", k < i);
    li.classList.toggle("todo", k > i);
  });
  const cur = ui.stepList.children[i] as HTMLElement | undefined;
  cur?.scrollIntoView({ block: "nearest" });
  const params = step.params.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  const results = ps.results.length
    ? `<div class="results"><h4>本步仿真结果</h4><dl class="kv">${ps.results.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl></div>`
    : "";
  const hint =
    i === lastStep(def)
      ? `<div class="next-hint">工艺完成。切换到"器件物理"，在这个结构上求解泊松方程、查看能带与 I–V 特性。<button id="gotoPhysics">② 进入器件物理 →</button></div>`
      : "";
  ui.stepDetail.innerHTML = `
    <h3>${step.title}</h3>
    <p class="equip"><span class="chip ${step.category}">${categoryName[step.category]}</span> ${step.equipment}</p>
    <dl class="kv">${params}</dl>
    <p>${step.description}</p>
    ${results}${hint}`;
  document.getElementById("gotoPhysics")?.addEventListener("click", () => setMode("physics"));
  ui.stepCaption.innerHTML = `<span class="cat">${categoryName[step.category]}</span><b>${i + 1}/${def.recipe.length}</b> ${step.title} <span class="muted">— ${step.params
    .slice(0, 2)
    .map((p) => p[1])
    .join(" · ")}</span>`;
}

function processDims(c: Ctx): DimSpec[] {
  const def = c.def;
  const j = c.junctionDepths;
  if (def.family === "diode" && j.length) return [{ a: [5.3, 0], b: [5.3, j[0]], text: `x_j = ${j[0].toFixed(2)} μm`, side: "right", offset: 0.12 }];
  if (def.family === "bjt" && j.length >= 2)
    return [
      { a: [3.3, 0], b: [3.3, j[0]], text: `x_jE = ${(j[0] * 1000).toFixed(0)} nm`, side: "left", offset: 0.12 },
      { a: [4.15, j[0]], b: [4.15, j[1]], text: `W_B = ${((j[1] - j[0]) * 1000).toFixed(0)} nm`, side: "right", offset: 0.12 }
    ];
  if (def.family === "mos") {
    const f = c.final.params;
    const sd = findJunctions(depthProfile(c.final, 2.55, 0, 0, 1, 800));
    const out: DimSpec[] = [{ a: [f.xs, 0.2], b: [f.xd, 0.2], text: `L_eff = ${(f.leff * 1000).toFixed(0)} nm`, side: "bottom", offset: 0.02 }];
    if (sd.length) out.push({ a: [2.72, 0], b: [2.72, sd[0]], text: `x_j = ${(sd[0] * 1000).toFixed(0)} nm`, side: "left", offset: 0.05 });
    return out;
  }
  return [];
}

function physicsDims(c: Ctx): DimSpec[] {
  const op = c.op;
  if (!op) return [];
  const v = op.values;
  if (c.def.family === "diode") {
    const dims = processDims(c);
    const w = diodeDepletion2D(c);
    if (w) dims.push({ a: [2.9, w[0]], b: [2.9, w[1]], text: `W = ${(w[1] - w[0]).toFixed(3)} μm`, side: "left", offset: 0.12 });
    else if (!c.cut) dims.push({ a: [2.9, v.left], b: [2.9, v.right], text: `W = ${(v.right - v.left).toFixed(2)} μm`, side: "left", offset: 0.12 });
    return dims;
  }
  if (c.def.family === "bjt")
    return [
      { a: [3.3, 0], b: [3.3, c.junctionDepths[0]], text: `x_jE = ${(c.junctionDepths[0] * 1000).toFixed(0)} nm`, side: "left", offset: 0.12 },
      { a: [4.15, v.eR], b: [4.15, v.cL], text: `W_B = ${(v.wb * 1000).toFixed(0)} nm`, side: "right", offset: 0.12 }
    ];
  return processDims(c);
}

/** Depletion edges of the anode junction taken from the 2-D solution along the vertical cut. */
function diodeDepletion2D(c: Ctx): [number, number] | null {
  const cut = c.cut;
  if (!cut || currentCut(c.def).orientation !== "vertical" || !c.junctionDepths.length) return null;
  const xj = c.junctionDepths[0];
  let lo = -1;
  let hi = -1;
  for (let i = 0; i < cut.t.length; i += 1) {
    const dep = Math.abs(cut.neutral[i]) < 0.5;
    if (dep && lo < 0 && cut.t[i] <= xj + 0.05) lo = i;
    if (!dep && lo >= 0 && cut.t[i] > xj) {
      hi = i;
      break;
    }
    if (!dep && cut.t[i] < xj) lo = -1;
  }
  if (lo < 0 || hi < 0) return null;
  return [cut.t[lo], cut.t[hi]];
}

function stepMove(kind: string) {
  if (!ctx) return;
  const last = lastStep(ctx.def);
  if (kind === "play") {
    if (state.playing) stopPlay();
    else startPlay();
    return;
  }
  stopPlay();
  const target = kind === "first" ? 0 : kind === "last" ? last : kind === "prev" ? state.step - 1 : state.step + 1;
  setStep(target, true);
}

function startPlay() {
  if (!ctx) return;
  state.playing = true;
  ui.playBtn.textContent = "❚❚ 暂停";
  if (state.step >= lastStep(ctx.def)) setStep(0, true);
  const tick = () => {
    if (!ctx || !state.playing) return;
    if (state.step >= lastStep(ctx.def)) {
      stopPlay();
      return;
    }
    setStep(state.step + 1, true);
    const kind = ctx.def.recipe[state.step].category;
    playTimer = window.setTimeout(tick, kind === "anneal" || kind === "implant" || kind === "litho" ? 3200 : 2200);
  };
  playTimer = window.setTimeout(tick, 1800);
}

function stopPlay() {
  state.playing = false;
  window.clearTimeout(playTimer);
  ui.playBtn.textContent = "▶ 播放";
}

/* ======================================================================== physics == */

function buildBiasControls() {
  if (!ctx) return;
  ui.biasControls.innerHTML = "";
  ctx.def.bias.forEach((b: BiasControl) => {
    const row = document.createElement("div");
    row.className = "bias-row";
    row.innerHTML = `<div class="bias-label"><span>${b.label}</span><span><input type="number" step="${b.step * 10}" min="${b.min}" max="${b.max}"> ${b.unit}</span></div>
      <input type="range" min="${b.min}" max="${b.max}" step="${b.step}">`;
    const num = row.querySelector("input[type=number]") as HTMLInputElement;
    const range = row.querySelector("input[type=range]") as HTMLInputElement;
    const sync = () => {
      range.value = String(state.bias[b.key]);
      num.value = state.bias[b.key].toFixed(b.step < 0.01 ? 3 : 2);
    };
    range.addEventListener("input", () => {
      stopSweep();
      state.bias[b.key] = Number(range.value);
      num.value = state.bias[b.key].toFixed(b.step < 0.01 ? 3 : 2);
      onBiasChanged();
    });
    num.addEventListener("change", () => {
      stopSweep();
      state.bias[b.key] = Math.min(Math.max(Number(num.value), b.min), b.max);
      sync();
      onBiasChanged();
    });
    row.dataset.key = b.key;
    (row as unknown as { sync: () => void }).sync = sync;
    ui.biasControls.appendChild(row);
    sync();
  });
}

function syncBiasControls() {
  ui.biasControls.querySelectorAll<HTMLElement>(".bias-row").forEach((row) => (row as unknown as { sync: () => void }).sync());
}

let curvesFrame = 0;

function onBiasChanged(immediate = false) {
  if (!ctx) return;
  const c = ctx;
  // the diode has separate forward / reverse plots: follow the operating point
  if (c.def.family === "diode" && (state.iv === "fwd" || state.iv === "rev")) {
    const want = state.bias.VA < 0 ? "rev" : "fwd";
    if (want !== state.iv) {
      state.iv = want;
      immediate = true;
    }
  }
  c.op = c.model.evaluate(state.bias);
  updatePhysicsPanel();
  c.carriers.setFlows(buildFlows(c.def, c.op));
  c.view.setDimensions(state.toggles.dims ? physicsDims(c) : []);
  client.requestSolve(c.def.key, state.bias);
  if (immediate) {
    c.curves = c.model.curves(state.bias);
    refreshIvPlot();
  } else if (!curvesFrame) {
    curvesFrame = requestAnimationFrame(() => {
      curvesFrame = 0;
      if (ctx !== c) return;
      c.curves = c.model.curves(state.bias);
      refreshIvPlot();
    });
  }
}

function updatePhysicsPanel() {
  if (!ctx || !ctx.op) return;
  const op = ctx.op;
  ui.region.className = `region ${op.tone}`;
  ui.region.textContent = op.region;
  let readouts = op.readouts;
  if (ctx.def.family === "diode" && ctx.cut) {
    const w = diodeDepletion2D(ctx);
    const sum = summarizeCut(ctx.cut);
    readouts = readouts.map((r) => {
      if (r.label.startsWith("耗尽层宽度")) return { label: "耗尽层宽度 W (二维数值解)", value: w ? `${(w[1] - w[0]).toFixed(3)} μm` : "≈ 0 (近平带)" };
      if (r.label.startsWith("峰值电场")) return { label: "峰值电场 (二维数值解)", value: `${sum.emax.toFixed(1)} kV/cm` };
      return r;
    });
  }
  ui.readouts.innerHTML = readouts.map((r) => `<div><span title="${r.label}">${r.label}</span><b>${r.value}</b></div>`).join("");
  ui.params.innerHTML = ctx.model.params.map((r) => `<div><span>${r.label}</span><b>${r.value}</b></div>`).join("");
  ui.schematic.innerHTML = schematic(ctx.def, state.bias, op);
  ui.explain.innerHTML = explainPhysics(ctx.def, op, summarizeCut(ctx.cut));
}

client.onBusy((busy) => {
  if (busy) setStatus("泊松方程求解中…", true);
});

client.onSolve((r) => {
  if (!ctx || r.device !== ctx.def.key) return;
  const c = ctx;
  c.solution = r;
  setStatus(`${r.converged ? "收敛" : "未完全收敛"} · Newton ${r.newton} · PCG ${r.cg} · ${r.ms.toFixed(0)} ms · ${r.nodes} 节点`, false);
  if (state.mode !== "physics") return;
  paintFront();
  refreshPhysicsPlots();
  if (c.mesh) c.carriers.setBackground(c.mesh, r, 0);
  updatePhysicsPanel();
  c.view.setDimensions(state.toggles.dims ? physicsDims(c) : []);
});

function paintFront() {
  if (!ctx || !ctx.solution || !ctx.sampler || !ctx.finalMaps || state.mode !== "physics") return;
  const { canvas, scale } = paintField({
    field: state.field,
    solution: ctx.solution,
    sampler: ctx.sampler,
    front: ctx.finalMaps.front,
    equipotentials: true
  });
  ctx.view.setFaceCanvas("front", canvas);
  updateLegend(scale);
}

function updateLegend(scale?: ColorScale) {
  if (state.mode === "process" || !scale || scale.lut === "doping") {
    ui.colorbar.style.background = dopingGradientCss();
    const ticks = scale?.ticks ?? [
      { t: 0, text: "p 10²⁰" },
      { t: 0.25, text: "10¹⁷" },
      { t: 0.5, text: "10¹⁴" },
      { t: 0.75, text: "10¹⁷" },
      { t: 1, text: "n 10²⁰" }
    ];
    ui.colorbarTicks.innerHTML = ticks.map((t) => `<span style="left:${t.t * 100}%">${t.text}</span>`).join("");
  } else {
    ui.colorbar.style.background = lutGradientCss(scale.lut as keyof typeof LUT);
    ui.colorbarTicks.innerHTML = scale.ticks.map((t) => `<span style="left:${t.t * 100}%">${t.text}</span>`).join("") ;
  }
  const unit = scale ? scale.unit : "cm⁻³";
  ui.legendTitle.textContent = `净掺杂 N_D − N_A (cm⁻³)`;
  const keys =
    state.mode === "physics"
      ? `<span><i></i>冶金结</span><span><i class="dash"></i>耗尽区边界</span>${
          state.toggles.carriers ? `<span><i class="dot" style="background:var(--electron)"></i>电子</span><span><i class="dot" style="background:var(--hole)"></i>空穴</span><span><i class="dot" style="background:#ffe28a"></i>复合/产生</span>` : ""
        }<span class="muted">单位 ${unit}</span>`
      : `<span><i></i>冶金结 (N_D = N_A)</span><span><i class="dot" style="background:#8096a8"></i>SiO₂</span>`;
  ui.legendKeys.innerHTML = keys;
}

function buildFieldSelect() {
  ui.fieldSelect.innerHTML = FIELDS.map((f) => `<option value="${f.key}">${f.label}</option>`).join("");
  ui.fieldSelect.value = state.field;
}

function buildCutSelect() {
  if (!ctx) return;
  ui.cutSelect.innerHTML = ctx.def.cutlines.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
  ui.cutSelect.value = state.cut;
}

/* ========================================================================== plots == */

interface CardRef {
  id: string;
  plot: Plot | null;
  el: HTMLElement;
  tabs?: HTMLElement;
}

let cards: CardRef[] = [];

function card(id: string, title: string, opts: { tabs?: boolean; clickable?: boolean; html?: boolean } = {}): CardRef {
  const el = document.createElement("div");
  el.className = `card${opts.clickable ? " clickable" : ""}`;
  el.innerHTML = `<div class="card-head"><span>${title}</span>${opts.tabs ? '<div class="tabs"></div>' : ""}</div>`;
  let plot: Plot | null = null;
  if (opts.html) {
    const box = document.createElement("div");
    box.className = "metrics";
    el.appendChild(box);
  } else {
    const canvas = document.createElement("canvas");
    el.appendChild(canvas);
    plot = new Plot(canvas);
  }
  ui.cards.appendChild(el);
  return { id, plot, el, tabs: el.querySelector(".tabs") as HTMLElement | undefined };
}

function buildCards() {
  ui.cards.innerHTML = "";
  if (state.mode === "physics") {
    ui.cards.classList.remove("three");
    cards = [card("band", "能带图"), card("field", "电场 / 电势"), card("carrier", "载流子与掺杂"), card("iv", "I–V 特性", { tabs: true, clickable: true })];
    ui.dockNote.textContent = "悬停读数 · 在 I–V 图上点击或拖动可直接设定工作点";
    refreshPhysicsPlots();
    refreshIvPlot();
  } else {
    ui.cards.classList.add("three");
    cards = [card("doping", "纵向掺杂剖面"), card("lateral", "横向掺杂剖面"), card("metrics", "工艺结果汇总", { html: true })];
    ui.dockNote.textContent = "剖面来自解析工艺模型：高斯注入 + 热预算 Dt 展宽 + 外延反扩散";
  }
}

function cardById(id: string) {
  return cards.find((c) => c.id === id);
}

function regionBands(c: CutData) {
  const out: Array<{ x0: number; x1: number; color: string; label?: string }> = [];
  let start = 0;
  for (let i = 1; i <= c.t.length; i += 1) {
    const end = i === c.t.length || Math.sign(c.net[i]) !== Math.sign(c.net[start]);
    if (!end) continue;
    const seg = c.net.slice(start, i);
    const peak = Math.max(...seg.map(Math.abs));
    const n = c.net[start] > 0;
    const label = `${n ? "n" : "p"}${peak > 5e18 ? "⁺" : peak < 5e15 ? "⁻" : ""}`;
    out.push({ x0: c.t[start], x1: c.t[Math.min(i, c.t.length - 1)], color: n ? "rgba(84,173,255,0.07)" : "rgba(255,92,108,0.07)", label });
    start = i;
  }
  return out;
}

function depletionBands(c: CutData) {
  const out: Array<{ x0: number; x1: number; color: string }> = [];
  let start: number | null = null;
  for (let i = 0; i < c.t.length; i += 1) {
    const dep = Math.abs(c.neutral[i]) < 0.5;
    if (dep && start === null) start = i;
    if ((!dep || i === c.t.length - 1) && start !== null) {
      out.push({ x0: c.t[start], x1: c.t[i], color: "rgba(255,226,138,0.1)" });
      start = null;
    }
  }
  return out;
}

function junctionLines(t: number[], net: number[]) {
  const out: Array<{ x: number; color: string; dash?: number[] }> = [];
  for (let i = 1; i < t.length; i += 1) {
    if (net[i - 1] * net[i] < 0) {
      const f = net[i - 1] / (net[i - 1] - net[i]);
      out.push({ x: t[i - 1] + f * (t[i] - t[i - 1]), color: "rgba(255,255,255,0.35)", dash: [2, 3] });
    }
  }
  return out;
}

function refreshPhysicsPlots() {
  if (!ctx || state.mode !== "physics" || !ctx.solution || !ctx.mesh) return;
  const c = ctx;
  const cut = currentCut(c.def);
  const d = extractCut(c.mesh!, c.solution!, cut);
  c.cut = d;
  const axis = cut.orientation === "vertical" ? "深度 y" : "位置 x";
  const regions = regionBands(d);
  const dep = depletionBands(d);
  const jl = junctionLines(d.t, d.net);
  const last = d.t.length - 1;
  const band = cardById("band");
  const xr: [number, number] = [d.t[0], d.t[last]];
  if (band?.plot) {
    const spec: PlotSpec = {
      xLabel: axis,
      xUnit: "μm",
      yLabel: "E",
      yUnit: "eV",
      yScale: "lin",
      xRange: xr,
      series: [
        { x: d.t, y: d.ec, color: "#e6edf3", width: 2, label: "E_C" },
        { x: d.t, y: d.ev, color: "#e6edf3", width: 2, label: "E_V" },
        { x: d.t, y: d.ei, color: "rgba(200,210,220,0.45)", width: 1, dash: [2, 3], label: "E_i" },
        { x: d.t, y: d.efn, color: "#54adff", width: 1.6, dash: [6, 3], label: "E_Fn" },
        { x: d.t, y: d.efp, color: "#ff5c6c", width: 1.6, dash: [6, 3], label: "E_Fp" }
      ],
      bands: [...regions, ...dep],
      vlines: jl,
      texts: bandTexts(d)
    };
    band.plot.draw(spec);
  }
  const field = cardById("field");
  if (field?.plot) {
    field.plot.draw({
      xLabel: axis,
      xUnit: "μm",
      yLabel: cut.orientation === "vertical" ? "E_y" : "E_x",
      yUnit: "kV/cm",
      y2Label: "ψ",
      y2Unit: "V",
      yScale: "lin",
      xRange: xr,
      series: [
        { x: d.t, y: d.field, color: "#ffa45c", width: 1.8, fill: "rgba(255,164,92,0.18)", label: "电场" },
        { x: d.t, y: d.psi, color: "#6ff0ff", width: 1.6, axis: "right", label: "电势 ψ" }
      ],
      bands: dep,
      vlines: jl,
      legend: true
    });
  }
  const car = cardById("carrier");
  if (car?.plot) {
    car.plot.draw({
      xLabel: axis,
      xUnit: "μm",
      yLabel: "浓度",
      yUnit: "cm⁻³",
      yScale: "log",
      xRange: xr,
      yRange: [1e2, 1e21],
      series: [
        { x: d.t, y: d.net.map((v) => Math.abs(v)), color: "rgba(220,228,236,0.55)", width: 1.2, dash: [4, 3], label: "|N_D − N_A|" },
        { x: d.t, y: d.n, color: "#54adff", width: 1.9, label: "n" },
        { x: d.t, y: d.p, color: "#ff5c6c", width: 1.9, label: "p" }
      ],
      bands: dep,
      vlines: jl,
      legend: true
    });
  }
}

/** Label E_C/E_V at the right end and each quasi-Fermi level at an end where it is the majority level. */
function bandTexts(d: CutData) {
  const last = d.t.length - 1;
  const span = d.t[last] - d.t[0];
  const nEnd = d.n[last] > d.p[last] ? last : d.n[0] > d.p[0] ? 0 : last;
  const pEnd = d.p[0] > d.n[0] ? 0 : d.p[last] > d.n[last] ? last : 0;
  const at = (i: number) => (i === 0 ? d.t[0] + span * 0.02 : d.t[last] - span * 0.02);
  const align = (i: number): CanvasTextAlign => (i === 0 ? "left" : "right");
  const out = [
    { x: d.t[last] - span * 0.02, y: d.ec[last], text: "E_C", color: "#e6edf3", align: "right" as CanvasTextAlign },
    { x: d.t[last] - span * 0.02, y: d.ev[last], text: "E_V", color: "#e6edf3", align: "right" as CanvasTextAlign },
    { x: at(nEnd), y: d.efn[nEnd], text: "E_Fn", color: "#54adff", align: align(nEnd) },
    { x: at(pEnd), y: d.efp[pEnd], text: "E_Fp", color: "#ff5c6c", align: align(pEnd) }
  ];
  // keep labels that share an end at least ~7 % of the energy span apart
  const range = Math.max(...d.ec) - Math.min(...d.ev);
  const gap = range * 0.07;
  for (const side of [d.t[0] + span * 0.02, d.t[last] - span * 0.02]) {
    const group = out.filter((o) => o.x === side).sort((a, b) => b.y - a.y);
    for (let i = 1; i < group.length; i += 1) if (group[i - 1].y - group[i].y < gap) group[i].y = group[i - 1].y - gap;
  }
  return out;
}

function refreshIvPlot() {
  if (!ctx || state.mode !== "physics") return;
  const ref = cardById("iv");
  if (!ref?.plot) return;
  const views = ctx.curves;
  if (!views.length) return;
  let view = views.find((v) => v.id === state.iv);
  if (!view) {
    view = views[0];
    state.iv = view.id;
  }
  if (ref.tabs && ref.tabs.childElementCount !== views.length) {
    ref.tabs.innerHTML = "";
    views.forEach((v) => {
      const b = document.createElement("button");
      b.textContent = v.short;
      b.title = v.title;
      b.dataset.view = v.id;
      b.addEventListener("click", () => {
        state.iv = v.id;
        refreshIvPlot();
      });
      ref.tabs!.appendChild(b);
    });
  }
  ref.tabs?.querySelectorAll("button").forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.view === state.iv));
  (ref.el.querySelector(".card-head span") as HTMLElement).textContent = view.title;
  let color = 0;
  const series: PlotSeries[] = view.series.map((s) => {
    const emph = s.emphasis;
    const locus = s.label.includes("轨迹");
    return {
      x: s.x,
      y: s.y,
      label: s.label,
      color: emph ? "#f4f8fb" : locus ? "rgba(200,210,220,0.5)" : PALETTE[color++ % PALETTE.length],
      width: emph ? 2.3 : 1.5,
      dash: locus ? [4, 3] : undefined
    };
  });
  const bandColors = { off: "rgba(131,145,162,0.08)", mid: "rgba(232,197,71,0.08)", on: "rgba(88,214,141,0.07)", warn: "rgba(255,179,71,0.12)" };
  const spec: PlotSpec = {
    xLabel: view.xLabel,
    xUnit: view.xUnit,
    yLabel: view.yLabel,
    yUnit: view.yUnit,
    yScale: view.yScale,
    siY: view.yScale === "lin" && view.yUnit !== "",
    series,
    bands: view.bands?.map((b) => ({ x0: b.from, x1: b.to, color: bandColors[b.tone], label: b.label })),
    markers: view.marker ? [{ x: view.marker.x, y: view.marker.y, color: "#ffe28a" }] : [],
    legend: series.length <= 4
  };
  ref.plot.draw(spec);
  ref.plot.onPick = view.xBias
    ? (x) => {
        if (!ctx) return;
        const b = ctx.def.bias.find((q) => q.key === view!.xBias);
        if (!b) return;
        stopSweep();
        state.bias[b.key] = Math.min(Math.max(Math.round(x / b.step) * b.step, b.min), b.max);
        syncBiasControls();
        onBiasChanged();
      }
    : null;
}

function refreshProcessPlots(maps: ProcessMapsResult, ps: ProcessState) {
  if (!ctx || state.mode !== "process") return;
  const def = ctx.def;
  const vCut = def.cutlines.find((c) => c.id === state.cut && c.orientation === "vertical") ?? def.cutlines.find((c) => c.orientation === "vertical")!;
  const hCut = def.cutlines.find((c) => c.orientation === "horizontal");
  const draw = (ref: CardRef | undefined, cut: CutlineDef | undefined, xLabel: string) => {
    if (!ref?.plot || !cut) return;
    const prof = maps.profiles[cut.id];
    if (!prof) return;
    const t = Array.from(prof.t);
    const nd = Array.from(prof.nd);
    const na = Array.from(prof.na);
    const net = nd.map((v, i) => v - na[i]);
    const lines = junctionLines(t, net).map((l) => ({ ...l, label: `${l.x.toFixed(3)} μm`, color: "rgba(255,226,138,0.8)" }));
    (ref.el.querySelector(".card-head span") as HTMLElement).textContent = `${cut.orientation === "vertical" ? "纵向" : "横向"}掺杂剖面 · ${cut.name.split(" ")[1] ?? ""}`;
    ref.plot.draw({
      xLabel,
      xUnit: "μm",
      yLabel: "浓度",
      yUnit: "cm⁻³",
      yScale: "log",
      yRange: [1e13, 1e21],
      xRange: [t[0], t[t.length - 1]],
      series: [
        { x: t, y: nd.map((v) => (v > 0 ? v : NaN)), color: "#54adff", width: 1.8, label: "N_D 施主" },
        { x: t, y: na.map((v) => (v > 0 ? v : NaN)), color: "#ff5c6c", width: 1.8, label: "N_A 受主" },
        { x: t, y: net.map((v) => (Math.abs(v) > 0 ? Math.abs(v) : NaN)), color: "rgba(230,237,243,0.7)", width: 1.1, dash: [4, 3], label: "|净掺杂|" }
      ],
      vlines: lines,
      legend: true
    });
  };
  draw(cardById("doping"), vCut, "深度 y");
  draw(cardById("lateral"), hCut, "位置 x");
  const m = cardById("metrics");
  if (m) {
    const box = m.el.querySelector(".metrics") as HTMLElement;
    const rows = ps.history
      .map((h) => {
        const title = def.recipe[h.step].title;
        return h.results.map(([k, v]) => `<tr><td>${k}<br><small>${h.step + 1}. ${title}</small></td><td>${v}</td></tr>`).join("");
      })
      .join("");
    box.innerHTML = rows ? `<table>${rows}</table>` : `<p class="muted">此步之前还没有可测量的结果。离子注入、退火与氧化之后会在这里汇总结深、方块电阻、氧化层厚度等。</p>`;
  }
}

/* ========================================================================== camera == */

function frameView(kind: "iso" | "front" | "top", dur = 0.9) {
  if (!ctx) return;
  state.view = kind;
  ui.viewButtons.forEach((b) => b.classList.toggle("active", b.dataset.view === kind));
  const box = ctx.view.bounds(state.mode === "process" ? Math.min(stackTopAll(ctx.final) - 0.6, -0.3 * (ctx.def.domain.y1 - ctx.def.domain.y0)) : undefined);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const fov = (stage.camera.fov * Math.PI) / 180;
  const aspect = stage.camera.aspect;
  let dir: THREE.Vector3;
  let w: number;
  let h: number;
  if (kind === "front") {
    dir = new THREE.Vector3(0, 0.04, 1);
    w = size.x * 1.5;
    h = size.y * 1.15;
    center.z = 0;
  } else if (kind === "top") {
    dir = new THREE.Vector3(0, 1, 0.18);
    w = size.x;
    h = size.z * 1.3;
  } else {
    dir = new THREE.Vector3(0.52, 0.34, 1);
    w = size.x * 1.08;
    h = size.y * 1.15 + size.z * 0.4;
  }
  const dist = (Math.max(h, w / aspect) / (2 * Math.tan(fov / 2))) * (kind === "front" ? 1.12 : 1.18) + (kind === "front" ? 0 : size.z * 0.5);
  const pos = center.clone().add(dir.normalize().multiplyScalar(dist));
  stage.flyTo(pos, center, dur);
}

stage.onTick(() => {
  if (!ctx) return;
  // scale bar: pixels per μm at the orbit target distance
  const dist = stage.camera.position.distanceTo(stage.controls.target);
  const hPx = stage.renderer.domElement.clientHeight;
  const unitsPerPx = (2 * dist * Math.tan((stage.camera.fov * Math.PI) / 360)) / hPx;
  const pxPerUm = ctx.view.s / unitsPerPx;
  const options = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5];
  const len = options.find((o) => o * pxPerUm >= 60) ?? 5;
  const bar = ui.scaleBar.querySelector("i") as HTMLElement;
  const width = `${Math.round(len * pxPerUm)}px`;
  if (bar.style.width !== width) {
    bar.style.width = width;
    (ui.scaleBar.querySelector("span") as HTMLElement).textContent = len >= 1 ? `${len} μm` : `${Math.round(len * 1000)} nm`;
  }
});

/* ========================================================================== sweep == */

let sweepRaf = 0;
function startSweep() {
  if (!ctx) return;
  const b = ctx.def.bias[0];
  const lo = ctx.def.family === "diode" ? -8 : b.min;
  const hi = b.max;
  let dirn = 1;
  let last = performance.now();
  state.sweeping = true;
  ui.sweepBtn.classList.add("active");
  ui.sweepBtn.textContent = "■ 停止";
  const step = (now: number) => {
    if (!state.sweeping || !ctx) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    let v = state.bias[b.key] + (dirn * (hi - lo) * dt) / 7;
    if (v >= hi) {
      v = hi;
      dirn = -1;
    }
    if (v <= lo) {
      v = lo;
      dirn = 1;
    }
    state.bias[b.key] = v;
    syncBiasControls();
    onBiasChanged();
    sweepRaf = requestAnimationFrame(step);
  };
  sweepRaf = requestAnimationFrame(step);
}

function stopSweep() {
  state.sweeping = false;
  cancelAnimationFrame(sweepRaf);
  ui.sweepBtn.classList.remove("active");
  ui.sweepBtn.textContent = "↻ 扫描";
}

/* ========================================================================= events == */

ui.modeButtons.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode as Mode)));
ui.viewButtons.forEach((b) => b.addEventListener("click", () => frameView(b.dataset.view as "iso" | "front" | "top")));
ui.transport.forEach((b) => b.addEventListener("click", () => stepMove(b.dataset.step as string)));
ui.sweepBtn.addEventListener("click", () => (state.sweeping ? stopSweep() : startSweep()));
ui.fieldSelect.addEventListener("change", () => {
  state.field = ui.fieldSelect.value as FieldKey;
  paintFront();
});
ui.cutSelect.addEventListener("change", () => {
  if (!ctx) return;
  state.cut = ui.cutSelect.value;
  const cut = currentCut(ctx.def);
  if (state.mode === "physics") {
    ctx.view.setCutline(cut, 0);
    refreshPhysicsPlots();
  } else {
    setStep(state.step, false);
  }
});
ui.toggles.forEach((input) =>
  input.addEventListener("change", () => {
    if (!ctx) return;
    const key = input.dataset.toggle as keyof typeof state.toggles;
    state.toggles[key] = input.checked;
    ctx.view.setVisibility({ ild: state.toggles.ild, metal: state.toggles.metal });
    ctx.carriers.setEnabled(state.mode === "physics" && state.toggles.carriers);
    if (state.mode === "physics") {
      ctx.view.setLabels(ctx.def, state.toggles.labels, true);
      ctx.view.setCutline(state.toggles.labels ? currentCut(ctx.def) : null, 0);
      ctx.view.setDimensions(state.toggles.dims ? physicsDims(ctx) : []);
      updateLegend();
      paintFront();
    } else setStep(state.step, false);
  })
);
window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") return;
  if (state.mode !== "process") return;
  if (e.key === "ArrowRight") stepMove("next");
  if (e.key === "ArrowLeft") stepMove("prev");
});

function updateHash() {
  history.replaceState(null, "", `#${state.device}/${state.mode}`);
}

function fromHash() {
  const [dev, mode] = location.hash.replace("#", "").split("/");
  return {
    device: (deviceOrder as string[]).includes(dev) ? (dev as DeviceKey) : "npn",
    mode: mode === "process" ? "process" : ("physics" as Mode)
  };
}

window.addEventListener("hashchange", () => {
  const h = fromHash();
  if (h.device !== state.device) loadDevice(h.device, h.mode);
  else if (h.mode !== state.mode) setMode(h.mode);
});

buildDeviceTabs();
const initial = fromHash();
state.mode = initial.mode;
loadDevice(initial.device, initial.mode);

// debugging handle for automated checks
(window as unknown as { __semilab: unknown }).__semilab = {
  get ctx() {
    return ctx;
  },
  state,
  stage
};
