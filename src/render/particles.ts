import * as THREE from "three";
import type { MeshInfo, SolveResultMsg } from "../worker/protocol";
import type { DeviceView } from "./device";
import { sharedGlowTexture } from "./effects";

export type Carrier = "n" | "p";

export interface FlowPath {
  carrier: Carrier;
  /** polyline in (x, y) μm; a small random lateral spread is added per particle */
  pts: Array<[number, number]>;
  /** speed multiplier per segment */
  speed: number[];
  /** random-walk amplitude per segment (μm) */
  jitter: number[];
  rate: number; // particles per second
  /** "exit" leaves at the end, "recombine" flashes at a random point after `recombineFrom` */
  fate: "exit" | "recombine";
  recombineFrom?: number;
  spread?: number; // lateral start spread (μm) applied in x
  spreadY?: number;
  /** a pair-generation flash at the start */
  birthFlash?: boolean;
}

const VERT = `
attribute float alpha;
attribute float psize;
attribute vec3 color;
varying float vAlpha;
varying vec3 vColor;
uniform float scale;
void main() {
  vAlpha = alpha;
  vColor = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = psize * scale / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = `
uniform sampler2D map;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 t = texture2D(map, gl_PointCoord);
  gl_FragColor = vec4(vColor * t.rgb, t.a * vAlpha);
}`;

class PointCloud {
  readonly points: THREE.Points;
  readonly pos: Float32Array;
  readonly col: Float32Array;
  readonly alpha: Float32Array;
  readonly size: Float32Array;
  constructor(readonly capacity: number, additive: boolean) {
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.alpha = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("color", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("alpha", new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("psize", new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    const m = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { map: { value: sharedGlowTexture() }, scale: { value: 300 } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = 15;
  }
  commit(count: number) {
    const g = this.points.geometry;
    g.setDrawRange(0, count);
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.alpha as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.psize as THREE.BufferAttribute).needsUpdate = true;
  }
  dispose() {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

interface Mover {
  path: number;
  s: number; // distance along path, μm
  ox: number;
  oy: number;
  jx: number;
  jy: number;
  dieAt: number;
  life: number;
}

interface Flash {
  x: number;
  y: number;
  age: number;
  color: [number, number, number];
}

const E_COLOR: [number, number, number] = [0.33, 0.68, 1.0];
const H_COLOR: [number, number, number] = [1.0, 0.36, 0.42];

interface PreparedPath {
  def: FlowPath;
  cum: number[];
  length: number;
  acc: number;
}

/** Animated carriers drawn just in front of the cross-section. */
export class CarrierAnimator {
  private movers: Mover[] = [];
  private flashes: Flash[] = [];
  private paths: PreparedPath[] = [];
  private movingCloud = new PointCloud(1600, true);
  private bgCloud = new PointCloud(900, false);
  private flashCloud = new PointCloud(200, true);
  private bg: Array<{ x: number; y: number; c: Carrier; ax: number; ay: number; ph: number }> = [];
  private bgAlpha = 0;
  private disposeTick: () => void;
  private enabled = true;
  private baseSpeed: number;
  private group = new THREE.Group();

  constructor(private view: DeviceView) {
    this.group.add(this.bgCloud.points, this.movingCloud.points, this.flashCloud.points);
    view.overlay.add(this.group);
    const d = view.def.domain;
    this.baseSpeed = (d.x1 - d.x0) * 0.11;
    this.disposeTick = view.stage.onTick((dt) => this.tick(dt));
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    this.group.visible = on;
  }

  setFlows(flows: FlowPath[]) {
    const prevAcc = new Map(this.paths.map((p, i) => [i, p.acc]));
    this.paths = flows.map((def, i) => {
      const cum = [0];
      for (let k = 1; k < def.pts.length; k += 1) {
        cum.push(cum[k - 1] + Math.hypot(def.pts[k][0] - def.pts[k - 1][0], def.pts[k][1] - def.pts[k - 1][1]));
      }
      return { def, cum, length: cum[cum.length - 1], acc: prevAcc.get(i) ?? Math.random() };
    });
    // movers on removed paths are dropped
    this.movers = this.movers.filter((m) => m.path < this.paths.length && this.paths[m.path].def.carrier === this.carrierOf(m));
  }

  private carrierOf(m: Mover) {
    return this.paths[m.path]?.def.carrier;
  }

  /** Majority/minority carrier cloud sampled from the solution (depletion regions come out empty). */
  setBackground(mesh: MeshInfo, sol: SolveResultMsg, top: number) {
    const d = this.view.def.domain;
    const pts: typeof this.bg = [];
    const { xs, ys, nx, ny } = mesh;
    const find = (arr: Float64Array, v: number) => {
      let lo = 0;
      let hi = arr.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] <= v) lo = mid;
        else hi = mid;
      }
      return v - arr[lo] < arr[hi] - v ? lo : hi;
    };
    const area = (d.x1 - d.x0) * (d.y1 - top);
    const target = Math.min(820, Math.round(260 + area * 30));
    let guard = 0;
    while (pts.length < target && guard < target * 60) {
      guard += 1;
      const x = d.x0 + Math.random() * (d.x1 - d.x0);
      // bias sampling toward the surface where devices live
      const u = Math.random();
      const y = top + Math.pow(u, 1.8) * (d.y1 - top);
      const k = find(ys, y) * nx + find(xs, x);
      if (k < 0 || k >= nx * ny || !mesh.si[k]) continue;
      const n = sol.n[k];
      const p = sol.p[k];
      const c: Carrier = n >= p ? "n" : "p";
      const conc = Math.max(n, p);
      const acc = Math.pow(Math.min(Math.max((Math.log10(conc) - 14.5) / 5, 0), 1), 1.4);
      if (Math.random() > acc) continue;
      pts.push({ x, y, c, ax: 0, ay: 0, ph: Math.random() * 10 });
    }
    this.bg = pts;
    this.bgAlpha = 0;
  }

  private spawn(pathIndex: number) {
    const p = this.paths[pathIndex];
    const def = p.def;
    if (this.movers.length >= this.movingCloud.capacity) return;
    const spread = def.spread ?? 0;
    const spreadY = def.spreadY ?? 0;
    const dieAt =
      def.fate === "recombine" ? p.length * ((def.recombineFrom ?? 0.5) + Math.random() * (1 - (def.recombineFrom ?? 0.5))) : p.length;
    this.movers.push({ path: pathIndex, s: 0, ox: (Math.random() - 0.5) * spread, oy: (Math.random() - 0.5) * spreadY, jx: 0, jy: 0, dieAt, life: 0 });
    if (def.birthFlash) {
      const [x, y] = def.pts[0];
      this.flashes.push({ x, y, age: 0, color: [1, 0.95, 0.7] });
    }
  }

  private locate(p: PreparedPath, s: number): [number, number, number] {
    const { cum, def } = p;
    let k = 1;
    while (k < cum.length - 1 && cum[k] < s) k += 1;
    const seg = cum[k] - cum[k - 1] || 1;
    const f = Math.min(Math.max((s - cum[k - 1]) / seg, 0), 1);
    const a = def.pts[k - 1];
    const b = def.pts[k];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, k - 1];
  }

  private tick(dt: number) {
    if (!this.enabled) return;
    const v = this.view;
    const s = v.s;
    const z = 0.03 * s;
    // spawn
    this.paths.forEach((p, i) => {
      p.acc += p.def.rate * dt;
      while (p.acc >= 1) {
        p.acc -= 1;
        this.spawn(i);
      }
    });
    // move
    const alive: Mover[] = [];
    const cloud = this.movingCloud;
    let count = 0;
    for (const m of this.movers) {
      const p = this.paths[m.path];
      if (!p) continue;
      const [, , seg] = this.locate(p, m.s);
      const speed = this.baseSpeed * (p.def.speed[seg] ?? 1);
      m.s += speed * dt;
      m.life += dt;
      const jit = p.def.jitter[seg] ?? 0;
      m.jx += (Math.random() - 0.5) * jit * 0.9 - m.jx * dt * 3;
      m.jy += (Math.random() - 0.5) * jit * 0.9 - m.jy * dt * 3;
      if (m.s >= m.dieAt) {
        if (p.def.fate === "recombine") {
          const [x, y] = this.locate(p, m.dieAt);
          this.flashes.push({ x: x + m.ox + m.jx, y: y + m.oy + m.jy, age: 0, color: [1, 0.9, 0.45] });
        }
        continue;
      }
      alive.push(m);
      const [x, y] = this.locate(p, m.s);
      const fadeIn = Math.min(m.life / 0.25, 1);
      const fadeOut = p.def.fate === "exit" ? Math.min((m.dieAt - m.s) / (this.baseSpeed * 0.25), 1) : 1;
      const col = p.def.carrier === "n" ? E_COLOR : H_COLOR;
      cloud.pos[count * 3] = (x + m.ox + m.jx - v.cx) * s;
      cloud.pos[count * 3 + 1] = -(y + m.oy + m.jy) * s;
      cloud.pos[count * 3 + 2] = z;
      cloud.col[count * 3] = col[0];
      cloud.col[count * 3 + 1] = col[1];
      cloud.col[count * 3 + 2] = col[2];
      cloud.alpha[count] = fadeIn * fadeOut;
      cloud.size[count] = 0.34;
      count += 1;
    }
    this.movers = alive;
    cloud.commit(count);

    // background cloud
    this.bgAlpha = Math.min(1, this.bgAlpha + dt / 0.5);
    const bg = this.bgCloud;
    let bc = 0;
    const t = performance.now() / 1000;
    const amp = (v.def.domain.x1 - v.def.domain.x0) * 0.004;
    for (const b of this.bg) {
      if (bc >= bg.capacity) break;
      const jx = Math.sin(t * 2.1 + b.ph) * amp + Math.sin(t * 5.3 + b.ph * 1.7) * amp * 0.5;
      const jy = Math.cos(t * 1.7 + b.ph * 0.8) * amp + Math.cos(t * 4.1 + b.ph * 2.3) * amp * 0.5;
      const col = b.c === "n" ? E_COLOR : H_COLOR;
      bg.pos[bc * 3] = (b.x + jx - v.cx) * s;
      bg.pos[bc * 3 + 1] = -(b.y + jy) * s;
      bg.pos[bc * 3 + 2] = z * 0.7;
      bg.col[bc * 3] = col[0] * 0.8;
      bg.col[bc * 3 + 1] = col[1] * 0.8;
      bg.col[bc * 3 + 2] = col[2] * 0.8;
      bg.alpha[bc] = 0.5 * this.bgAlpha;
      bg.size[bc] = 0.2;
      bc += 1;
    }
    bg.commit(bc);

    // flashes
    const fl = this.flashCloud;
    let fc = 0;
    this.flashes = this.flashes.filter((f) => (f.age += dt) < 0.55);
    for (const f of this.flashes) {
      if (fc >= fl.capacity) break;
      const k = f.age / 0.55;
      fl.pos[fc * 3] = (f.x - v.cx) * s;
      fl.pos[fc * 3 + 1] = -f.y * s;
      fl.pos[fc * 3 + 2] = z * 1.2;
      fl.col[fc * 3] = f.color[0];
      fl.col[fc * 3 + 1] = f.color[1];
      fl.col[fc * 3 + 2] = f.color[2];
      fl.alpha[fc] = (1 - k) * 0.95;
      fl.size[fc] = 0.4 + k * 1.1;
      fc += 1;
    }
    fl.commit(fc);
  }

  dispose() {
    this.disposeTick();
    this.view.overlay.remove(this.group);
    this.movingCloud.dispose();
    this.bgCloud.dispose();
    this.flashCloud.dispose();
  }
}
