import { box, dealGrove, depthProfile, findJunctions, formatConc, sheetResistance, type ProcessState } from "../physics/process";
import { rect, slabWithHoles, type DeviceDefinition } from "./types";

/**
 * Planar p⁺n power/signal diode: p⁺ boron diffusion into an n-epitaxial drift layer on an n⁺ substrate.
 * The anode metal overlaps the field oxide (field plate) to relieve the junction-curvature field.
 */
const D = { x0: 0, x1: 8, y0: 0, y1: 4, z0: -3, z1: 0 };
const AREA = rect(D.x0, D.x1, D.z0, 3);
const WINDOW = rect(2, 6, -2, 2);
const EPI = 3.0;

function foxThickness(s: ProcessState) {
  return s.params.tfox ?? 0.5;
}

function reportJunction(s: ProcessState) {
  const prof = depthProfile(s, 4, 0, 0, D.y1, 800);
  const j = findJunctions(prof);
  if (j.length) {
    s.results.push(["结深 x_j", `${j[0].toFixed(3)} μm`]);
    s.results.push(["P⁺ 方块电阻 R_□", `${sheetResistance(prof, 0, j[0]).toFixed(1)} Ω/□`]);
    let peak = 0;
    for (let i = 0; i < prof.y.length; i += 1) peak = Math.max(peak, prof.na[i]);
    s.results.push(["表面浓度 N_s", `${formatConc(peak)} cm⁻³`]);
  }
}

