import * as THREE from "three";
import type { MaterialKey } from "../physics/process";

interface MatSpec {
  color: number;
  opacity: number;
  metalness: number;
  roughness: number;
  transmission?: number;
  clearcoat?: number;
  emissive?: number;
  edge: number;
  edgeOpacity: number;
  label: string;
  group: "dielectric" | "ild" | "metal" | "resist" | "gate";
}

export const MATERIALS: Record<MaterialKey, MatSpec> = {
  thermalOxide: { color: 0x9fd4ec, opacity: 0.34, metalness: 0, roughness: 0.15, clearcoat: 0.6, edge: 0x7fd0f0, edgeOpacity: 0.55, label: "热氧化 SiO₂", group: "dielectric" },
  oxide: { color: 0xa9dcef, opacity: 0.42, metalness: 0, roughness: 0.2, clearcoat: 0.5, edge: 0x8fd6f2, edgeOpacity: 0.55, label: "SiO₂", group: "dielectric" },
  bpsg: { color: 0xb9e3d0, opacity: 0.2, metalness: 0, roughness: 0.2, clearcoat: 0.4, edge: 0x9fe0c4, edgeOpacity: 0.35, label: "BPSG", group: "ild" },
  passivation: { color: 0xd8f0c9, opacity: 0.16, metalness: 0, roughness: 0.25, clearcoat: 0.4, edge: 0xc4ecae, edgeOpacity: 0.3, label: "钝化层", group: "ild" },
  nitride: { color: 0x9ed98a, opacity: 0.62, metalness: 0, roughness: 0.35, edge: 0x6fbf5a, edgeOpacity: 0.6, label: "Si₃N₄", group: "dielectric" },
  poly: { color: 0xd4616e, opacity: 1, metalness: 0.05, roughness: 0.55, edge: 0x3a1117, edgeOpacity: 0.6, label: "n⁺ 多晶硅", group: "gate" },
  polyP: { color: 0xd98c52, opacity: 1, metalness: 0.05, roughness: 0.55, edge: 0x3a2111, edgeOpacity: 0.6, label: "p⁺ 多晶硅", group: "gate" },
  resist: { color: 0xe8a33a, opacity: 0.8, metalness: 0, roughness: 0.3, clearcoat: 0.8, emissive: 0x3a2200, edge: 0x7a4c0c, edgeOpacity: 0.6, label: "光刻胶", group: "resist" },
  resistExposed: { color: 0xb07cf0, opacity: 0.8, metalness: 0, roughness: 0.3, edge: 0x5a3a8a, edgeOpacity: 0.6, label: "曝光区", group: "resist" },
  silicide: { color: 0x6f5f88, opacity: 1, metalness: 0.6, roughness: 0.35, edge: 0x1c1626, edgeOpacity: 0.7, label: "TiSi₂", group: "metal" },
  tungsten: { color: 0x9aa2aa, opacity: 1, metalness: 0.9, roughness: 0.32, edge: 0x2a3036, edgeOpacity: 0.6, label: "钨塞", group: "metal" },
  aluminum: { color: 0xdfe4ea, opacity: 1, metalness: 1, roughness: 0.28, edge: 0x5b6570, edgeOpacity: 0.55, label: "Al", group: "metal" },
  backMetal: { color: 0xd2c28e, opacity: 1, metalness: 1, roughness: 0.3, edge: 0x5b5030, edgeOpacity: 0.55, label: "背金", group: "metal" }
};

export function makeLayerMaterial(key: MaterialKey) {
  const spec = MATERIALS[key];
  const translucent = spec.opacity < 1;
  const mat = new THREE.MeshPhysicalMaterial({
    color: spec.color,
    metalness: spec.metalness,
    roughness: spec.roughness,
    clearcoat: spec.clearcoat ?? 0,
    clearcoatRoughness: 0.2,
    transparent: true,
    opacity: spec.opacity,
    depthWrite: !translucent,
    emissive: spec.emissive ?? 0x000000,
    side: translucent ? THREE.DoubleSide : THREE.FrontSide
  });
  const edge = new THREE.LineBasicMaterial({ color: spec.edge, transparent: true, opacity: spec.edgeOpacity });
  return { mat, edge, baseOpacity: spec.opacity, baseEdgeOpacity: spec.edgeOpacity, translucent };
}
