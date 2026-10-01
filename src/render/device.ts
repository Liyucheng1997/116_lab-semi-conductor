import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { CutlineDef, DeviceDefinition } from "../devices/types";
import type { Layer, ProcessState, Prism } from "../physics/process";
import { MATERIALS, makeLayerMaterial } from "./materials";
import type { Stage } from "./stage";

interface LayerView {
  id: string;
  sig: string;
  group: THREE.Group;
  mesh: THREE.Mesh;
  mat: THREE.MeshPhysicalMaterial;
  edge: THREE.LineBasicMaterial;
  baseOpacity: number;
  baseEdgeOpacity: number;
  kind: "dielectric" | "ild" | "metal" | "resist" | "gate";
  fade: number; // 0..1 current visibility multiplier
  target: number;
  slide: number;
}

export interface DimSpec {
  a: [number, number];
  b: [number, number];
  text: string;
  side?: "left" | "right" | "top" | "bottom";
  offset?: number;
}

function sig(layer: Layer) {
  return layer.material + "|" + layer.prisms.map((p) => `${p.z0.toFixed(3)},${p.z1.toFixed(3)}:${p.poly.map((q) => q.map((v) => v.toFixed(4)).join(",")).join(";")}`).join("/");
}

/** 3-D model of a device cross-section cut at z = 0. Units: 1 μm = `s` scene units. */
export class DeviceView {
  readonly group = new THREE.Group();
  readonly s: number;
  readonly cx: number;
  private layers = new Map<string, LayerView>();
  private silicon: THREE.Mesh | null = null;
  private siMaterials: THREE.MeshStandardMaterial[] = [];
  private siTop = Number.NaN;
  private labels = new THREE.Group();
  private dims = new THREE.Group();
  private cutline = new THREE.Group();
  readonly overlay = new THREE.Group();
  private visibility = { ild: true, metal: true };
  private glow = 0;
  private glowTarget = 0;
  private disposeTick: () => void;

  constructor(
    readonly stage: Stage,
    readonly def: DeviceDefinition
  ) {
    const d = def.domain;
    this.s = 8.4 / (d.x1 - d.x0);
    this.cx = 0.5 * (d.x0 + d.x1);
    this.group.add(this.labels, this.dims, this.cutline, this.overlay);
    stage.root.add(this.group);
    stage.setFloor(-(d.y1 + 0.35) * this.s);
    this.disposeTick = stage.onTick((dt) => this.tick(dt));
  }

  toScene(x: number, y: number, z: number) {
    return new THREE.Vector3((x - this.cx) * this.s, -y * this.s, z * this.s);
  }

  /** bounding box of the finished device in scene units */
  bounds(topUm?: number) {
    const d = this.def.domain;
    const top = topUm ?? -0.3 * (d.y1 - d.y0);
    return new THREE.Box3(this.toScene(d.x0, d.y1, d.z0), this.toScene(d.x1, top, d.z1));
  }

  private buildGeometry(prisms: Prism[]) {
    const d = this.def.domain;
    const geos: THREE.BufferGeometry[] = [];
    for (const p of prisms) {
      const z0 = Math.max(p.z0, d.z0);
      const z1 = Math.min(p.z1, d.z1);
      if (z1 - z0 < 1e-6) continue;
      const shape = new THREE.Shape(p.poly.map(([x, y]) => new THREE.Vector2((x - this.cx) * this.s, -y * this.s)));
      const g = new THREE.ExtrudeGeometry(shape, { depth: (z1 - z0) * this.s, bevelEnabled: false, steps: 1 });
      g.translate(0, 0, z0 * this.s);
      geos.push(g);
    }
    if (!geos.length) return null;
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    return merged;
  }

  setProcess(state: ProcessState, animate: boolean) {
    this.setSilicon(state.siliconTop);
    const seen = new Set<string>();
    state.layers.forEach((layer) => {
      const key = layer.id;
      const signature = sig(layer);
      const existing = this.layers.get(key);
      seen.add(key);
      if (existing && existing.sig === signature) {
        existing.target = 1;
        return;
      }
      if (existing) this.retire(existing, animate);
      const view = this.createLayer(layer, signature);
      if (!view) return;
      if (animate) {
        view.fade = 0;
        view.slide = existing ? 0 : 1;
      }
      this.layers.set(key, view);
    });
    // collect first: retire() inserts ghost entries, which Map.forEach would otherwise keep visiting
    const stale = [...this.layers.entries()].filter(([key, view]) => !seen.has(key) && view.target !== 0);
    stale.forEach(([, view]) => this.retire(view, animate));
  }

