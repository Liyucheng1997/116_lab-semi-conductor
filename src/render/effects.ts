import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { implantRange, isDonor, type ProcessState, type Rect, type StepAnimation } from "../physics/process";
import type { DeviceView } from "./device";
import { sci } from "../ui/explain";

export function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.55, "rgba(255,255,255,0.25)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let sharedGlow: THREE.Texture | null = null;
export function sharedGlowTexture() {
  if (!sharedGlow) sharedGlow = glowTexture();
  return sharedGlow;
}

/** Highest point of the whole layer stack (μm, negative = above the silicon surface). */
export function stackTopAll(state: ProcessState) {
  let top = state.siliconTop;
  state.layers.forEach((l) => l.prisms.forEach((p) => p.poly.forEach((q) => (top = Math.min(top, q[1])))));
  return top;
}

/** Top of the stack (μm, negative = above the silicon surface) at plan position (x, z). */
function stackTop(state: ProcessState, x: number, z: number) {
  let top = state.siliconTop;
  state.layers.forEach((l) => {
    for (const p of l.prisms) {
      if (z < p.z0 || z > p.z1) continue;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      for (const [px, py] of p.poly) {
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
      }
      if (x >= minX && x <= maxX) top = Math.min(top, minY);
    }
  });
  return top;
}

