import { box, dealGrove, depthProfile, findJunctions, formatConc, sheetResistance, type Prism, type ProcessState, type Rect, type Species } from "../physics/process";
import { rect, slabWithHoles, type DeviceDefinition } from "./types";

/**
 * Planar MOSFET in a 0.5 μm-generation CMOS flow:
 * STI → well → V_T adjust → gate oxide → poly gate → LDD → spacer → S/D → anneal → salicide → contacts → metal 1.
 */
const D = { x0: 0, x1: 3.2, y0: 0, y1: 1.5, z0: -2.6, z1: 0 };
const AREA: Rect = rect(D.x0, D.x1, D.z0, 2.6);
const ACTIVE = rect(0.35, 2.85, -2.0, 2.0);
const STI_DEPTH = 0.35;
const GATE = rect(1.35, 1.85, -2.4, 2.4);
const SPACER = 0.12;
const POLY_H = 0.2;
const LDD_OPEN = [rect(ACTIVE.x0, GATE.x0, ACTIVE.z0, ACTIVE.z1), rect(GATE.x1, ACTIVE.x1, ACTIVE.z0, ACTIVE.z1)];
const SD_OPEN = [rect(ACTIVE.x0, GATE.x0 - SPACER, ACTIVE.z0, ACTIVE.z1), rect(GATE.x1 + SPACER, ACTIVE.x1, ACTIVE.z0, ACTIVE.z1)];
const HOLES = [rect(0.6, 0.95, -0.25, 0.25), rect(0.6, 0.95, -1.5, -1.0), rect(2.25, 2.6, -0.25, 0.25), rect(2.25, 2.6, -1.5, -1.0)];
const GATE_HOLE = rect(1.45, 1.75, -2.35, -2.1);
const ILD_TOP = -0.9;

interface Flavor {
  sub: Species;
  well: Species;
  wellEnergy: number;
  vtSpecies: Species;
  vtEnergy: number;
  vtDose: number;
  ldd: Species;
  lddEnergy: number;
  sd: Species;
  sdEnergy: number;
  sdLabel: string;
  lddLabel: string;
}

const N: Flavor = {
  sub: "B",
  well: "B",
  wellEnergy: 150,
  vtSpecies: "B",
  vtEnergy: 20,
  vtDose: 3.2e12,
  ldd: "P",
  lddEnergy: 30,
  sd: "As",
  sdEnergy: 80,
  sdLabel: "As⁺ 80 keV",
  lddLabel: "P⁺ 30 keV"
};

const P: Flavor = {
  sub: "P",
  well: "P",
  wellEnergy: 300,
  vtSpecies: "P",
  vtEnergy: 50,
  vtDose: 3.2e12,
  ldd: "B",
  lddEnergy: 5,
  sd: "B",
  sdEnergy: 10,
  sdLabel: "BF₂⁺ (等效 B 10 keV)",
  lddLabel: "BF₂⁺ (等效 B 5 keV)"
};

function spacerPrisms(): Prism[] {
  const out: Prism[] = [];
  const steps = 8;
  const left: Array<[number, number]> = [[GATE.x0, 0]];
  const right: Array<[number, number]> = [[GATE.x1, 0]];
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * (Math.PI / 2);
    // quarter-round spacer profile
    left.push([GATE.x0 - SPACER * Math.cos(a), -POLY_H * Math.sin(a) * 0.95]);
    right.push([GATE.x1 + SPACER * Math.cos(a), -POLY_H * Math.sin(a) * 0.95]);
  }
  left.push([GATE.x0, -POLY_H * 0.95]);
  right.push([GATE.x1, -POLY_H * 0.95]);
  right.reverse();
  out.push({ poly: left, z0: GATE.z0, z1: D.z1 });
  out.push({ poly: right, z0: GATE.z0, z1: D.z1 });
  return out;
}