export const diode: DeviceDefinition = {
  key: "diode",
  name: "PN 结二极管",
  english: "Planar p⁺n junction diode",
  family: "diode",
  polarity: 1,
  domain: D,
  xRefine: [2, 6],
  geometry: { area: (WINDOW.x1 - WINDOW.x0) * (WINDOW.z1 - WINDOW.z0), perimeter: 2 * (4 + 4), epi: EPI },
  contacts: [
    { terminal: "A", kind: "ohmic", side: "top", x0: 2.05, x1: 5.95 },
    { terminal: "K", kind: "ohmic", side: "bottom", x0: D.x0, x1: D.x1 }
  ],
  cutlines: [
    { id: "v", name: "纵向 A–A′ (窗口中心)", orientation: "vertical", at: 4, from: 0, to: 4 },
    { id: "h", name: "横向 B–B′ (y = 0.2 μm)", orientation: "horizontal", at: 0.2, from: 0, to: 8 }
  ],
  bias: [{ key: "VA", label: "阳极电压 V_AK", min: -36, max: 0.95, step: 0.005, value: 0.6, unit: "V" }],
  labels: [
    { text: "p⁺ 阳极扩散区", x: 4, y: 0.25, kind: "region" },
    { text: "n⁻ 外延漂移区", x: 1.1, y: 1.6, kind: "region" },
    { text: "n⁺ 衬底", x: 4, y: 3.6, kind: "region" },
    { text: "场氧 SiO₂", x: 0.9, y: -0.3, kind: "layer" },
    { text: "Al 阳极 / 场板", x: 5.9, y: -1.2, kind: "layer" },
    { text: "背面金属 (阴极)", x: 6.8, y: 4.15, kind: "layer" }
  ],
  recipe: [
    {
      id: "sub",
      category: "substrate",
      title: "衬底准备",
      equipment: "Czochralski 单晶硅片",
      params: [
        ["晶向", "<100>"],
        ["掺杂", "Sb, 5×10¹⁸ cm⁻³"],
        ["电阻率", "≈ 0.01 Ω·cm"]
      ],
      description: "重掺杂 n⁺ 衬底提供低阻的阴极通路，并作为外延生长的籽晶。RCA 清洗去除有机物、金属离子和自然氧化层。",
      apply: (s) => {
        s.setSubstrate("Sb", 5e18, EPI);
        s.anim = { kind: "none" };
      }
    },
    {
      id: "epi",
      category: "epi",
      title: "n 型外延生长",
      equipment: "常压外延炉 (SiHCl₃ + PH₃)",
      params: [
        ["厚度", `${EPI.toFixed(1)} μm`],
        ["掺杂", "P, 2×10¹⁶ cm⁻³"],
        ["温度 / 时间", "1120 °C / 10 min"]
      ],
      description: "轻掺杂外延层是二极管的耐压漂移区：它的浓度决定反向击穿电压，厚度决定正向串联电阻。高温生长期间衬底中的锑会向外延层反扩散。",
      apply: (s) => s.growEpi("P", 2e16, EPI, 1120, 10)
    },
    {
      id: "fox",
      category: "oxidation",
      title: "场氧化",
      equipment: "卧式氧化炉 (H₂/O₂ 湿氧)",
      params: [
        ["气氛", "湿氧 H₂O"],
        ["温度 / 时间", "1000 °C / 70 min"],
        ["模型", "Deal–Grove"]
      ],
      description: "热生长的二氧化硅作为后续硼注入的掩蔽层和器件表面钝化层。湿氧的抛物线速率常数比干氧大一个数量级，适合生长厚氧化层。",
      apply: (s) => {
        const t = dealGrove("wet", 1000, 70);
        s.params.tfox = t;
        s.anneal(1000, 70);
        s.addLayer({ id: "fox", name: "场氧", material: "thermalOxide", prisms: slabWithHoles(-t, 0, AREA, []) });
        s.results.push(["场氧厚度 t_ox", `${(t * 1000).toFixed(0)} nm`]);
        s.anim = { kind: "grow" };
      }
    },
    {
      id: "litho1",
      category: "litho",
      title: "光刻 #1：P⁺ 窗口",
      equipment: "i-line 步进光刻机 (365 nm)",
      params: [
        ["光刻胶", "正胶 1.2 μm"],
        ["曝光剂量", "150 mJ/cm²"],
        ["窗口", "4 μm × 4 μm"]
      ],
      description: "涂胶、前烘、对准曝光、显影。掩模版上透光区域对应 P⁺ 扩散窗口，显影后光刻胶在窗口处被去除。",
      apply: (s) => {
        const t = foxThickness(s);
        s.addLayer({ id: "pr1", name: "光刻胶", material: "resist", prisms: slabWithHoles(-t - 1.2, -t, AREA, [WINDOW]) });
        s.anim = { kind: "litho", openings: [WINDOW], resistId: "pr1" };
      }
    },
    {
      id: "etch1",
      category: "etch",
      title: "氧化层湿法刻蚀",
      equipment: "BOE 缓冲氢氟酸槽",
      params: [
        ["刻蚀液", "NH₄F : HF = 6 : 1"],
        ["速率", "≈ 100 nm/min"],
        ["过刻", "20 %"]
      ],
      description: "以光刻胶为掩蔽，腐蚀掉窗口内的场氧化层，露出硅表面。湿法刻蚀各向同性，会产生轻微侧向钻蚀。",
      apply: (s) => {
        const t = foxThickness(s);
        s.addLayer({ id: "fox", name: "场氧", material: "thermalOxide", prisms: slabWithHoles(-t, 0, AREA, [WINDOW]) });
        s.anim = { kind: "etch" };
      }
    },
    {
      id: "strip1",
      category: "strip",
      title: "去胶清洗",
      equipment: "O₂ 等离子去胶 + SPM",
      params: [
        ["去胶", "O₂ plasma"],
        ["清洗", "H₂SO₄ : H₂O₂"]
      ],
      description: "去除光刻胶。之后窗口外由场氧化层掩蔽注入。",
      apply: (s) => {
        s.removeLayer("pr1");
        s.anim = { kind: "none" };
      }
    },
    {
      id: "imp",
      category: "implant",
      title: "硼离子注入",
      equipment: "中束流离子注入机",
      params: [
        ["离子", "B⁺"],
        ["能量", "40 keV"],
        ["剂量", "5×10¹⁵ cm⁻²"],
        ["倾角", "7°"]
      ],
      description: "B⁺ 离子加速后射入窗口内的硅中，服从高斯分布 (投影射程 R_p ≈ 0.13 μm)。场氧化层足够厚，窗口外的离子被完全阻挡。7° 倾角可避免沟道效应。",
      apply: (s) => s.implant("B", 40, 5e15, [WINDOW], { tilt: 7 })
    },
    {
      id: "drive",
      category: "anneal",
      title: "推进退火",
      equipment: "扩散炉 (N₂ / 少量 O₂)",
      params: [
        ["温度", "1050 °C"],
        ["时间", "45 min"],
        ["作用", "激活 + 推进结深"]
      ],
      description: "高温下硼原子向深处和侧向扩散，高斯分布展宽 σ² = ΔR_p² + 2Dt，同时修复注入损伤并使杂质占据替位激活。侧向扩散使结在窗口边缘弯曲，这是平面结击穿电压低于平行平面结的原因。",
      apply: (s) => {
        s.anneal(1050, 45);
        reportJunction(s);
      }
    },
    {
      id: "metal",
      category: "metal",
      title: "金属淀积",
      equipment: "磁控溅射台",
      params: [
        ["材料", "Al-1%Si"],
        ["厚度", "1.0 μm"],
        ["基底温度", "250 °C"]
      ],
      description: "溅射铝合金形成阳极欧姆接触。加入 1% 硅可抑制铝向浅结中的尖峰穿透 (spiking)。",
      apply: (s) => {
        const t = foxThickness(s);
        s.addLayer({
          id: "metal",
          name: "Al",
          material: "aluminum",
          prisms: [...slabWithHoles(-t - 1.0, -t, AREA, [WINDOW]), box(WINDOW.x0, WINDOW.x1, -1.0, 0, WINDOW.z0, D.z1)]
        });
        s.anim = { kind: "deposit" };
      }
    },
    {
      id: "metalEtch",
      category: "etch",
      title: "光刻 #2 + 金属刻蚀",
      equipment: "步进光刻 + Cl₂/BCl₃ 等离子刻蚀",
      params: [
        ["图形", "阳极焊盘 + 场板"],
        ["场板外伸", "0.6 μm"],
        ["刻蚀", "各向异性 RIE"]
      ],
      description: "图形化金属：阳极金属越过窗口边缘覆盖在场氧化层上，形成场板 (field plate)，在反偏时把电场从弯曲的结边缘推开。",
      apply: (s) => {
        const t = foxThickness(s);
        const pad = rect(1.4, 6.6, -2.6, 2.6);
        s.addLayer({
          id: "metal",
          name: "Al",
          material: "aluminum",
          prisms: [...slabWithHoles(-t - 1.0, -t, pad, [WINDOW]), box(WINDOW.x0, WINDOW.x1, -1.0, 0, WINDOW.z0, D.z1)]
        });
        s.anim = { kind: "etch" };
      }
    },
    {
      id: "pass",
      category: "deposition",
      title: "钝化层",
      equipment: "PECVD",
      params: [
        ["材料", "Si₃N₄"],
        ["厚度", "0.6 μm"],
        ["开孔", "焊盘窗口"]
      ],
      description: "氮化硅钝化层隔绝水汽和可动离子，只在焊盘处开孔用于键合。",
      apply: (s) => {
        const t = foxThickness(s);
        const top = -t - 1.0;
        s.addLayer({
          id: "pass",
          name: "钝化",
          material: "passivation",
          prisms: slabWithHoles(top - 0.6, top, AREA, [rect(2.6, 5.4, -1.4, 1.4)])
        });
        s.anim = { kind: "deposit" };
      }
    },
    {
      id: "back",
      category: "metal",
      title: "背面减薄与背金",
      equipment: "研磨 + 电子束蒸发",
      params: [
        ["叠层", "Ti / Ni / Ag"],
        ["厚度", "0.1 / 0.2 / 0.5 μm"]
      ],
      description: "背面金属作为阴极，与 n⁺ 衬底形成欧姆接触。",
      apply: (s) => {
        s.addLayer({ id: "back", name: "背金", material: "backMetal", prisms: [box(D.x0, D.x1, D.y1, D.y1 + 0.3, D.z0, D.z1)] });
        s.anim = { kind: "deposit" };
      }
    },
    {
      id: "alloy",
      category: "anneal",
      title: "合金化",
      equipment: "合金炉 (N₂/H₂ forming gas)",
      params: [
        ["温度 / 时间", "450 °C / 30 min"],
        ["作用", "降低接触电阻，钝化界面态"]
      ],
      description: "低温合金使铝与硅形成良好欧姆接触，氢钝化 Si/SiO₂ 界面悬挂键。该温度下杂质几乎不扩散。",
      apply: (s) => {
        s.anneal(450, 30);
        reportJunction(s);
      }
    }
  ]
};
