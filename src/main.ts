import "./styles.css";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type DeviceKey = "diode" | "npn" | "pnp" | "nmos" | "pmos";
type ModeKey = "structure" | "bias" | "flow";

type FlowKind = "electron" | "hole" | "field";
type AnimatedUpdate = (elapsed: number) => void;
type CurveRegion = "off" | "transition" | "on";

interface FlowPath {
  points: THREE.Vector3[];
  color: number;
  kind: FlowKind;
  speed: number;
  count: number;
  radius: number;
  label?: string | false;
}

interface DeviceCopy {
  title: string;
  summary: string;
  bias: string;
  carriers: string;
  principles: string[];
}

interface BlockSpec {
  name: string;
  position: [number, number, number];
  size: [number, number, number];
  color: number;
  opacity?: number;
  label?: string;
  labelPosition?: [number, number, number];
}

function requiredElement<T extends HTMLElement>(selector: string) {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Required element is missing: ${selector}`);
  }
  return element;
}

const sceneContainer = requiredElement<HTMLDivElement>("#scene");
const deviceSelect = requiredElement<HTMLSelectElement>("#deviceSelect");
const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".mode-button"));
const deviceTitle = requiredElement<HTMLHeadingElement>("#deviceTitle");
const deviceSummary = requiredElement<HTMLParagraphElement>("#deviceSummary");
const principleList = requiredElement<HTMLUListElement>("#principleList");
const biasState = requiredElement<HTMLElement>("#biasState");
const carrierState = requiredElement<HTMLElement>("#carrierState");
const currentCurve = requiredElement<HTMLCanvasElement>("#currentCurve");
const biasSlider = requiredElement<HTMLInputElement>("#biasSlider");
const curveRegion = requiredElement<HTMLElement>("#curveRegion");
const biasInputLabel = requiredElement<HTMLElement>("#biasInputLabel");
const biasInputValue = requiredElement<HTMLElement>("#biasInputValue");
const curveCurrentLabel = requiredElement<HTMLElement>("#curveCurrentLabel");
const curveCurrentValue = requiredElement<HTMLElement>("#curveCurrentValue");

const colors = {
  p: 0xf06f88,
  n: 0x4da3ee,
  metal: 0xa9b2b7,
  oxide: 0xd8b24c,
  depletion: 0xffec8a,
  positiveIon: 0xc47a38,
  negativeIon: 0x57606f,
  electron: 0x0b6fff,
  hole: 0xf04464,
  field: 0x087f7b,
  barrier: 0xffb703,
  dark: 0x17201d
};

const copy: Record<DeviceKey, DeviceCopy> = {
  diode: {
    title: "PN 二极管",
    summary:
      "P 区和 N 区接触后，电子与空穴先靠浓度差扩散到对方区域并复合，结附近留下不能移动的固定离子。固定离子建立内建电场，逐渐阻止继续扩散，这就是耗尽层和单向导电性的来源。",
    bias: "外加偏置改变耗尽层宽度",
    carriers: "电子向 P 区扩散，空穴向 N 区扩散",
    principles: [
      "刚接触时，N 区电子向 P 区扩散，P 区空穴向 N 区扩散，二者在结区复合。",
      "复合后留下 P 侧固定负离子和 N 侧固定正离子，结区自由载流子减少，所以叫耗尽层。",
      "固定离子产生从 N 侧指向 P 侧的内建电场；反偏让势垒更高，正偏让势垒降低。"
    ]
  },
  npn: {
    title: "NPN 三极管",
    summary:
      "NPN 内部本质上有两个 PN 结。静止时 BE 结和 BC 结都会形成耗尽层；放大区工作时 BE 结正偏变薄，电子从发射极注入薄基区，BC 结反偏形成强电场，把大部分电子扫入集电极。",
    bias: "BE 正偏，BC 反偏",
    carriers: "电子从 E 注入 B，再被 C 收集",
    principles: [
      "BE 结像一个被正偏压低势垒的二极管，负责把电子注入基区。",
      "基区必须薄且掺杂轻，电子才来不及大量复合，只有少量形成基极电流。",
      "BC 结反偏不是为了阻断全部载流子，而是用强电场收集已经穿过基区的电子。"
    ]
  },
  pnp: {
    title: "PNP 三极管",
    summary:
      "PNP 与 NPN 的掺杂和偏置极性相反，但内部过程相同：两个 PN 结先形成耗尽层；工作时 EB 结正偏让空穴注入薄基区，CB 结反偏把空穴收集到集电极。",
    bias: "EB 正偏，CB 反偏",
    carriers: "空穴从 E 注入 B，再被 C 收集",
    principles: [
      "PNP 的主要注入载流子是空穴，电压极性和 NPN 相反。",
      "薄基区减少复合，少量复合对应基极电流，大量穿越对应集电极电流。",
      "放大不是载流子凭空增加，而是正偏发射结控制反偏集电结收集的电流。"
    ]
  },
  nmos: {
    title: "N 沟道 MOSFET",
    summary:
      "NMOS 由 P 型衬底、N+ 源漏区、薄氧化层和金属栅构成。栅压超过阈值后，栅下表面反型为 N 沟道，电子从源极流向漏极。",
    bias: "VGS > Vth，VDS > 0",
    carriers: "电子沿反型沟道运动",
    principles: [
      "栅极被氧化层绝缘，直流栅电流近似为零。",
      "栅压通过电场调制沟道载流子密度，因此 MOSFET 是电压控制器件。",
      "源漏之间是否导通，取决于栅下是否形成连续反型层。"
    ]
  },
  pmos: {
    title: "P 沟道 MOSFET",
    summary:
      "PMOS 由 N 型衬底、P+ 源漏区和栅氧结构组成。栅极相对源极足够负时，栅下形成 P 沟道，空穴成为沟道中的主要载流子。",
    bias: "VGS < -Vth，VSD > 0",
    carriers: "空穴沿反型沟道运动",
    principles: [
      "PMOS 与 NMOS 的掺杂、偏置极性和主要载流子相反。",
      "数字 CMOS 电路把 PMOS 放在上拉网络，NMOS 放在下拉网络。",
      "由于空穴迁移率通常低于电子，PMOS 同等驱动能力常需要更大尺寸。"
    ]
  }
};

let activeDevice: DeviceKey = "diode";
let activeMode: ModeKey = "structure";
let biasControlValue = 0;
let conductionLevel = 0.12;
let isDraggingCurve = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe3eeeb);
scene.fog = new THREE.Fog(0xe3eeeb, 10, 24);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
camera.position.set(7.8, 5.1, 8.4);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
sceneContainer.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0.4, 0);
controls.maxDistance = 16;
controls.minDistance = 4.5;

const root = new THREE.Group();
scene.add(root);

const ambientLight = new THREE.HemisphereLight(0xffffff, 0x61766f, 1.55);
scene.add(ambientLight);

const keyLight = new THREE.DirectionalLight(0xffffff, 2.7);
keyLight.position.set(4.8, 8.5, 6);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.near = 1;
keyLight.shadow.camera.far = 22;
keyLight.shadow.camera.left = -8;
keyLight.shadow.camera.right = 8;
keyLight.shadow.camera.top = 8;
keyLight.shadow.camera.bottom = -8;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x8dc8cc, 1.35);
fillLight.position.set(-5, 3, -4);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xfff0d2, 1.15);
rimLight.position.set(-4, 5, 5);
scene.add(rimLight);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(20, 15),
  new THREE.MeshStandardMaterial({ color: 0xc7d8d2, roughness: 0.92, metalness: 0.01 })
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -1.25;
floor.receiveShadow = true;
scene.add(floor);

const floorGrid = new THREE.GridHelper(12, 24, 0x7fa19a, 0xb4c9c4);
floorGrid.position.y = -1.235;
floorGrid.material.transparent = true;
floorGrid.material.opacity = 0.22;
scene.add(floorGrid);

const flows: Array<{ mesh: THREE.Mesh; path: THREE.CatmullRomCurve3; speed: number; offset: number }> = [];
const animatedUpdates: AnimatedUpdate[] = [];
const clock = new THREE.Clock();

function createBlock(spec: BlockSpec) {
  const isMetal = spec.color === colors.metal;
  const isDepletion = spec.color === colors.depletion;
  const material = new THREE.MeshPhysicalMaterial({
    color: spec.color,
    transparent: true,
    opacity: spec.opacity ?? 0.82,
    roughness: isMetal ? 0.22 : 0.38,
    metalness: isMetal ? 0.52 : 0.02,
    transmission: 0,
    clearcoat: isMetal ? 0.42 : 0.18,
    emissive: isDepletion ? colors.depletion : 0x000000,
    emissiveIntensity: isDepletion ? 0.12 : 0
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...spec.size), material);
  mesh.position.set(...spec.position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = spec.name;
  root.add(mesh);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry),
    new THREE.LineBasicMaterial({ color: isMetal ? 0xf7fbff : 0x183832, transparent: true, opacity: isMetal ? 0.38 : 0.24 })
  );
  edges.position.copy(mesh.position);
  root.add(edges);

  if (!isMetal) {
    addBlockSliceGrid(spec);
  }

  if (spec.label) {
    const labelPosition = spec.labelPosition
      ? new THREE.Vector3(...spec.labelPosition)
      : new THREE.Vector3(spec.position[0], spec.position[1] + spec.size[1] / 2 + 0.35, spec.position[2]);
    addLabel(spec.label, labelPosition);
  }

  return mesh;
}

function addBlockSliceGrid(spec: BlockSpec) {
  const [width, height, depth] = spec.size;
  const [x, y, z] = spec.position;
  const yTop = y + height / 2 + 0.012;
  const points: THREE.Vector3[] = [];
  const xSteps = Math.max(2, Math.round(width / 0.35));
  const zSteps = Math.max(2, Math.round(depth / 0.35));

  for (let index = 1; index < xSteps; index += 1) {
    const px = x - width / 2 + (width * index) / xSteps;
    points.push(new THREE.Vector3(px, yTop, z - depth / 2));
    points.push(new THREE.Vector3(px, yTop, z + depth / 2));
  }

  for (let index = 1; index < zSteps; index += 1) {
    const pz = z - depth / 2 + (depth * index) / zSteps;
    points.push(new THREE.Vector3(x - width / 2, yTop, pz));
    points.push(new THREE.Vector3(x + width / 2, yTop, pz));
  }

  const grid = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.17 })
  );
  root.add(grid);
}

function addLabel(text: string, position: THREE.Vector3, size = 0.64) {
  const canvas = document.createElement("canvas");
  const scale = 2;
  canvas.width = 256 * scale;
  canvas.height = 78 * scale;
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.scale(scale, scale);
  context.clearRect(0, 0, 256, 78);
  context.fillStyle = "rgba(251, 252, 251, 0.92)";
  roundRect(context, 8, 8, 240, 54, 8);
  context.fill();
  context.strokeStyle = "rgba(36, 64, 58, 0.2)";
  context.stroke();
  context.fillStyle = "#17201d";
  context.font = "700 24px Microsoft YaHei, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, 128, 35);

  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
  sprite.position.copy(position);
  sprite.scale.set(size * 2.6, size * 0.8, 1);
  root.add(sprite);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function createArrow(start: THREE.Vector3, end: THREE.Vector3, color: number, label?: string) {
  const direction = end.clone().sub(start);
  const length = direction.length();
  const arrow = new THREE.ArrowHelper(direction.normalize(), start, length, color, 0.32, 0.18);
  root.add(arrow);
  if (label) {
    addLabel(label, start.clone().lerp(end, 0.55).add(new THREE.Vector3(0, 0.42, 0)), 0.52);
  }
}

function addPotentialBarrier(centerX: number, width: number, peak: number, label: string | false, animate = false) {
  const baseY = 1.02;
  const z = 1.06;
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(centerX - width / 2, baseY, z),
    new THREE.Vector3(centerX - width * 0.18, baseY + peak * 0.72, z),
    new THREE.Vector3(centerX, baseY + peak, z),
    new THREE.Vector3(centerX + width * 0.18, baseY + peak * 0.72, z),
    new THREE.Vector3(centerX + width / 2, baseY, z)
  ]);
  const material = new THREE.MeshStandardMaterial({
    color: colors.barrier,
    emissive: colors.barrier,
    emissiveIntensity: 0.55,
    transparent: true,
    opacity: 0.78,
    roughness: 0.25
  });
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 64, 0.035, 12, false), material);
  tube.castShadow = true;
  root.add(tube);

  const baseLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(centerX - width / 2, baseY - 0.02, z),
      new THREE.Vector3(centerX + width / 2, baseY - 0.02, z)
    ]),
    new THREE.LineBasicMaterial({ color: 0x8a6a14, transparent: true, opacity: 0.42 })
  );
  root.add(baseLine);
  if (label) {
    addLabel(label, new THREE.Vector3(centerX, baseY + peak + 0.3, z), 0.5);
  }

  if (animate) {
    animatedUpdates.push((elapsed) => {
      const pulse = 1 + Math.sin(elapsed * 3.4) * 0.09;
      tube.scale.y = pulse;
      material.opacity = 0.62 + Math.sin(elapsed * 3.4) * 0.14;
    });
  }
}

function addFieldSheet(centerX: number, width: number, label: string | false, strength: "low" | "high" | "normal") {
  const height = strength === "high" ? 2.04 : strength === "low" ? 1.25 : 1.62;
  const color = strength === "high" ? 0x087f7b : strength === "low" ? 0x6db8b5 : colors.field;
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: strength === "high" ? 0.13 : 0.08,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  sheet.position.set(centerX, 0.08, 0);
  sheet.rotation.y = Math.PI / 2;
  root.add(sheet);

  const yValues = [-0.48, 0, 0.48];
  yValues.forEach((y, index) => {
    const z = -0.72 + index * 0.72;
    createArrow(
      new THREE.Vector3(centerX + width * 0.33, y, z),
      new THREE.Vector3(centerX - width * 0.33, y, z),
      color
    );
  });
  if (label) {
    addLabel(label, new THREE.Vector3(centerX, -0.94, 1.05), 0.5);
  }
}

function createTerminal(name: string, position: THREE.Vector3, direction: THREE.Vector3) {
  const length = 1.08;
  const radius = 0.045;
  const cylinder = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, 24),
    new THREE.MeshStandardMaterial({ color: colors.metal, roughness: 0.28, metalness: 0.58 })
  );
  cylinder.position.copy(position.clone().add(direction.clone().multiplyScalar(length / 2)));
  cylinder.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
  cylinder.castShadow = true;
  root.add(cylinder);

  const pad = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 24, 16),
    new THREE.MeshStandardMaterial({ color: colors.metal, roughness: 0.22, metalness: 0.65 })
  );
  pad.position.copy(position.clone().add(direction.clone().multiplyScalar(length)));
  pad.castShadow = true;
  root.add(pad);
  addLabel(name, pad.position.clone().add(new THREE.Vector3(0, 0.42, 0)), 0.46);
}

function addCarrierField(bounds: THREE.Box3, color: number, count: number, symbol: "-" | "+") {
  for (let index = 0; index < count; index += 1) {
    const x = THREE.MathUtils.lerp(bounds.min.x, bounds.max.x, Math.random());
    const y = THREE.MathUtils.lerp(bounds.min.y, bounds.max.y, Math.random());
    const z = THREE.MathUtils.lerp(bounds.min.z, bounds.max.z, Math.random());
    const carrier = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 16, 12),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.15, roughness: 0.4 })
    );
    carrier.position.set(x, y, z);
    carrier.castShadow = true;
    root.add(carrier);
  }
  addLabel(symbol, bounds.getCenter(new THREE.Vector3()).add(new THREE.Vector3(0, 0.65, 0.78)), 0.42);
}

function easeInOut(value: number) {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function getCurveRange(device: DeviceKey) {
  if (device === "diode") {
    return { min: -1, max: 0.85, step: 0.001, defaultValue: 0.62, input: "二极管电压 VD", current: "二极管电流 ID", unit: "V" };
  }
  if (device === "npn") {
    return { min: 0, max: 0.85, step: 0.001, defaultValue: 0.68, input: "基射电压 VBE", current: "集电极电流 IC", unit: "V" };
  }
  if (device === "pnp") {
    return { min: 0, max: 0.85, step: 0.001, defaultValue: 0.68, input: "发射基电压 VEB", current: "集电极电流 IC", unit: "V" };
  }
  if (device === "nmos") {
    return { min: 0, max: 5, step: 0.005, defaultValue: 3.2, input: "栅源电压 VGS", current: "漏极电流 ID", unit: "V" };
  }
  return { min: 0, max: 5, step: 0.005, defaultValue: 3.2, input: "源栅电压 VSG", current: "漏极电流 ID", unit: "V" };
}

function evaluateCurve(device: DeviceKey, value: number) {
  if (device === "diode") {
    const current = value < 0 ? -1e-9 * Math.min(1, Math.abs(value) / 0.35) : 1e-9 * (Math.exp(value / 0.052) - 1);
    const level = THREE.MathUtils.clamp((value - 0.48) / 0.24, 0.02, 1);
    const region: CurveRegion = value < 0.08 ? "off" : value < 0.55 ? "transition" : "on";
    const plot = value < 0 ? 0.04 : THREE.MathUtils.clamp((Math.log10(Math.max(current, 1e-12)) + 12) / 7.2, 0.03, 1);
    return { current, level, region, plot };
  }

  if (device === "npn" || device === "pnp") {
    const current = value < 0.5 ? 5e-9 * value : 2e-6 * Math.exp((value - 0.55) / 0.055);
    const level = THREE.MathUtils.clamp((value - 0.54) / 0.2, 0.02, 1);
    const region: CurveRegion = value < 0.52 ? "off" : value < 0.64 ? "transition" : "on";
    const plot = THREE.MathUtils.clamp((Math.log10(Math.max(current, 1e-9)) + 9) / 5, 0.02, 1);
    return { current, level, region, plot };
  }

  const threshold = 2.2;
  const overdrive = Math.max(0, value - threshold);
  const current = 0.008 * overdrive * overdrive;
  const level = THREE.MathUtils.clamp(overdrive / 2.2, 0.02, 1);
  const region: CurveRegion = value < threshold ? "off" : value < threshold + 0.65 ? "transition" : "on";
  const plot = THREE.MathUtils.clamp(current / 0.06, 0.02, 1);
  return { current, level, region, plot };
}

function formatCurrent(value: number) {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1) return `${sign}${abs.toFixed(2)} A`;
  if (abs >= 1e-3) return `${sign}${(abs * 1e3).toFixed(2)} mA`;
  if (abs >= 1e-6) return `${sign}${(abs * 1e6).toFixed(2)} uA`;
  if (abs >= 1e-9) return `${sign}${(abs * 1e9).toFixed(2)} nA`;
  return `${sign}${(abs * 1e12).toFixed(2)} pA`;
}

function regionText(region: CurveRegion) {
  if (region === "on") return "导通区";
  if (region === "transition") return "临界区";
  return "截止区";
}

function modeFromRegion(region: CurveRegion): ModeKey {
  if (region === "on") return "flow";
  if (region === "transition") return "bias";
  return "structure";
}

function modeFromBias(device: DeviceKey, value: number, region: CurveRegion): ModeKey {
  if (device === "diode") {
    if (value < -0.05) return "bias";
    if (region === "on") return "flow";
    if (region === "transition") return "bias";
    return "structure";
  }
  return modeFromRegion(region);
}

function setBiasForDevice(device: DeviceKey) {
  const range = getCurveRange(device);
  biasControlValue = range.defaultValue;
  biasSlider.min = String(range.min);
  biasSlider.max = String(range.max);
  biasSlider.step = String(range.step);
  biasSlider.value = String(biasControlValue);
}

function setBiasForMode(mode: ModeKey) {
  const range = getCurveRange(activeDevice);
  if (activeDevice === "diode") {
    biasControlValue = mode === "structure" ? 0 : mode === "bias" ? -0.55 : 0.68;
  } else if (activeDevice === "npn" || activeDevice === "pnp") {
    biasControlValue = mode === "structure" ? 0.35 : mode === "bias" ? 0.58 : 0.7;
  } else {
    biasControlValue = mode === "structure" ? 1.2 : mode === "bias" ? 2.35 : 3.45;
  }
  biasControlValue = THREE.MathUtils.clamp(biasControlValue, range.min, range.max);
  biasSlider.value = String(biasControlValue);
}

function updateCurvePanel(shouldRebuild = false) {
  const range = getCurveRange(activeDevice);
  const result = evaluateCurve(activeDevice, biasControlValue);
  conductionLevel = result.level;
  biasInputLabel.textContent = range.input;
  curveCurrentLabel.textContent = range.current;
  biasInputValue.textContent = `${biasControlValue.toFixed(range.max <= 1 ? 3 : 2)} ${range.unit}`;
  curveCurrentValue.textContent = formatCurrent(result.current);
  curveRegion.textContent = regionText(result.region);
  const nextMode = modeFromBias(activeDevice, biasControlValue, result.region);
  const modeChanged = activeMode !== nextMode;
  activeMode = nextMode;
  modeButtons.forEach((button) => button.classList.toggle("active", button.dataset.mode === activeMode));
  drawCurrentCurve();
  if (shouldRebuild || modeChanged) {
    rebuild();
  } else {
    updateCopy();
  }
}

function setBiasFromCanvas(clientX: number) {
  const rect = currentCurve.getBoundingClientRect();
  const range = getCurveRange(activeDevice);
  const padLeft = 42;
  const padRight = 16;
  const plotWidth = Math.max(1, rect.width - padLeft - padRight);
  const ratio = THREE.MathUtils.clamp((clientX - rect.left - padLeft) / plotWidth, 0, 1);
  biasControlValue = range.min + ratio * (range.max - range.min);
  biasSlider.value = String(biasControlValue);
  updateCurvePanel(false);
}

function drawCurrentCurve() {
  const context = currentCurve.getContext("2d");
  if (!context) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssWidth = currentCurve.clientWidth || 320;
  const cssHeight = currentCurve.clientHeight || 180;
  currentCurve.width = Math.round(cssWidth * dpr);
  currentCurve.height = Math.round(cssHeight * dpr);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);

  const width = cssWidth;
  const height = cssHeight;
  const padLeft = 42;
  const padRight = 16;
  const padTop = 18;
  const padBottom = 34;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const range = getCurveRange(activeDevice);
  const valueToX = (value: number) => padLeft + ((value - range.min) / (range.max - range.min)) * plotWidth;
  const plotToY = (plot: number) => padTop + (1 - plot) * plotHeight;

  context.clearRect(0, 0, width, height);
  context.fillStyle = "#f9fcfb";
  context.fillRect(0, 0, width, height);

  const transitionStart = activeDevice === "diode" ? 0.08 : activeDevice === "nmos" || activeDevice === "pmos" ? 2.2 : 0.52;
  const onStart = activeDevice === "diode" ? 0.55 : activeDevice === "nmos" || activeDevice === "pmos" ? 2.85 : 0.64;
  const bands = [
    { from: range.min, to: transitionStart, color: "rgba(107, 113, 120, 0.08)", label: "截止" },
    { from: transitionStart, to: onStart, color: "rgba(255, 183, 3, 0.14)", label: "临界" },
    { from: onStart, to: range.max, color: "rgba(20, 108, 114, 0.12)", label: "导通" }
  ];

  context.font = "700 11px Microsoft YaHei, sans-serif";
  bands.forEach((band) => {
    const x0 = valueToX(THREE.MathUtils.clamp(band.from, range.min, range.max));
    const x1 = valueToX(THREE.MathUtils.clamp(band.to, range.min, range.max));
    context.fillStyle = band.color;
    context.fillRect(x0, padTop, x1 - x0, plotHeight);
    context.fillStyle = "#61716d";
    context.fillText(band.label, x0 + 7, padTop + 14);
  });

  context.strokeStyle = "#d7e4e0";
  context.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = padTop + (plotHeight * i) / 4;
    context.beginPath();
    context.moveTo(padLeft, y);
    context.lineTo(width - padRight, y);
    context.stroke();
  }
  for (let i = 0; i <= 5; i += 1) {
    const x = padLeft + (plotWidth * i) / 5;
    context.beginPath();
    context.moveTo(x, padTop);
    context.lineTo(x, height - padBottom);
    context.stroke();
  }

  context.strokeStyle = "#183832";
  context.lineWidth = 1.2;
  context.beginPath();
  context.moveTo(padLeft, padTop);
  context.lineTo(padLeft, height - padBottom);
  context.lineTo(width - padRight, height - padBottom);
  context.stroke();

  context.strokeStyle = "#146c72";
  context.lineWidth = 3;
  context.beginPath();
  for (let i = 0; i <= 180; i += 1) {
    const xValue = range.min + ((range.max - range.min) * i) / 180;
    const yValue = evaluateCurve(activeDevice, xValue).plot;
    const x = valueToX(xValue);
    const y = plotToY(yValue);
    if (i === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();

  const current = evaluateCurve(activeDevice, biasControlValue);
  const x = valueToX(biasControlValue);
  const y = plotToY(current.plot);
  context.strokeStyle = "rgba(240, 68, 100, 0.55)";
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(x, padTop);
  context.lineTo(x, height - padBottom);
  context.stroke();
  context.fillStyle = "#f04464";
  context.beginPath();
  context.arc(x, y, 5.5, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = "#ffffff";
  context.lineWidth = 2;
  context.stroke();

  context.fillStyle = "#45534f";
  context.font = "700 11px Microsoft YaHei, sans-serif";
  context.textAlign = "left";
  context.fillText(range.input, padLeft, height - 10);
  context.save();
  context.translate(13, height / 2 + 28);
  context.rotate(-Math.PI / 2);
  context.fillText(range.current, 0, 0);
  context.restore();
  context.textAlign = "right";
  context.fillText(`${range.max} ${range.unit}`, width - padRight, height - 10);
}

function addChargeGlyph(text: "+" | "-", position: THREE.Vector3, color: number, size = 0.28) {
  const canvas = document.createElement("canvas");
  const scale = 2;
  canvas.width = 64 * scale;
  canvas.height = 64 * scale;
  const context = canvas.getContext("2d");
  if (!context) {
    return undefined;
  }
  context.scale(scale, scale);
  context.clearRect(0, 0, 64, 64);
  context.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  context.font = "800 44px Arial, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, 32, 32);

  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.92 }));
  sprite.position.copy(position);
  sprite.scale.set(size, size, 1);
  root.add(sprite);
  return sprite;
}

function createDepletionRegion(
  width: number,
  opacity: number,
  label: string,
  animateFormation = false,
  centerX = 0,
  labelPosition = new THREE.Vector3(centerX, 1.34, -0.55)
) {
  const geometry = new THREE.BoxGeometry(width, 1.74, 2.1);
  const material = new THREE.MeshPhysicalMaterial({
    color: colors.depletion,
    transparent: true,
    opacity,
    roughness: 0.5,
    metalness: 0,
    clearcoat: 0.08
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(0, 0.02, 0);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x8d8042, transparent: true, opacity: 0.36 });
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edgeMaterial);
  edges.position.copy(mesh.position);

  const group = new THREE.Group();
  group.position.x = centerX;
  group.add(mesh);
  group.add(edges);
  root.add(group);
  addLabel(label, labelPosition, 0.58);

  if (animateFormation) {
    animatedUpdates.push((elapsed) => {
      const cycle = (elapsed % 6) / 6;
      const growth = easeInOut(Math.min(cycle / 0.72, 1));
      const pulse = cycle > 0.72 ? 0.04 * Math.sin((cycle - 0.72) * Math.PI * 8) : 0;
      const scaleX = 0.08 + growth * 0.92 + pulse;
      group.scale.x = Math.max(0.08, scaleX);
      material.opacity = 0.2 + growth * 0.52;
      edgeMaterial.opacity = 0.12 + growth * 0.34;
    });
  }
}

function addFixedIon(position: THREE.Vector3, sign: "+" | "-", color: number, offset: number) {
  const material = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.1,
    transparent: true,
    opacity: 0.95,
    roughness: 0.42
  });
  const ion = new THREE.Mesh(new THREE.SphereGeometry(0.07, 18, 12), material);
  ion.position.copy(position);
  ion.castShadow = true;
  root.add(ion);

  const glyph = addChargeGlyph(sign, position.clone().add(new THREE.Vector3(0, 0.12, 0.02)), color, 0.22);
  animatedUpdates.push((elapsed) => {
    const cycle = (elapsed % 6) / 6;
    const appear = easeInOut((cycle - offset) / 0.35);
    const scale = 0.1 + appear * (0.9 + 0.12 * Math.sin(elapsed * 4 + offset * 10));
    ion.scale.setScalar(scale);
    material.opacity = 0.15 + appear * 0.8;
    if (glyph) {
      glyph.scale.setScalar(0.05 + appear * 0.22);
      (glyph.material as THREE.SpriteMaterial).opacity = 0.2 + appear * 0.72;
    }
  });
}

function addFixedIonLattice() {
  const rows = [-0.55, 0, 0.55];
  const depths = [-0.55, 0.25];
  rows.forEach((y, rowIndex) => {
    depths.forEach((z, depthIndex) => {
      const order = rowIndex * depths.length + depthIndex;
      addFixedIon(new THREE.Vector3(-0.28 - depthIndex * 0.16, y, z), "-", colors.negativeIon, 0.18 + order * 0.035);
      addFixedIon(new THREE.Vector3(0.28 + depthIndex * 0.16, y, z), "+", colors.positiveIon, 0.2 + order * 0.035);
    });
  });
  addLabel("P 侧固定负离子", new THREE.Vector3(-0.95, 0.96, -1.12), 0.5);
  addLabel("N 侧固定正离子", new THREE.Vector3(0.95, 0.96, -1.12), 0.5);
}

function addJunctionIonPair(junctionX: number, leftSign: "+" | "-", rightSign: "+" | "-", baseOffset: number) {
  const signColor = (sign: "+" | "-") => (sign === "+" ? colors.positiveIon : colors.negativeIon);
  const ys = [-0.48, 0.05, 0.58];
  const zs = [-0.48, 0.42];
  ys.forEach((y, rowIndex) => {
    zs.forEach((z, depthIndex) => {
      const order = rowIndex * zs.length + depthIndex;
      addFixedIon(new THREE.Vector3(junctionX - 0.12 - depthIndex * 0.08, y, z), leftSign, signColor(leftSign), baseOffset + order * 0.03);
      addFixedIon(new THREE.Vector3(junctionX + 0.12 + depthIndex * 0.08, y, z), rightSign, signColor(rightSign), baseOffset + 0.05 + order * 0.03);
    });
  });
}

function addBjtDepletionIons(kind: "npn" | "pnp") {
  const isNpn = kind === "npn";
  addJunctionIonPair(-0.76, isNpn ? "+" : "-", isNpn ? "-" : "+", 0.16);
  addJunctionIonPair(0.74, isNpn ? "-" : "+", isNpn ? "+" : "-", 0.24);
}

function addBjtFormationAnimation(kind: "npn" | "pnp") {
  const isNpn = kind === "npn";
  const majoritySideColor = isNpn ? colors.electron : colors.hole;
  const baseMajorityColor = isNpn ? colors.hole : colors.electron;
  const emitterStart = new THREE.Vector3(-2.2, 0.32, -0.45);
  const collectorStart = new THREE.Vector3(2.3, -0.28, 0.48);
  const baseLeftStart = new THREE.Vector3(-0.12, -0.26, 0.32);
  const baseRightStart = new THREE.Vector3(0.14, 0.28, -0.32);

  addFormationCarrier(emitterStart, new THREE.Vector3(-0.78, 0.16, -0.14), majoritySideColor, 0.02);
  addFormationCarrier(collectorStart, new THREE.Vector3(0.74, -0.12, 0.16), majoritySideColor, 0.28);
  addFormationCarrier(baseLeftStart, new THREE.Vector3(-0.74, -0.16, 0.08), baseMajorityColor, 0.14);
  addFormationCarrier(baseRightStart, new THREE.Vector3(0.72, 0.16, -0.08), baseMajorityColor, 0.42);
  addRecombinationPulse(new THREE.Vector3(-0.76, 0.06, -0.05), 0.05);
  addRecombinationPulse(new THREE.Vector3(0.74, -0.04, 0.08), 0.31);
  addLabel("两个 PN 结都先形成耗尽层", new THREE.Vector3(0, -1.3, -0.8), 0.72);
}

function addBjtBiasVisualization(kind: "npn" | "pnp") {
  const isNpn = kind === "npn";
  const injectedColor = isNpn ? colors.electron : colors.hole;
  createArrow(new THREE.Vector3(-2.9, 1.28, 0.92), new THREE.Vector3(-0.62, 1.28, 0.92), colors.field, "BE 正偏：势垒降低");
  createArrow(new THREE.Vector3(0.52, 1.28, 0.92), new THREE.Vector3(3.05, 1.28, 0.92), colors.field, "BC 反偏：电场增强");
  addBlockedCarrier(new THREE.Vector3(-2.25, 0.32, -0.38), new THREE.Vector3(-0.9, 0.16, -0.12), injectedColor, 0.02);
  addLabel("发射结变薄，接近注入条件", new THREE.Vector3(-1.25, -1.28, -0.78), 0.58);
  addLabel("集电结变宽，准备扫走载流子", new THREE.Vector3(1.45, -1.28, -0.78), 0.58);
}

function addFormationCarrier(start: THREE.Vector3, end: THREE.Vector3, color: number, offset: number) {
  const material = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.35,
    transparent: true,
    opacity: 0.9,
    roughness: 0.3
  });
  const carrier = new THREE.Mesh(new THREE.SphereGeometry(0.075, 20, 14), material);
  carrier.castShadow = true;
  root.add(carrier);

  animatedUpdates.push((elapsed) => {
    const cycle = (elapsed / 3.6 + offset) % 1;
    const travel = easeInOut(Math.min(cycle / 0.68, 1));
    const point = start.clone().lerp(end, travel);
    point.y += Math.sin((cycle + offset) * Math.PI * 2) * 0.08;
    carrier.position.copy(point);
    const recombining = Math.max(0, (cycle - 0.58) / 0.22);
    const restart = cycle > 0.82 ? 1 - (cycle - 0.82) / 0.18 : 1;
    const visible = THREE.MathUtils.clamp((1 - recombining) * restart, 0, 1);
    carrier.scale.setScalar(0.35 + visible * 0.85);
    material.opacity = 0.08 + visible * 0.82;
  });
}

function addRecombinationPulse(position: THREE.Vector3, offset: number) {
  const material = new THREE.MeshStandardMaterial({
    color: 0xfff0a3,
    emissive: 0xffd166,
    emissiveIntensity: 0.7,
    transparent: true,
    opacity: 0,
    roughness: 0.25
  });
  const pulse = new THREE.Mesh(new THREE.SphereGeometry(0.12, 24, 16), material);
  pulse.position.copy(position);
  root.add(pulse);

  animatedUpdates.push((elapsed) => {
    const cycle = (elapsed / 3.6 + offset) % 1;
    const local = THREE.MathUtils.clamp((cycle - 0.58) / 0.22, 0, 1);
    const visibility = Math.sin(local * Math.PI);
    pulse.scale.setScalar(0.3 + local * 1.8);
    material.opacity = visibility * 0.58;
  });
}

function addBlockedCarrier(start: THREE.Vector3, hit: THREE.Vector3, color: number, offset: number) {
  const material = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.35,
    transparent: true,
    opacity: 0.9,
    roughness: 0.32
  });
  const carrier = new THREE.Mesh(new THREE.SphereGeometry(0.085, 20, 14), material);
  carrier.castShadow = true;
  root.add(carrier);

  animatedUpdates.push((elapsed) => {
    const cycle = (elapsed / 2.8 + offset) % 1;
    const pingPong = cycle < 0.5 ? cycle * 2 : (1 - cycle) * 2;
    const travel = easeInOut(pingPong);
    const point = start.clone().lerp(hit, travel);
    point.z += Math.sin(cycle * Math.PI * 2 + offset * 4) * 0.05;
    carrier.position.copy(point);
    const bounce = 1 + Math.sin(travel * Math.PI) * 0.25;
    carrier.scale.setScalar(bounce);
    material.opacity = 0.45 + 0.45 * Math.sin(Math.PI * Math.max(0.1, pingPong));
  });
}

function addFlow(pathSpec: FlowPath) {
  const curve = new THREE.CatmullRomCurve3(pathSpec.points);
  const linePoints = curve.getPoints(80);
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(linePoints),
    new THREE.LineBasicMaterial({ color: pathSpec.color, transparent: true, opacity: activeMode === "structure" ? 0.2 : 0.58 })
  );
  root.add(line);

  for (let index = 0; index < pathSpec.count; index += 1) {
    const material = new THREE.MeshStandardMaterial({
      color: pathSpec.color,
      emissive: pathSpec.color,
      emissiveIntensity: activeMode === "flow" ? 0.45 : 0.1,
      transparent: true,
      opacity: 0.85,
      roughness: 0.34
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(pathSpec.radius, 20, 14), material);
    root.add(mesh);
    flows.push({ mesh, path: curve, speed: pathSpec.speed, offset: index / pathSpec.count });
  }

  const arrowStart = pathSpec.points[Math.max(0, Math.floor(pathSpec.points.length / 2) - 1)];
  const arrowEnd = pathSpec.points[Math.min(pathSpec.points.length - 1, Math.floor(pathSpec.points.length / 2) + 1)];
  const flowLabel = pathSpec.label === undefined ? (pathSpec.kind === "electron" ? "电子流" : pathSpec.kind === "hole" ? "空穴流" : "电场") : pathSpec.label;
  if (flowLabel) {
    createArrow(arrowStart, arrowEnd, pathSpec.color, flowLabel);
  }
}

function clearRoot() {
  flows.length = 0;
  animatedUpdates.length = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
    const material = mesh.material;
    if (Array.isArray(material)) {
      material.forEach((item) => item.dispose());
    } else if (material) {
      material.dispose();
    }
  });
  root.clear();
}

function buildDiode() {
  createBlock({ name: "P region", position: [-1.35, 0, 0], size: [2.5, 1.6, 2], color: colors.p, label: "P 区：空穴多" });
  createBlock({ name: "N region", position: [1.35, 0, 0], size: [2.5, 1.6, 2], color: colors.n, label: "N 区：电子多" });
  if (activeMode === "structure") {
    createDepletionRegion(0.82, 0.62, "耗尽层逐渐形成", true);
    addFieldSheet(0, 0.82, "内建电场阻止继续扩散", "normal");
    addPotentialBarrier(0, 1.05, 0.52, "势垒升高", true);
  } else if (activeMode === "bias") {
    createDepletionRegion(1.35, 0.72, "反偏：势垒加宽", false);
    addFieldSheet(0, 1.35, "反偏增强势垒", "high");
    addPotentialBarrier(0, 1.65, 0.72, "高势垒：挡住多数载流子", true);
  } else {
    createDepletionRegion(0.3, 0.46, "正偏：势垒降低", false);
    addFieldSheet(0, 0.34, "正偏削弱势垒", "low");
    addPotentialBarrier(0, 0.62, 0.24, "低势垒：可跨越", true);
  }

  createTerminal("阳极", new THREE.Vector3(-2.6, 0, 0), new THREE.Vector3(-1, 0, 0));
  createTerminal("阴极", new THREE.Vector3(2.6, 0, 0), new THREE.Vector3(1, 0, 0));
  addCarrierField(new THREE.Box3(new THREE.Vector3(-2.35, -0.52, -0.7), new THREE.Vector3(-0.72, 0.52, 0.7)), colors.hole, 14, "+");
  addCarrierField(new THREE.Box3(new THREE.Vector3(0.72, -0.52, -0.7), new THREE.Vector3(2.35, 0.52, 0.7)), colors.electron, 14, "-");

  if (activeMode === "structure") {
    addFixedIonLattice();
    addFormationCarrier(new THREE.Vector3(1.75, 0.34, -0.55), new THREE.Vector3(0.05, 0.18, -0.18), colors.electron, 0);
    addFormationCarrier(new THREE.Vector3(1.95, -0.2, 0.48), new THREE.Vector3(0.08, -0.08, 0.12), colors.electron, 0.28);
    addFormationCarrier(new THREE.Vector3(-1.78, -0.34, 0.52), new THREE.Vector3(-0.05, -0.18, 0.18), colors.hole, 0.1);
    addFormationCarrier(new THREE.Vector3(-1.95, 0.22, -0.45), new THREE.Vector3(-0.08, 0.08, -0.12), colors.hole, 0.38);
    addRecombinationPulse(new THREE.Vector3(0, 0.1, -0.1), 0);
    addRecombinationPulse(new THREE.Vector3(0, -0.12, 0.16), 0.28);
    addLabel("扩散后复合，自由载流子被耗尽", new THREE.Vector3(0, -1.28, -0.72), 0.7);
  } else if (activeMode === "bias") {
    createArrow(new THREE.Vector3(3.0, 1.08, 0.92), new THREE.Vector3(-3.0, 1.08, 0.92), colors.field, "反向偏置增强内建电场");
    addBlockedCarrier(new THREE.Vector3(1.95, 0.25, -0.45), new THREE.Vector3(0.75, 0.18, -0.2), colors.electron, 0);
    addBlockedCarrier(new THREE.Vector3(1.75, -0.28, 0.45), new THREE.Vector3(0.72, -0.18, 0.18), colors.electron, 0.28);
    addBlockedCarrier(new THREE.Vector3(-1.95, -0.25, -0.42), new THREE.Vector3(-0.75, -0.18, -0.18), colors.hole, 0.14);
    addBlockedCarrier(new THREE.Vector3(-1.72, 0.3, 0.42), new THREE.Vector3(-0.72, 0.18, 0.18), colors.hole, 0.42);
    addLabel("多数载流子到不了结区，电流≈0", new THREE.Vector3(0, -1.24, -0.72), 0.7);
  }

  if (activeMode === "flow") {
    createArrow(new THREE.Vector3(-3.2, 1.05, 0.9), new THREE.Vector3(3.2, 1.05, 0.9), colors.field, "正向偏置抵消内建电场");
    addFlow({
      points: [new THREE.Vector3(2.15, 0.15, -0.35), new THREE.Vector3(0.2, 0.12, -0.12), new THREE.Vector3(-1.85, 0.15, -0.35)],
      color: colors.electron,
      kind: "electron",
      speed: 0.16,
      count: 12,
      radius: 0.075
    });
    addFlow({
      points: [new THREE.Vector3(-2.15, -0.15, 0.35), new THREE.Vector3(-0.2, -0.12, 0.12), new THREE.Vector3(1.85, -0.15, 0.35)],
      color: colors.hole,
      kind: "hole",
      speed: 0.13,
      count: 12,
      radius: 0.085
    });
    addLabel("势垒变窄，多数载流子可以跨结", new THREE.Vector3(0, -1.24, -0.72), 0.7);
  }
}

function buildBjt(kind: "npn" | "pnp") {
  const isNpn = kind === "npn";
  const leftColor = isNpn ? colors.n : colors.p;
  const midColor = isNpn ? colors.p : colors.n;
  const carrierColor = isNpn ? colors.electron : colors.hole;
  const carrierKind: FlowKind = isNpn ? "electron" : "hole";
  const sign = isNpn ? "-" : "+";

  createBlock({ name: "emitter", position: [-2.15, 0, 0], size: [1.65, 1.8, 2], color: leftColor, label: isNpn ? "N 发射极" : "P 发射极" });
  createBlock({ name: "base", position: [0, 0, 0], size: [0.72, 1.8, 2], color: midColor, opacity: 0.76, label: isNpn ? "P 基区" : "N 基区" });
  createBlock({ name: "collector", position: [2.2, 0, 0], size: [2.05, 1.8, 2], color: leftColor, label: isNpn ? "N 集电极" : "P 集电极" });
  if (activeMode === "structure") {
    createDepletionRegion(0.24, 0.52, "BE 耗尽层形成", true, -0.76, new THREE.Vector3(-1.1, 1.34, -0.72));
    createDepletionRegion(0.28, 0.5, "BC 耗尽层形成", true, 0.74, new THREE.Vector3(1.08, 1.34, -0.72));
    addFieldSheet(-0.76, 0.32, "BE 内建电场", "normal");
    addFieldSheet(0.74, 0.36, "BC 内建电场", "normal");
    addPotentialBarrier(-0.76, 0.56, 0.38, "BE 势垒", true);
    addPotentialBarrier(0.74, 0.64, 0.42, "BC 势垒", true);
  } else if (activeMode === "bias") {
    createDepletionRegion(0.14, 0.46, "BE 正偏变窄", false, -0.76, new THREE.Vector3(-1.16, 1.34, -0.72));
    createDepletionRegion(0.52, 0.66, "BC 反偏变宽", false, 0.74, new THREE.Vector3(1.22, 1.34, -0.72));
    addFieldSheet(-0.76, 0.22, "BE 势垒降低", "low");
    addFieldSheet(0.74, 0.58, "BC 强电场区", "high");
    addPotentialBarrier(-0.76, 0.42, 0.2, "低 BE 势垒", true);
    addPotentialBarrier(0.74, 0.82, 0.64, "高 BC 势垒", true);
  } else {
    createDepletionRegion(0.1, 0.38, "BE 被正偏压薄", false, -0.76, new THREE.Vector3(-1.16, 1.34, -0.72));
    createDepletionRegion(0.58, 0.6, "BC 反偏收集区", false, 0.74, new THREE.Vector3(1.22, 1.34, -0.72));
    addFieldSheet(0.74, 0.62, false, "high");
    addPotentialBarrier(-0.76, 0.36, 0.15, false, true);
    addPotentialBarrier(0.74, 0.82, 0.58, false, true);
  }

  createTerminal("E", new THREE.Vector3(-3, 0, 0), new THREE.Vector3(-1, 0, 0));
  createTerminal("B", new THREE.Vector3(0, 0.92, 0), new THREE.Vector3(0, 1, 0));
  createTerminal("C", new THREE.Vector3(3.2, 0, 0), new THREE.Vector3(1, 0, 0));

  addCarrierField(new THREE.Box3(new THREE.Vector3(-2.82, -0.62, -0.68), new THREE.Vector3(-1.5, 0.62, 0.68)), carrierColor, 18, sign);
  addCarrierField(new THREE.Box3(new THREE.Vector3(1.45, -0.62, -0.68), new THREE.Vector3(2.95, 0.62, 0.68)), carrierColor, 14, sign);

  if (activeMode === "structure") {
    addBjtDepletionIons(kind);
    addBjtFormationAnimation(kind);
  } else if (activeMode === "bias") {
    addBjtBiasVisualization(kind);
  }

  if (activeMode === "flow") {
    createArrow(new THREE.Vector3(-2.9, 1.25, 0.9), new THREE.Vector3(-0.45, 1.25, 0.9), colors.field);
    createArrow(new THREE.Vector3(0.35, 1.25, 0.9), new THREE.Vector3(3.0, 1.25, 0.9), colors.field);
    addFlow({
      points: isNpn
        ? [new THREE.Vector3(-2.75, 0.18, -0.34), new THREE.Vector3(-0.7, 0.1, -0.16), new THREE.Vector3(0.28, 0.08, -0.08), new THREE.Vector3(2.85, 0.16, -0.32)]
        : [new THREE.Vector3(-2.75, -0.18, 0.34), new THREE.Vector3(-0.7, -0.1, 0.16), new THREE.Vector3(0.28, -0.08, 0.08), new THREE.Vector3(2.85, -0.16, 0.32)],
      color: carrierColor,
      kind: carrierKind,
      speed: 0.2,
      count: 18,
      radius: 0.08,
      label: false
    });
    addFlow({
      points: isNpn
        ? [new THREE.Vector3(-2.55, -0.2, 0.34), new THREE.Vector3(-0.7, -0.12, 0.16), new THREE.Vector3(0.32, -0.08, 0.08), new THREE.Vector3(2.72, -0.14, 0.3)]
        : [new THREE.Vector3(-2.55, 0.2, -0.34), new THREE.Vector3(-0.7, 0.12, -0.16), new THREE.Vector3(0.32, 0.08, -0.08), new THREE.Vector3(2.72, 0.14, -0.3)],
      color: carrierColor,
      kind: carrierKind,
      speed: 0.17,
      count: 12,
      radius: 0.065,
      label: false
    });
    addFlow({
      points: [new THREE.Vector3(0, 1.6, 0.28), new THREE.Vector3(0, 0.62, 0.12), new THREE.Vector3(-0.12, 0.08, 0.04)],
      color: isNpn ? colors.hole : colors.electron,
      kind: isNpn ? "hole" : "electron",
      speed: 0.08,
      count: 5,
      radius: 0.065,
      label: false
    });
    addLabel("少量复合 -> 基极电流", new THREE.Vector3(0.05, -1.28, -0.78), 0.58);
    addLabel("穿过薄基区 -> 被 C 收集", new THREE.Vector3(1.36, 0.86, 1.08), 0.6);
  }
}

function buildMos(kind: "nmos" | "pmos") {
  const isNmos = kind === "nmos";
  const substrateColor = isNmos ? colors.p : colors.n;
  const diffusionColor = isNmos ? colors.n : colors.p;
  const carrierColor = isNmos ? colors.electron : colors.hole;
  const carrierKind: FlowKind = isNmos ? "electron" : "hole";
  const channelColor = isNmos ? 0x4f91d6 : 0xe46c85;
  const sourceLabel = isNmos ? "N+ 源极" : "P+ 源极";
  const drainLabel = isNmos ? "N+ 漏极" : "P+ 漏极";

  createBlock({ name: "substrate", position: [0, -0.35, 0], size: [5.4, 1.35, 2.3], color: substrateColor, opacity: 0.74, label: isNmos ? "P 型衬底" : "N 型衬底" });
  createBlock({
    name: "source",
    position: [-1.75, 0.26, 0],
    size: [1.05, 0.58, 1.75],
    color: diffusionColor,
    label: sourceLabel,
    labelPosition: [-2.38, 1.04, -0.86]
  });
  createBlock({
    name: "drain",
    position: [1.75, 0.26, 0],
    size: [1.05, 0.58, 1.75],
    color: diffusionColor,
    label: drainLabel,
    labelPosition: [2.38, 1.04, -0.86]
  });
  createBlock({ name: "oxide", position: [0, 0.66, 0], size: [2.45, 0.16, 1.9], color: colors.oxide, opacity: 0.84, label: "SiO2", labelPosition: [-1.2, 0.46, 1.2] });
  createBlock({ name: "gate", position: [0, 0.98, 0], size: [2.2, 0.36, 1.75], color: colors.metal, opacity: 0.88, label: "金属栅" });

  if (activeMode !== "structure") {
    createBlock({
      name: "channel",
      position: [0, 0.36, 0],
      size: [2.56, 0.16, 1.55],
      color: channelColor,
      opacity: activeMode === "flow" ? 0.86 : 0.52,
      label: isNmos ? "N 反型沟道" : "P 反型沟道",
      labelPosition: [0, 0.58, -1.28]
    });
    createArrow(new THREE.Vector3(0, 1.7, 0.85), new THREE.Vector3(0, 0.82, 0.85), colors.field, isNmos ? "+VGS" : "-VGS");
  }

  createTerminal("S", new THREE.Vector3(-1.75, 0.56, 0), new THREE.Vector3(0, 1, 0));
  createTerminal("G", new THREE.Vector3(0, 1.18, 0), new THREE.Vector3(0, 1, 0));
  createTerminal("D", new THREE.Vector3(1.75, 0.56, 0), new THREE.Vector3(0, 1, 0));
  createTerminal("B", new THREE.Vector3(0, -1.04, 0), new THREE.Vector3(0, -1, 0));

  addCarrierField(
    new THREE.Box3(new THREE.Vector3(-2.18, 0.04, -0.55), new THREE.Vector3(-1.32, 0.5, 0.55)),
    carrierColor,
    12,
    isNmos ? "-" : "+"
  );
  addCarrierField(
    new THREE.Box3(new THREE.Vector3(1.32, 0.04, -0.55), new THREE.Vector3(2.18, 0.5, 0.55)),
    carrierColor,
    12,
    isNmos ? "-" : "+"
  );

  if (activeMode === "flow") {
    addFlow({
      points: isNmos
        ? [new THREE.Vector3(-1.9, 0.43, -0.22), new THREE.Vector3(0, 0.43, -0.12), new THREE.Vector3(1.9, 0.43, -0.22)]
        : [new THREE.Vector3(1.9, 0.43, 0.22), new THREE.Vector3(0, 0.43, 0.12), new THREE.Vector3(-1.9, 0.43, 0.22)],
      color: carrierColor,
      kind: carrierKind,
      speed: 0.17,
      count: 14,
      radius: 0.078
    });
  }
}

function updateCopy() {
  const data = copy[activeDevice];
  updateModeButtonLabels();
  deviceTitle.textContent = data.title;
  deviceSummary.textContent = data.summary;
  if (activeDevice === "diode") {
    if (activeMode === "structure") {
      biasState.textContent = "无外加电压：耗尽层自发形成";
      carrierState.textContent = "扩散后复合，留下固定离子";
    } else if (activeMode === "bias") {
      biasState.textContent = "反向偏置：耗尽层加宽";
      carrierState.textContent = "多数载流子被势垒挡回，电流≈0";
    } else {
      biasState.textContent = "正向偏置：耗尽层变窄";
      carrierState.textContent = "电子与空穴跨过 PN 结，形成大电流";
    }
  } else if (activeDevice === "npn" || activeDevice === "pnp") {
    const carrier = activeDevice === "npn" ? "电子" : "空穴";
    if (activeMode === "structure") {
      biasState.textContent = "无外加偏置：两个 PN 结自建耗尽层";
      carrierState.textContent = "结区复合后留下固定离子和内建电场";
    } else if (activeMode === "bias") {
      biasState.textContent = activeDevice === "npn" ? "BE 正偏变窄，BC 反偏变宽" : "EB 正偏变窄，CB 反偏变宽";
      carrierState.textContent = `发射结势垒降低，${carrier}接近注入条件`;
    } else {
      biasState.textContent = activeDevice === "npn" ? "BE 正偏，BC 反偏：放大区导通" : "EB 正偏，CB 反偏：放大区导通";
      carrierState.textContent = `${carrier}穿过薄基区，被集电结电场收集`;
    }
  } else {
    biasState.textContent = activeMode === "structure" ? "观察结构" : data.bias;
    carrierState.textContent =
      activeMode === "structure" ? "标出多数载流子与掺杂区" : activeMode === "bias" ? "外加电场改变势垒/沟道" : data.carriers;
  }
  principleList.innerHTML = "";
  data.principles.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    principleList.appendChild(li);
  });
}

function updateModeButtonLabels() {
  const diodeLabels: Record<ModeKey, string> = {
    structure: "形成",
    bias: "阻断",
    flow: "导通"
  };
  const defaultLabels: Record<ModeKey, string> = {
    structure: "结构",
    bias: "偏置",
    flow: "导通"
  };
  const labels = activeDevice === "diode" ? diodeLabels : defaultLabels;
  modeButtons.forEach((button) => {
    const mode = button.dataset.mode as ModeKey;
    button.textContent = labels[mode];
  });
}

function rebuild() {
  clearRoot();
  updateCopy();
  if (activeDevice === "diode") {
    buildDiode();
  } else if (activeDevice === "npn" || activeDevice === "pnp") {
    buildBjt(activeDevice);
  } else {
    buildMos(activeDevice);
  }
}

function resize() {
  const { clientWidth, clientHeight } = sceneContainer;
  renderer.setSize(clientWidth, clientHeight, false);
  camera.aspect = clientWidth / Math.max(clientHeight, 1);
  camera.updateProjectionMatrix();
  drawCurrentCurve();
}

function animate() {
  requestAnimationFrame(animate);
  const elapsed = clock.getElapsedTime();
  animatedUpdates.forEach((update) => update(elapsed));
  flows.forEach(({ mesh, path, speed, offset }) => {
    const intensity = THREE.MathUtils.clamp(conductionLevel, 0.02, 1);
    const t = activeMode === "flow" ? (elapsed * speed * (0.25 + intensity * 1.55) + offset) % 1 : offset;
    const point = path.getPointAt(t);
    mesh.position.copy(point);
    const pulse = activeMode === "flow" ? 0.72 + intensity * 0.55 + Math.sin((elapsed + offset) * 7) * 0.12 * intensity : 0.76;
    mesh.scale.setScalar(pulse);
    const material = mesh.material as THREE.MeshStandardMaterial;
    material.opacity = 0.35 + intensity * 0.65;
    material.emissiveIntensity = 0.15 + intensity * 0.75;
  });
  controls.update();
  renderer.render(scene, camera);
}

deviceSelect.addEventListener("change", () => {
  activeDevice = deviceSelect.value as DeviceKey;
  setBiasForDevice(activeDevice);
  updateCurvePanel(true);
});

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeMode = button.dataset.mode as ModeKey;
    setBiasForMode(activeMode);
    updateCurvePanel(true);
  });
});

biasSlider.addEventListener("input", () => {
  biasControlValue = Number(biasSlider.value);
  updateCurvePanel(false);
});

currentCurve.addEventListener("pointerdown", (event) => {
  isDraggingCurve = true;
  currentCurve.setPointerCapture(event.pointerId);
  setBiasFromCanvas(event.clientX);
});

currentCurve.addEventListener("pointermove", (event) => {
  if (isDraggingCurve) {
    setBiasFromCanvas(event.clientX);
  }
});

currentCurve.addEventListener("pointerup", (event) => {
  isDraggingCurve = false;
  currentCurve.releasePointerCapture(event.pointerId);
});

currentCurve.addEventListener("pointerleave", () => {
  isDraggingCurve = false;
});

window.addEventListener("resize", resize);
resize();
setBiasForDevice(activeDevice);
updateCurvePanel(true);
animate();