  private retire(view: LayerView, animate: boolean) {
    this.layers.delete(view.id);
    const ghostKey = `${view.id}#ghost${Math.random()}`;
    view.id = ghostKey;
    view.target = 0;
    if (!animate) {
      view.fade = 0;
      this.disposeLayer(view);
      return;
    }
    this.layers.set(ghostKey, view);
  }

  private disposeLayer(view: LayerView) {
    this.group.remove(view.group);
    view.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
    });
    view.mat.dispose();
    view.edge.dispose();
  }

  private createLayer(layer: Layer, signature: string): LayerView | null {
    const geo = this.buildGeometry(layer.prisms);
    if (!geo) return null;
    const { mat, edge, baseOpacity, baseEdgeOpacity, translucent } = makeLayerMaterial(layer.material);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = !translucent;
    mesh.receiveShadow = true;
    mesh.renderOrder = translucent ? 2 : 0;
    const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), edge);
    lines.renderOrder = 3;
    const group = new THREE.Group();
    group.add(mesh, lines);
    this.group.add(group);
    const kind = MATERIALS[layer.material].group;
    const view: LayerView = {
      id: layer.id,
      sig: signature,
      group,
      mesh,
      mat,
      edge,
      baseOpacity,
      baseEdgeOpacity,
      kind,
      fade: 1,
      target: 1,
      slide: 0
    };
    this.applyFade(view);
    return view;
  }

  private visibleKind(kind: LayerView["kind"]) {
    if (kind === "ild") return this.visibility.ild;
    if (kind === "metal") return this.visibility.metal;
    return true;
  }

  private applyFade(view: LayerView) {
    const vis = this.visibleKind(view.kind) ? 1 : 0;
    const f = view.fade * vis;
    view.mat.opacity = view.baseOpacity * f;
    view.edge.opacity = view.baseEdgeOpacity * f;
    view.group.visible = f > 0.01;
    view.mat.depthWrite = view.baseOpacity >= 1 && f > 0.98;
    view.group.position.y = view.slide * 0.6;
  }

  setVisibility(v: { ild: boolean; metal: boolean }) {
    this.visibility = v;
    this.layers.forEach((l) => this.applyFade(l));
  }

  private tick(dt: number) {
    const rate = dt / 0.75;
    const dead: LayerView[] = [];
    this.layers.forEach((view) => {
      let changed = false;
      if (view.fade !== view.target) {
        view.fade = view.target > view.fade ? Math.min(view.target, view.fade + rate) : Math.max(view.target, view.fade - rate);
        changed = true;
      }
      if (view.slide > 0) {
        view.slide = Math.max(0, view.slide - rate * 1.2);
        changed = true;
      }
      if (changed) this.applyFade(view);
      if (view.target === 0 && view.fade === 0) dead.push(view);
    });
    dead.forEach((v) => {
      this.layers.delete(v.id);
      this.disposeLayer(v);
    });
    if (this.glow !== this.glowTarget) {
      this.glow += Math.sign(this.glowTarget - this.glow) * Math.min(Math.abs(this.glowTarget - this.glow), dt / 0.6);
    }
    const pulse = this.glow * (0.75 + 0.25 * Math.sin(performance.now() / 260));
    this.siMaterials.forEach((m, i) => {
      if (i === 3) return;
      m.emissive.setRGB(0.55 + pulse * 0.9, 0.55 + pulse * 0.25, 0.55 - pulse * 0.2);
    });
  }

  setGlow(on: boolean) {
    this.glowTarget = on ? 1 : 0;
  }

  private setSilicon(top: number) {
    if (this.silicon && top === this.siTop) return;
    const d = this.def.domain;
    this.siTop = top;
    const w = (d.x1 - d.x0) * this.s;
    const h = (d.y1 - top) * this.s;
    const depth = (d.z1 - d.z0) * this.s;
    const geo = new THREE.BoxGeometry(w, h, depth);
    if (!this.siMaterials.length) {
      for (let i = 0; i < 6; i += 1) {
        this.siMaterials.push(
          new THREE.MeshStandardMaterial({
            color: i === 4 ? 0x5a5a5a : 0x7a7a7a,
            roughness: 0.75,
            metalness: 0.0,
            emissive: 0xffffff,
            emissiveIntensity: i === 4 ? 0.92 : 0.62
          })
        );
      }
      this.siMaterials[3].emissiveIntensity = 0;
      this.siMaterials[3].color.set(0x1c2229);
    }
    if (this.silicon) {
      this.silicon.geometry.dispose();
      this.silicon.geometry = geo;
    } else {
      this.silicon = new THREE.Mesh(geo, this.siMaterials);
      this.silicon.castShadow = true;
      this.silicon.receiveShadow = true;
      this.group.add(this.silicon);
    }
    this.silicon.position.set(((d.x0 + d.x1) / 2 - this.cx) * this.s, -((top + d.y1) / 2) * this.s, ((d.z0 + d.z1) / 2) * this.s);
  }

  /** face order: right(+x), left(−x), top(+y), bottom, front(+z), back */
  setFaceCanvas(face: "front" | "top" | "right" | "left", canvas: HTMLCanvasElement) {
    const index = { right: 0, left: 1, top: 2, front: 4 }[face];
    const mat = this.siMaterials[index];
    const old = mat.map;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.stage.renderer.capabilities.getMaxAnisotropy();
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = face === "front" ? THREE.LinearFilter : THREE.LinearFilter;
    mat.map = tex;
    mat.emissiveMap = tex;
    mat.needsUpdate = true;
    if (face === "left") {
      // back face reuses the left texture (rarely visible)
      const back = this.siMaterials[5];
      back.map = tex;
      back.emissiveMap = tex;
      back.needsUpdate = true;
    }
    if (old && old !== tex) old.dispose();
  }

  /* ----------------------------------------------------------------- annotations -- */

  /**
   * Engineering-drawing callouts: region/layer names sit in the margins left and right of the
   * cross-section with leader lines to an anchor dot on the cut face; terminals sit on their metal.
   */
  setLabels(def: DeviceDefinition, show: boolean, finished: boolean) {
    this.clearGroup(this.labels);
    if (!show) return;
    const d = def.domain;
    const width = d.x1 - d.x0;
    const zc = 0.012;
    const items = def.labels.filter((l) => finished || l.kind === "region");
    const callouts = items.filter((l) => l.kind !== "terminal");
    const sides: Record<"left" | "right", typeof callouts> = { left: [], right: [] };
    callouts.forEach((l) => sides[l.x < (d.x0 + d.x1) / 2 ? "left" : "right"].push(l));
    const minGap = (d.y1 - d.y0 + 1.2) * 0.075;
    const pts: THREE.Vector3[] = [];
    (["left", "right"] as const).forEach((side) => {
      const list = [...sides[side]].sort((a, b) => a.y - b.y);
      const ys: number[] = [];
      list.forEach((l, i) => ys.push(i === 0 ? l.y : Math.max(l.y, ys[i - 1] + minGap)));
      const xl = side === "left" ? d.x0 - width * 0.05 : d.x1 + width * 0.05;
      list.forEach((l, i) => {
        const anchor = this.toScene(l.x, l.y, (l.z ?? 0) + zc);
        const elbow = this.toScene(side === "left" ? d.x0 : d.x1, ys[i], zc);
        const end = this.toScene(xl, ys[i], zc);
        pts.push(anchor, elbow, elbow, end);
        const el = document.createElement("div");
        el.className = `tag tag-${l.kind ?? "region"}`;
        el.textContent = l.text;
        const obj = new CSS2DObject(el);
        obj.position.copy(end);
        obj.center.set(side === "left" ? 1.02 : -0.02, 0.5);
        this.labels.add(obj);
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
        dot.position.copy(anchor);
        dot.renderOrder = 12;
        this.labels.add(dot);
      });
    });
    if (pts.length) {
      const lines = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0xdfe8f0, transparent: true, opacity: 0.55, depthTest: false })
      );
      lines.renderOrder = 12;
      this.labels.add(lines);
    }
    items
      .filter((l) => l.kind === "terminal")
      .forEach((l) => {
        const el = document.createElement("div");
        el.className = "tag tag-terminal";
        el.textContent = l.text;
        const obj = new CSS2DObject(el);
        obj.position.copy(this.toScene(l.x, l.y, (l.z ?? 0) + zc));
        this.labels.add(obj);
      });
  }

  setDimensions(dims: DimSpec[]) {
    this.clearGroup(this.dims);
    dims.forEach((d) => this.addDimension(d));
  }

  private addDimension(d: DimSpec) {
    const off = (d.offset ?? 0.15) * (d.side === "left" || d.side === "top" ? -1 : 1);
    const vertical = Math.abs(d.a[0] - d.b[0]) < 1e-9;
    const a = vertical ? [d.a[0] + off, d.a[1]] : [d.a[0], d.a[1] + off];
    const b = vertical ? [d.b[0] + off, d.b[1]] : [d.b[0], d.b[1] + off];
    const z = 0.02;
    const pts: THREE.Vector3[] = [this.toScene(a[0], a[1], z), this.toScene(b[0], b[1], z)];
    const tick = 0.05;
    const add = (p: number[]) => {
      if (vertical) pts.push(this.toScene(p[0] - tick, p[1], z), this.toScene(p[0] + tick, p[1], z));
      else pts.push(this.toScene(p[0], p[1] - tick, z), this.toScene(p[0], p[1] + tick, z));
    };
    add(a);
    add(b);
    // extension lines back to the measured points
    pts.push(this.toScene(d.a[0], d.a[1], z), this.toScene(a[0], a[1], z));
    pts.push(this.toScene(d.b[0], d.b[1], z), this.toScene(b[0], b[1], z));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xffe28a, transparent: true, opacity: 0.95, depthTest: false }));
    line.renderOrder = 10;
    this.dims.add(line);
    const el = document.createElement("div");
    el.className = "tag tag-dim";
    el.textContent = d.text;
    const obj = new CSS2DObject(el);
    obj.position.copy(this.toScene((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z));
    obj.center.set(vertical ? (off >= 0 ? -0.08 : 1.08) : 0.5, vertical ? 0.5 : off >= 0 ? -0.2 : 1.2);
    this.dims.add(obj);
  }

  setCutline(c: CutlineDef | null, top: number) {
    this.clearGroup(this.cutline);
    if (!c) return;
    const z = 0.015;
    const from = Math.max(c.from, top);
    const a = c.orientation === "vertical" ? this.toScene(c.at, from, z) : this.toScene(c.from, c.at, z);
    const b = c.orientation === "vertical" ? this.toScene(c.at, c.to, z) : this.toScene(c.to, c.at, z);
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x6ff0ff, dashSize: 0.12, gapSize: 0.08, depthTest: false }));
    line.computeLineDistances();
    line.renderOrder = 11;
    this.cutline.add(line);
    const names = c.name.match(/([A-Z])–([A-Z]′)/);
    [
      [a, names ? names[1] : "A"],
      [b, names ? names[2] : "A′"]
    ].forEach(([p, text]) => {
      const el = document.createElement("div");
      el.className = "tag tag-cut";
      el.textContent = text as string;
      const obj = new CSS2DObject(el);
      obj.position.copy(p as THREE.Vector3);
      this.cutline.add(obj);
    });
  }

  private clearGroup(g: THREE.Group) {
    [...g.children].forEach((o) => {
      g.remove(o);
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose?.();
      if (o instanceof CSS2DObject) o.element.remove();
    });
  }

  dispose() {
    this.disposeTick();
    this.layers.forEach((l) => this.disposeLayer(l));
    this.layers.clear();
    [this.labels, this.dims, this.cutline, this.overlay].forEach((g) => this.clearGroup(g));
    if (this.silicon) {
      this.silicon.geometry.dispose();
      this.siMaterials.forEach((m) => {
        m.map?.dispose();
        m.dispose();
      });
    }
    this.stage.root.remove(this.group);
  }
}