function inside(rects: Rect[], x: number, z: number) {
  return rects.some((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1);
}

/** Process-step effects: ion beam, UV exposure, furnace glow and floating annotations. */
export class ProcessEffects {
  private group = new THREE.Group();
  private disposeTick: () => void;
  private ions: {
    points: THREE.Points;
    pos: Float32Array;
    data: Array<{ x: number; z: number; y: number; stop: number; v: number; wait: number }>;
  } | null = null;
  private uv: THREE.Mesh[] = [];
  private time = 0;
  private beamTop = -3;

  constructor(private view: DeviceView) {
    view.overlay.add(this.group);
    this.disposeTick = view.stage.onTick((dt) => this.tick(dt));
  }

  clear() {
    [...this.group.children].forEach((o) => {
      this.group.remove(o);
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose?.();
      if (o instanceof CSS2DObject) o.element.remove();
    });
    this.ions = null;
    this.uv = [];
    this.view.setGlow(false);
  }

  show(anim: StepAnimation, state: ProcessState) {
    this.clear();
    const d = this.view.def.domain;
    if (anim.kind === "implant") this.buildImplant(anim, state);
    if (anim.kind === "litho") this.buildLitho(state, anim.resistId);
    if (anim.kind === "anneal") {
      this.view.setGlow(anim.tC > 600);
      this.caption(`炉温 ${anim.tC} °C · ${anim.minutes >= 1 ? `${anim.minutes} min` : `${(anim.minutes * 60).toFixed(0)} s`}`, (d.x0 + d.x1) / 2, stackTopAll(state) - 0.5, "heat");
    }
  }

  private caption(text: string, x: number, y: number, tone: string) {
    const el = document.createElement("div");
    el.className = `tag tag-fx tag-fx-${tone}`;
    el.textContent = text;
    const obj = new CSS2DObject(el);
    obj.position.copy(this.view.toScene(x, y, -0.5));
    this.group.add(obj);
  }

  private buildImplant(anim: Extract<StepAnimation, { kind: "implant" }>, state: ProcessState) {
    const d = this.view.def.domain;
    const [rp] = implantRange(anim.species, anim.energy);
    const count = 900;
    const pos = new Float32Array(count * 3);
    const data: Array<{ x: number; z: number; y: number; stop: number; v: number; wait: number }> = [];
    const beamTop = stackTopAll(state) - 1.2;
    this.beamTop = beamTop;
    for (let i = 0; i < count; i += 1) {
      const front = i % 3 === 0;
      const x = d.x0 + Math.random() * (d.x1 - d.x0);
      const z = front ? 0.005 : d.z0 + Math.random() * (d.z1 - d.z0);
      const open = inside(anim.openings, x, front ? -0.01 : z) && stackTop(state, x, front ? -0.01 : z) >= state.siliconTop - 0.02;
      const stop = open ? state.siliconTop + rp * (0.6 + 0.8 * Math.random()) : stackTop(state, x, front ? -0.01 : z);
      data.push({ x, z, y: beamTop - Math.random() * 1.5, stop, v: 2.2 + Math.random(), wait: Math.random() * 2 });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const donor = isDonor[anim.species];
    const mat = new THREE.PointsMaterial({
      color: donor ? 0x5cc8ff : 0xff7a5c,
      size: 0.32,
      map: sharedGlowTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false; // positions are animated every frame
    points.renderOrder = 20;
    this.group.add(points);
    this.ions = { points, pos, data };
    const label = `${anim.species}⁺ 离子束 · ${anim.energy} keV · ${sci(anim.dose, anim.dose / Math.pow(10, Math.floor(Math.log10(anim.dose))) % 1 ? 1 : 0)} cm⁻² · R_p ≈ ${(rp * 1000).toFixed(0)} nm`;
    this.caption(label, (d.x0 + d.x1) / 2, beamTop - 0.3, donor ? "donor" : "acceptor");
    // beam shroud
    const w = (d.x1 - d.x0) * this.view.s;
    const depth = (d.z1 - d.z0) * this.view.s;
    const shroud = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.02, depth),
      new THREE.MeshBasicMaterial({ color: donor ? 0x5cc8ff : 0xff7a5c, transparent: true, opacity: 0.12, depthWrite: false })
    );
    shroud.position.copy(this.view.toScene((d.x0 + d.x1) / 2, beamTop, (d.z0 + d.z1) / 2));
    this.group.add(shroud);
  }

  private buildLitho(state: ProcessState, resistId: string) {
    const d = this.view.def.domain;
    const resist = state.layers.get(resistId);
    if (!resist) return;
    // exposed = plan-view area not covered by remaining resist
    const xs = new Set<number>([d.x0, d.x1]);
    const zs = new Set<number>([d.z0, d.z1]);
    const foot = resist.prisms.map((p) => {
      const px = p.poly.map((q) => q[0]);
      const r = { x0: Math.min(...px), x1: Math.max(...px), z0: Math.max(p.z0, d.z0), z1: Math.min(p.z1, d.z1) };
      xs.add(Math.min(Math.max(r.x0, d.x0), d.x1));
      xs.add(Math.min(Math.max(r.x1, d.x0), d.x1));
      zs.add(Math.min(Math.max(r.z0, d.z0), d.z1));
      zs.add(Math.min(Math.max(r.z1, d.z0), d.z1));
      return r;
    });
    let resistTop = 0;
    resist.prisms.forEach((p) => p.poly.forEach((q) => (resistTop = Math.min(resistTop, q[1]))));
    const xa = [...xs].sort((a, b) => a - b);
    const za = [...zs].sort((a, b) => a - b);
    const reticleY = resistTop - 1.3;
    const chrome = new THREE.MeshStandardMaterial({ color: 0x1b1f24, metalness: 0.8, roughness: 0.3 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0xcfe6ff, transparent: true, opacity: 0.18, roughness: 0.05, depthWrite: false });
    const s = this.view.s;
    const plate = new THREE.Mesh(new THREE.BoxGeometry((d.x1 - d.x0) * s, 0.06, (d.z1 - d.z0) * s), glass);
    plate.position.copy(this.view.toScene((d.x0 + d.x1) / 2, reticleY, (d.z0 + d.z1) / 2));
    this.group.add(plate);
    for (let i = 0; i < xa.length - 1; i += 1) {
      for (let k = 0; k < za.length - 1; k += 1) {
        const cx = (xa[i] + xa[i + 1]) / 2;
        const cz = (za[k] + za[k + 1]) / 2;
        const covered = foot.some((r) => cx > r.x0 && cx < r.x1 && cz > r.z0 && cz < r.z1);
        const w = (xa[i + 1] - xa[i]) * s;
        const dep = (za[k + 1] - za[k]) * s;
        if (w < 1e-4 || dep < 1e-4) continue;
        if (covered) {
          const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.03, dep), chrome);
          m.position.copy(this.view.toScene(cx, reticleY + 0.01, cz));
          this.group.add(m);
        } else {
          const h = (resistTop - reticleY) * s;
          const beam = new THREE.Mesh(
            new THREE.BoxGeometry(w * 0.98, Math.abs(h), dep * 0.98),
            new THREE.MeshBasicMaterial({ color: 0x9d7bff, transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending })
          );
          beam.position.copy(this.view.toScene(cx, (resistTop + reticleY) / 2, cz));
          this.group.add(beam);
          this.uv.push(beam);
        }
      }
    }
    this.caption("掩模版 + i-line / DUV 紫外曝光", (d.x0 + d.x1) / 2, reticleY - 0.35, "uv");
  }

  private tick(dt: number) {
    this.time += dt;
    this.uv.forEach((m, i) => {
      (m.material as THREE.MeshBasicMaterial).opacity = 0.12 + 0.1 * (0.5 + 0.5 * Math.sin(this.time * 5 + i));
    });
    if (!this.ions) return;
    const { pos, data, points } = this.ions;
    const s = this.view.s;
    for (let i = 0; i < data.length; i += 1) {
      const ion = data[i];
      if (ion.wait > 0) {
        ion.wait -= dt;
        pos[i * 3 + 1] = 1e4;
        continue;
      }
      ion.y += ion.v * dt * (ion.y < ion.stop ? 1 : 0);
      if (ion.y >= ion.stop) {
        ion.y = ion.stop;
        ion.wait -= dt;
        if (ion.wait < -0.6) {
          ion.y = this.beamTop - Math.random() * 1.2;
          ion.wait = Math.random() * 0.8;
        }
      }
      pos[i * 3] = (ion.x - this.view.cx) * s;
      pos[i * 3 + 1] = -ion.y * s;
      pos[i * 3 + 2] = ion.z * s;
    }
    points.geometry.attributes.position.needsUpdate = true;
  }

  dispose() {
    this.clear();
    this.disposeTick();
    this.view.overlay.remove(this.group);
  }
}
