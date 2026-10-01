import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export type Tick = (dt: number, t: number) => void;

interface CameraTween {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  t: number;
  dur: number;
}

/** Renderer, camera, lighting, label overlay and the frame loop. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly labels: CSS2DRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly root = new THREE.Group();
  private ticks = new Set<Tick>();
  private clock = new THREE.Clock();
  private tween: CameraTween | null = null;
  private floor: THREE.Mesh;
  private grid: THREE.GridHelper;
  readonly key: THREE.DirectionalLight;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = "label-layer";
    container.appendChild(this.labels.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 200);
    this.camera.position.set(8, 6, 13);
    this.controls = new OrbitControls(this.camera, this.labels.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 40;
    this.controls.maxPolarAngle = Math.PI * 0.92;
    this.controls.addEventListener("start", () => {
      this.tween = null;
    });

    this.scene.add(new THREE.HemisphereLight(0xdfe9f5, 0x1a1f26, 0.9));
    this.key = new THREE.DirectionalLight(0xffffff, 2.2);
    this.key.position.set(6, 12, 9);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    const sc = this.key.shadow.camera;
    sc.left = -9;
    sc.right = 9;
    sc.top = 9;
    sc.bottom = -9;
    sc.near = 1;
    sc.far = 40;
    this.key.shadow.bias = -0.0004;
    this.scene.add(this.key);
    const rim = new THREE.DirectionalLight(0x8fb6ff, 0.8);
    rim.position.set(-8, 4, -6);
    this.scene.add(rim);
    const fill = new THREE.DirectionalLight(0xffe2c4, 0.5);
    fill.position.set(-4, 2, 10);
    this.scene.add(fill);

    this.floor = new THREE.Mesh(new THREE.CircleGeometry(16, 96), new THREE.ShadowMaterial({ opacity: 0.35 }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    this.grid = new THREE.GridHelper(30, 60, 0x33404d, 0x222a33);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.45;
    this.scene.add(this.grid);

    this.scene.add(this.root);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.loop();
  }

  setFloor(y: number) {
    this.floor.position.y = y - 0.002;
    this.grid.position.y = y - 0.004;
  }

  onTick(fn: Tick) {
    this.ticks.add(fn);
    return () => this.ticks.delete(fn);
  }

  resize() {
    const w = Math.max(this.container.clientWidth, 1);
    const h = Math.max(this.container.clientHeight, 1);
    this.renderer.setSize(w, h, false);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  flyTo(pos: THREE.Vector3, target: THREE.Vector3, dur = 0.9) {
    if (dur <= 0.05) {
      this.tween = null;
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      return;
    }
    this.tween = {
      fromPos: this.camera.position.clone(),
      toPos: pos.clone(),
      fromTarget: this.controls.target.clone(),
      toTarget: target.clone(),
      t: 0,
      dur
    };
  }

  private loop = () => {
    requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    if (this.tween) {
      const tw = this.tween;
      tw.t += dt;
      const k = Math.min(tw.t / tw.dur, 1);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
      this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
      if (k >= 1) this.tween = null;
    }
    this.ticks.forEach((fn) => fn(dt, t));
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  };
}