function report(s: ProcessState, f: Flavor, final: boolean) {
  const ch = depthProfile(s, 1.6, 0, 0, D.y1, 800);
  let surf = 0;
  for (let i = 0; i < ch.y.length; i += 1) {
    if (ch.y[i] < 0.08) surf = Math.max(surf, Math.abs(ch.nd[i] - ch.na[i]));
  }
  s.results.push(["沟道表面浓度", `${formatConc(surf)} cm⁻³`]);
  if (final) {
    const sd = depthProfile(s, 0.8, 0, 0, D.y1, 800);
    const j = findJunctions(sd);
    if (j.length) {
      s.results.push(["源漏结深 x_j", `${(j[0] * 1000).toFixed(0)} nm`]);
      s.results.push(["源漏 R_□", `${sheetResistance(sd, 0, j[0]).toFixed(1)} Ω/□`]);
    }
    // lateral junction under the gate at 10 nm depth
    const ys = 0.01;
    let xL = GATE.x0;
    let xR = GATE.x1;
    const sign = f.sd === "B" ? -1 : 1;
    for (let x = GATE.x0 - 0.3; x < 1.6; x += 0.001) {
      if (sign * s.net(x, ys, 0) < 0) {
        xL = x;
        break;
      }
    }
    for (let x = GATE.x1 + 0.3; x > 1.6; x -= 0.001) {
      if (sign * s.net(x, ys, 0) < 0) {
        xR = x;
        break;
      }
    }
    s.params.leff = xR - xL;
    s.params.xs = xL;
    s.params.xd = xR;
    s.results.push(["有效沟道长度 L_eff", `${(s.params.leff * 1000).toFixed(0)} nm`]);
  }
}

function makeMos(polarity: 1 | -1): DeviceDefinition {
  const f = polarity === 1 ? N : P;
  const n = polarity === 1;
  const t = (a: string, b: string) => (n ? a : b);
  const gateMaterial = n ? "poly" : "polyP";
  return {
    key: n ? "nmos" : "pmos",
    name: n ? "N 沟道 MOSFET" : "P 沟道 MOSFET",
    english: n ? "NMOS, L = 0.5 μm, n⁺ poly gate" : "PMOS, L = 0.5 μm, p⁺ poly gate",
    family: "mos",
    polarity,
    domain: D,
    xRefine: [ACTIVE.x0, ACTIVE.x1, GATE.x0, GATE.x1, GATE.x0 - SPACER, GATE.x1 + SPACER],
    geometry: {
      width: ACTIVE.z1 - ACTIVE.z0,
      lGate: GATE.x1 - GATE.x0,
      gateX0: GATE.x0,
      gateX1: GATE.x1,
      cutX: 1.6
    },
    contacts: [
      { terminal: "S", kind: "ohmic", side: "top", x0: HOLES[0].x0, x1: HOLES[0].x1 },
      { terminal: "D", kind: "ohmic", side: "top", x0: HOLES[2].x0, x1: HOLES[2].x1 },
      { terminal: "G", kind: "gate", side: "top", x0: GATE.x0, x1: GATE.x1 },
      { terminal: "B", kind: "ohmic", side: "bottom", x0: D.x0, x1: D.x1 }
    ],
    cutlines: [
      { id: "h", name: "横向 B–B′ (沟道表面 y = 2 nm)", orientation: "horizontal", at: 0.002, from: 0.35, to: 2.85 },
      { id: "v", name: "纵向 A–A′ (栅中心 0–0.3 μm)", orientation: "vertical", at: 1.6, from: 0, to: 0.3 },
      { id: "vs", name: "纵向 C–C′ (漏区)", orientation: "vertical", at: 2.4, from: 0, to: 1.0 }
    ],
    bias: n
      ? [
          { key: "VGS", label: "栅源电压 V_GS", min: -0.5, max: 3.3, step: 0.005, value: 1.8, unit: "V" },
          { key: "VDS", label: "漏源电压 V_DS", min: 0, max: 3.3, step: 0.005, value: 1.5, unit: "V" },
          { key: "VBS", label: "衬源电压 V_BS", min: -2, max: 0, step: 0.01, value: 0, unit: "V" }
        ]
      : [
          { key: "VSG", label: "源栅电压 V_SG", min: -0.5, max: 3.3, step: 0.005, value: 1.8, unit: "V" },
          { key: "VSD", label: "源漏电压 V_SD", min: 0, max: 3.3, step: 0.005, value: 1.5, unit: "V" },
          { key: "VSB", label: "源衬电压 V_SB", min: -2, max: 0, step: 0.01, value: 0, unit: "V" }
        ],
    labels: [
      { text: t("n⁺ 源区", "p⁺ 源区"), x: 0.75, y: 0.06, kind: "region" },
      { text: t("n⁺ 漏区", "p⁺ 漏区"), x: 2.45, y: 0.06, kind: "region" },
      { text: t("p 阱", "n 阱"), x: 1.6, y: 0.55, kind: "region" },
      { text: "沟道", x: 1.6, y: 0.01, kind: "region" },
      { text: "STI", x: 0.17, y: 0.15, kind: "layer" },
      { text: t("n⁺ 多晶硅栅", "p⁺ 多晶硅栅"), x: 1.6, y: -0.12, kind: "layer" },
      { text: "S", x: 0.78, y: -1.6, kind: "terminal" },
      { text: "D", x: 2.42, y: -1.6, kind: "terminal" },
      { text: "G", x: 1.6, y: -1.6, z: -2.2, kind: "terminal" }
    ],
    recipe: [
      {
        id: "sub",
        category: "substrate",
        title: "衬底准备",
        equipment: "CZ 硅片",
        params: [
          ["晶向", "<100>"],
          ["掺杂", t("B, 1×10¹⁵ cm⁻³", "P, 1×10¹⁵ cm⁻³")]
        ],
        description: "<100> 晶向的 Si/SiO₂ 界面态密度最低，是 MOS 工艺的标准选择。",
        apply: (s) => {
          s.setSubstrate(f.sub, 1e15, 0);
          s.anim = { kind: "none" };
        }
      },
      {
        id: "pad",
        category: "deposition",
        title: "垫氧 + 氮化硅",
        equipment: "氧化炉 + LPCVD",
        params: [
          ["垫氧", "干氧 10 nm"],
          ["Si₃N₄", "LPCVD 120 nm"]
        ],
        description: "氮化硅作为 STI 刻蚀硬掩模和 CMP 停止层，垫氧缓解氮化硅与硅之间的应力。",
        apply: (s) => {
          s.addLayer({ id: "padox", name: "垫氧", material: "thermalOxide", prisms: slabWithHoles(-0.01, 0, AREA, []) });
          s.addLayer({ id: "nitride", name: "Si₃N₄", material: "nitride", prisms: slabWithHoles(-0.13, -0.01, AREA, []) });
          s.anneal(900, 15);
          s.anim = { kind: "deposit" };
        }
      },
      {
        id: "stilitho",
        category: "litho",
        title: "光刻 #1：有源区",
        equipment: "DUV 248 nm 扫描光刻机",
        params: [
          ["光刻胶", "DUV 正胶 0.8 μm"],
          ["图形", "有源区 2.5 × 4.0 μm"]
        ],
        description: "光刻胶保护有源区，场区将被刻出浅槽。",
        apply: (s) => {
          s.addLayer({ id: "pr", name: "光刻胶", material: "resist", prisms: [box(ACTIVE.x0, ACTIVE.x1, -0.93, -0.13, ACTIVE.z0, D.z1)] });
          s.anim = { kind: "litho", openings: [], resistId: "pr" };
        }
      },
      {
        id: "stietch",
        category: "etch",
        title: "浅槽刻蚀",
        equipment: "ICP 等离子刻蚀 (Cl₂/HBr)",
        params: [
          ["深度", `${STI_DEPTH} μm`],
          ["侧壁角", "≈ 85°"]
        ],
        description: "依次刻穿氮化硅、垫氧并刻入硅中形成浅槽。",
        apply: (s) => {
          s.addLayer({ id: "padox", name: "垫氧", material: "thermalOxide", prisms: [box(ACTIVE.x0, ACTIVE.x1, -0.01, 0, ACTIVE.z0, D.z1)] });
          s.addLayer({ id: "nitride", name: "Si₃N₄", material: "nitride", prisms: [box(ACTIVE.x0, ACTIVE.x1, -0.13, -0.01, ACTIVE.z0, D.z1)] });
          s.addTrench({ fill: "void", x0: D.x0, x1: ACTIVE.x0, y0: 0, y1: STI_DEPTH, z0: -10, z1: 10 });
          s.addTrench({ fill: "void", x0: ACTIVE.x1, x1: D.x1, y0: 0, y1: STI_DEPTH, z0: -10, z1: 10 });
          s.addTrench({ fill: "void", x0: ACTIVE.x0, x1: ACTIVE.x1, y0: 0, y1: STI_DEPTH, z0: -10, z1: ACTIVE.z0 });
          s.anim = { kind: "etch" };
        }
      },
      {
        id: "stifill",
        category: "cmp",
        title: "槽填充 + CMP + 去氮化硅",
        equipment: "HDP-CVD + CMP + 热磷酸",
        params: [
          ["填充", "HDP 氧化物"],
          ["CMP 停止层", "Si₃N₄"],
          ["去除", "H₃PO₄ 160 °C"]
        ],
        description: "高密度等离子 CVD 填满浅槽，CMP 抛到氮化硅表面停止，再用热磷酸去除氮化硅和垫氧，得到平坦的有源区。",
        apply: (s) => {
          s.removeLayer("pr");
          s.removeLayer("nitride");
          s.removeLayer("padox");
          s.fillTrenches();
          s.anim = { kind: "cmp" };
        }
      },
      {
        id: "well",
        category: "implant",
        title: t("p 阱注入", "n 阱注入"),
        equipment: "高能注入机",
        params: [
          ["离子", t("B⁺", "P⁺")],
          ["能量", `${f.wellEnergy} keV`],
          ["剂量", "1.5×10¹³ cm⁻²"]
        ],
        description: t("逆向阱 (retrograde well)：峰值在体内，既抑制源漏穿通和闩锁，又不抬高表面浓度。", "n 阱承载 PMOS。逆向分布抑制穿通与闩锁。"),
        apply: (s) => s.implant(f.well, f.wellEnergy, 1.5e13, [AREA])
      },
      {
        id: "welldrive",
        category: "anneal",
        title: "阱推进",
        equipment: "扩散炉",
        params: [["温度 / 时间", "1000 °C / 60 min"]],
        description: "激活阱注入并修复损伤。",
        apply: (s) => s.anneal(1000, 60)
      },
      {
        id: "vt",
        category: "implant",
        title: "阈值电压调整注入",
        equipment: "中束流注入机",
        params: [
          ["离子", t("B⁺", "P⁺")],
          ["能量", `${f.vtEnergy} keV`],
          ["剂量", "3.2×10¹² cm⁻²"]
        ],
        description: "浅层注入调节沟道表面浓度 N_A，从而设定阈值电压 V_T = V_FB + 2φ_F + √(2qε_Si N_A·2φ_F)/C_ox。",
        apply: (s) => s.implant(f.vtSpecies, f.vtEnergy, f.vtDose, [ACTIVE])
      },
      {
        id: "gox",
        category: "oxidation",
        title: "栅氧化",
        equipment: "立式炉 干氧 + HCl",
        params: [
          ["温度 / 时间", "850 °C / 40 min"],
          ["模型", "Deal–Grove + Massoud 薄氧修正"]
        ],
        description: "生长高质量的薄栅氧。栅氧厚度决定栅电容 C_ox = ε_ox/t_ox，是 MOSFET 最关键的工艺参数之一。",
        apply: (s) => {
          const tox = dealGrove("dry", 850, 40, 0.001);
          s.params.tox = tox;
          s.anneal(850, 40);
          s.addLayer({ id: "gox", name: "栅氧", material: "thermalOxide", prisms: [box(ACTIVE.x0, ACTIVE.x1, -tox, 0, ACTIVE.z0, D.z1)] });
          s.results.push(["栅氧厚度 t_ox", `${(tox * 1000).toFixed(1)} nm`]);
          s.results.push(["C_ox", `${((3.9 * 8.854e-14) / (tox * 1e-4) * 1e7).toFixed(2)} fF/μm²`]);
          report(s, f, false);
          s.anim = { kind: "grow" };
        }
      },
      {
        id: "poly",
        category: "deposition",
        title: "多晶硅淀积",
        equipment: "LPCVD (SiH₄, 620 °C)",
        params: [["厚度", `${POLY_H * 1000} nm`]],
        description: "淀积多晶硅作为栅电极材料，稍后由源漏注入重掺杂。",
        apply: (s) => {
          const tox = s.params.tox;
          s.addLayer({ id: "poly", name: "多晶硅", material: gateMaterial, prisms: slabWithHoles(-tox - POLY_H, -tox, AREA, []) });
          s.anim = { kind: "deposit" };
        }
      },
      {
        id: "gate",
        category: "etch",
        title: "光刻 #2 + 栅刻蚀",
        equipment: "DUV 光刻 + HBr/Cl₂ RIE",
        params: [
          ["栅长 L", `${((GATE.x1 - GATE.x0) * 1000).toFixed(0)} nm`],
          ["停止层", "栅氧 (高选择比)"]
        ],
        description: "定义栅极图形。栅长是最小线宽，决定沟道长度与器件速度，也是工艺代的命名依据。",
        apply: (s) => {
          const tox = s.params.tox;
          s.addLayer({ id: "poly", name: "多晶硅", material: gateMaterial, prisms: [box(GATE.x0, GATE.x1, -tox - POLY_H, -tox, GATE.z0, D.z1)] });
          s.addLayer({ id: "gox", name: "栅氧", material: "thermalOxide", prisms: [box(GATE.x0, GATE.x1, -tox, 0, ACTIVE.z0, D.z1)] });
          s.anim = { kind: "etch" };
        }
      },
      {
        id: "ldd",
        category: "implant",
        title: "LDD 注入",
        equipment: "中束流注入机",
        params: [
          ["离子", f.lddLabel],
          ["剂量", "2×10¹³ cm⁻²"],
          ["自对准", "多晶硅栅"]
        ],
        description: "轻掺杂漏 (LDD) 以栅为掩模自对准注入，降低漏端峰值电场、抑制热载流子效应。",
        apply: (s) => s.implant(f.ldd, f.lddEnergy, 2e13, LDD_OPEN)
      },
      {
        id: "spacer",
        category: "deposition",
        title: "侧墙形成",
        equipment: "LPCVD TEOS + 各向异性回刻",
        params: [
          ["淀积", "TEOS 150 nm"],
          ["侧墙宽度", `${SPACER * 1000} nm`]
        ],
        description: "保形淀积氧化物后各向异性回刻，只在栅侧壁留下侧墙，用来把后续重掺杂源漏注入与沟道隔开。",
        apply: (s) => {
          s.addLayer({ id: "spacer", name: "侧墙", material: "oxide", prisms: spacerPrisms() });
          s.anim = { kind: "deposit" };
        }
      },
      {
        id: "sd",
        category: "implant",
        title: "源漏注入",
        equipment: "大束流注入机",
        params: [
          ["离子", f.sdLabel],
          ["剂量", "4×10¹⁵ cm⁻²"],
          ["自对准", "栅 + 侧墙"]
        ],
        description: "重掺杂源漏以栅和侧墙为掩模自对准注入，同时掺杂多晶硅栅。",
        apply: (s) => s.implant(f.sd, f.sdEnergy, 4e15, SD_OPEN)
      },
      {
        id: "anneal",
        category: "anneal",
        title: "源漏激活退火",
        equipment: "扩散炉",
        params: [["温度 / 时间", "950 °C / 30 min"]],
        description: "激活源漏杂质。热预算决定源漏结深以及 LDD 在栅下的横向扩散，从而决定有效沟道长度 L_eff。",
        apply: (s) => {
          s.anneal(950, 30);
          report(s, f, true);
        }
      },
      {
        id: "salicide",
        category: "metal",
        title: "自对准硅化物",
        equipment: "Ti 溅射 + 两步 RTA",
        params: [
          ["金属", "Ti 30 nm → TiSi₂ (C54)"],
          ["方块电阻", "≈ 3 Ω/□"]
        ],
        description: "钛只在裸露的硅和多晶硅表面反应生成硅化物，侧墙和 STI 上的钛被选择性去除，从而降低源漏和栅的串联电阻。",
        apply: (s) => {
          const tox = s.params.tox;
          const sil: Prism[] = SD_OPEN.map((o) => box(o.x0, o.x1, -0.03, 0, ACTIVE.z0, D.z1));
          sil.push(box(GATE.x0, GATE.x1, -tox - POLY_H - 0.03, -tox - POLY_H, GATE.z0, D.z1));
          s.addLayer({ id: "silicide", name: "TiSi₂", material: "silicide", prisms: sil });
          s.anim = { kind: "deposit" };
        }
      },
      {
        id: "ild",
        category: "deposition",
        title: "层间介质 + CMP",
        equipment: "SACVD BPSG + CMP",
        params: [["厚度", "0.9 μm (CMP 后)"]],
        description: "淀积层间介质并用 CMP 平坦化。",
        apply: (s) => {
          s.addLayer({ id: "ild", name: "BPSG", material: "bpsg", prisms: slabWithHoles(ILD_TOP, 0, AREA, []) });
          s.anim = { kind: "deposit" };
        }
      },
      {
        id: "contact",
        category: "metal",
        title: "接触孔 + 钨塞",
        equipment: "RIE + CVD-W + CMP",
        params: [
          ["孔径", "0.35 μm"],
          ["阻挡层", "Ti/TiN"]
        ],
        description: "刻开接触孔并用钨填充，连接源、漏和栅。",
        apply: (s) => {
          const tox = s.params.tox;
          s.addLayer({ id: "ild", name: "BPSG", material: "bpsg", prisms: slabWithHoles(ILD_TOP, 0, AREA, [...HOLES, GATE_HOLE]) });
          const plugs = HOLES.map((h) => box(h.x0, h.x1, ILD_TOP, -0.03, h.z0, h.z1));
          plugs.push(box(GATE_HOLE.x0, GATE_HOLE.x1, ILD_TOP, -tox - POLY_H - 0.03, GATE_HOLE.z0, GATE_HOLE.z1));
          s.addLayer({ id: "plug", name: "W 塞", material: "tungsten", prisms: plugs });
          s.anim = { kind: "deposit" };
        }
      },
      {
        id: "metal1",
        category: "metal",
        title: "金属 1",
        equipment: "溅射 + 光刻 + RIE",
        params: [
          ["材料", "Ti/Al-Cu/TiN"],
          ["厚度", "0.45 μm"]
        ],
        description: "第一层互连：源、漏、栅分别引出。",
        apply: (s) => {
          s.addLayer({
            id: "m1",
            name: "金属 1",
            material: "aluminum",
            prisms: [
              box(0.45, 1.1, ILD_TOP - 0.45, ILD_TOP, -1.8, 0),
              box(2.1, 2.75, ILD_TOP - 0.45, ILD_TOP, -1.8, 0),
              box(1.3, 1.9, ILD_TOP - 0.45, ILD_TOP, -2.6, -1.95)
            ]
          });
          s.anim = { kind: "deposit" };
        }
      }
    ]
  };
}

export const nmos = makeMos(1);
export const pmos = makeMos(-1);
