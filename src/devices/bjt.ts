import { box, dealGrove, depthProfile, findJunctions, formatConc, sheetResistance, type ProcessState, type Rect, type Species } from "../physics/process";
import { rect, slabWithHoles, type DeviceDefinition } from "./types";

/**
 * Vertical bipolar transistor in a standard-buried-collector (SBC) process with deep-trench isolation:
 * buried layer → epitaxy → DTI → LOCOS → collector sinker → base → emitter → base contact → BEOL.
 */
const D0 = { x0: 0, x1: 10, y0: 0, y1: 3.5, z0: -3.5, z1: 0 };
const AREA: Rect = rect(D0.x0, D0.x1, D0.z0, 3.5);

const BL = rect(0.9, 9.1, -3.2, 3.2);
const ACTIVE_BASE = rect(1.1, 5.8, -2.8, 2.8);
const ACTIVE_SINK = rect(7.2, 9.0, -2.8, 2.8);
const SINKER = rect(7.5, 8.7, -2.4, 2.4);
const BASE = rect(1.3, 5.6, -2.5, 2.5);
const EMITTER = rect(3.1, 4.3, -1.8, 1.8);
const CCONTACT = rect(7.6, 8.6, -2.2, 2.2);
const BCONTACT = rect(1.5, 2.5, -2.2, 2.2);
const HOLE_E = rect(3.35, 4.05, -1.4, 1.4);
const HOLE_B = rect(1.7, 2.3, -1.8, 1.8);
const HOLE_C = rect(7.8, 8.4, -1.8, 1.8);

interface Flavor {
  sub: Species;
  subConc: number;
  buried: Species;
  buriedEnergy: number;
  buriedDose: number;
  epi: Species;
  epiConc: number;
  sinker: Species;
  base: Species;
  baseEnergy: number;
  baseDose: number;
  emitter: Species;
  emitterEnergy: number;
  emitterDose: number;
  emitterLabel: string;
  bplus: Species;
  bplusEnergy: number;
  rtaT: number;
  rtaMin: number;
  blT: number;
  blMin: number;
  sinkT: number;
  depth: number;
  epiT: number;
  blDose: number;
}

const NPN: Flavor = {
  sub: "B",
  subConc: 1.5e15,
  buried: "Sb",
  buriedEnergy: 60,
  buriedDose: 3e15,
  epi: "P",
  epiConc: 1e16,
  sinker: "P",
  base: "B",
  baseEnergy: 30,
  baseDose: 2.5e13,
  emitter: "As",
  emitterEnergy: 80,
  emitterDose: 6e15,
  emitterLabel: "As⁺",
  bplus: "B",
  bplusEnergy: 10,
  rtaT: 1000,
  rtaMin: 20,
  blT: 1200,
  blMin: 60,
  sinkT: 1150,
  depth: 3.5,
  epiT: 1.6,
  blDose: 3e15
};

const PNP: Flavor = {
  sub: "P",
  subConc: 1.5e15,
  buried: "B",
  buriedEnergy: 40,
  buriedDose: 3e15,
  epi: "B",
  epiConc: 1e16,
  sinker: "B",
  base: "P",
  baseEnergy: 90,
  baseDose: 2.5e13,
  emitter: "B",
  emitterEnergy: 8,
  emitterDose: 4e15,
  emitterLabel: "BF₂⁺",
  bplus: "As",
  bplusEnergy: 40,
  rtaT: 950,
  rtaMin: 10,
  blT: 1100,
  blMin: 30,
  sinkT: 1100,
  depth: 4.8,
  epiT: 2.2,
  blDose: 1.5e15
};

function locosThickness(s: ProcessState) {
  return s.params.tlocos ?? 0.5;
}

/** Surface height of the wafer (y, negative above silicon) outside the active areas. */
function fieldTop(s: ProcessState) {
  return -0.55 * locosThickness(s);
}

function resistLayer(s: ProcessState, id: string, holes: Rect[]) {
  const top = s.layers.has("locos") ? fieldTop(s) : 0;
  const prisms = slabWithHoles(top - 1.0, top, AREA, holes);
  if (top < 0) {
    prisms.push(...slabWithHoles(top, 0, ACTIVE_BASE, holes), ...slabWithHoles(top, 0, ACTIVE_SINK, holes));
  }
  s.addLayer({ id, name: "光刻胶", material: "resist", prisms });
}

function report(s: ProcessState, f: Flavor) {
  const prof = depthProfile(s, 3.7, 0, 0, f.depth, 1400);
  const j = findJunctions(prof);
  const npn = f.emitter !== "B";
  if (j.length >= 2) {
    s.results.push(["发射结深 x_jE", `${j[0].toFixed(3)} μm`]);
    s.results.push(["集电结深 x_jC", `${j[1].toFixed(3)} μm`]);
    s.results.push(["冶金基区宽度 W_B", `${((j[1] - j[0]) * 1000).toFixed(0)} nm`]);
    s.results.push(["发射区 R_□", `${sheetResistance(prof, 0, j[0]).toFixed(1)} Ω/□`]);
    s.results.push(["本征基区 R_□ (夹断)", `${(sheetResistance(prof, j[0], j[1]) / 1000).toFixed(2)} kΩ/□`]);
    let peak = 0;
    for (let i = 0; i < prof.y.length; i += 1) {
      if (prof.y[i] > j[0] && prof.y[i] < j[1]) peak = Math.max(peak, npn ? prof.na[i] : prof.nd[i]);
    }
    s.results.push(["基区峰值浓度", `${formatConc(peak)} cm⁻³`]);
  } else if (j.length === 1) {
    s.results.push(["结深 x_j", `${j[0].toFixed(3)} μm`]);
  }
}

function makeBjt(polarity: 1 | -1): DeviceDefinition {
  const f = polarity === 1 ? NPN : PNP;
  const npn = polarity === 1;
  const t = (n: string, p: string) => (npn ? n : p);
  const D = { ...D0, y1: f.depth };
  const EPI = f.epiT;
  const trench = f.depth - 0.3;
  return {
    key: npn ? "npn" : "pnp",
    name: npn ? "NPN 双极型晶体管" : "PNP 双极型晶体管",
    english: npn ? "Vertical NPN BJT (SBC + DTI)" : "Vertical PNP BJT (complementary SBC + DTI)",
    family: "bjt",
    polarity,
    domain: D,
    xRefine: [BASE.x0, BASE.x1, EMITTER.x0, EMITTER.x1, BCONTACT.x0, BCONTACT.x1, SINKER.x0, SINKER.x1, 0.6, 9.4],
    geometry: {
      emitterArea: (EMITTER.x1 - EMITTER.x0) * (EMITTER.z1 - EMITTER.z0),
      emitterPerimeter: 2 * (EMITTER.x1 - EMITTER.x0 + EMITTER.z1 - EMITTER.z0),
      baseArea: (BASE.x1 - BASE.x0) * (BASE.z1 - BASE.z0),
      emitterWidth: EMITTER.x1 - EMITTER.x0,
      emitterLength: EMITTER.z1 - EMITTER.z0,
      baseContactGap: EMITTER.x0 - BCONTACT.x1,
      sinkerDistance: SINKER.x0 - EMITTER.x1,
      epi: EPI,
      cutX: 3.7
    },
    contacts: [
      { terminal: "E", kind: "ohmic", side: "top", x0: HOLE_E.x0, x1: HOLE_E.x1 },
      { terminal: "B", kind: "ohmic", side: "top", x0: HOLE_B.x0, x1: HOLE_B.x1 },
      { terminal: "C", kind: "ohmic", side: "top", x0: HOLE_C.x0, x1: HOLE_C.x1 },
      { terminal: "S", kind: "ohmic", side: "bottom", x0: D.x0 + 0.6, x1: D.x1 - 0.6 }
    ],
    cutlines: [
      { id: "v", name: "纵向 A–A′ (本征晶体管 0–0.9 μm)", orientation: "vertical", at: 3.7, from: 0, to: 0.9 },
      { id: "vf", name: "纵向 A–A′ (发射极中心，全深度)", orientation: "vertical", at: 3.7, from: 0, to: f.depth },
      { id: "vb", name: "纵向 C–C′ (集电极 sinker)", orientation: "vertical", at: 8.1, from: 0, to: f.depth },
      { id: "h", name: "横向 B–B′ (y = 0.2 μm)", orientation: "horizontal", at: 0.2, from: 0.6, to: 9.4 }
    ],
    bias: npn
      ? [
          { key: "VBE", label: "基射电压 V_BE", min: 0, max: 0.95, step: 0.002, value: 0.78, unit: "V" },
          { key: "VCE", label: "集射电压 V_CE", min: 0, max: 6, step: 0.01, value: 3, unit: "V" }
        ]
      : [
          { key: "VEB", label: "射基电压 V_EB", min: 0, max: 0.95, step: 0.002, value: 0.78, unit: "V" },
          { key: "VEC", label: "射集电压 V_EC", min: 0, max: 6, step: 0.01, value: 3, unit: "V" }
        ],
    labels: [
      { text: t("n⁺ 发射区", "p⁺ 发射区"), x: 3.7, y: 0.05, kind: "region" },
      { text: t("p 本征基区", "n 本征基区"), x: 4.9, y: 0.22, kind: "region" },
      { text: t("n 外延集电区", "p 外延集电区"), x: 4.8, y: 0.62, kind: "region" },
      { text: t("n⁺ 埋层", "p⁺ 埋层"), x: 5.0, y: f.epiT + 0.2, kind: "region" },
      { text: t("n⁺ sinker", "p⁺ sinker"), x: 8.1, y: 0.8, kind: "region" },
      { text: t("p⁻ 衬底", "n⁻ 衬底"), x: 5, y: f.depth - 0.35, kind: "region" },
      { text: "深槽隔离", x: 0.3, y: 2.4, kind: "layer" },
      { text: "LOCOS", x: 6.5, y: -0.4, kind: "layer" },
      { text: "E", x: 3.7, y: -2.4, kind: "terminal" },
      { text: "B", x: 2.0, y: -2.4, kind: "terminal" },
      { text: "C", x: 8.1, y: -2.4, kind: "terminal" }
    ],
    recipe: [
      {
        id: "sub",
        category: "substrate",
        title: "衬底准备",
        equipment: "CZ 硅片",
        params: [
          ["晶向", "<100>"],
          ["掺杂", t("B, 1.5×10¹⁵ cm⁻³ (p⁻)", "P, 1.5×10¹⁵ cm⁻³ (n⁻)")],
          ["电阻率", t("≈ 9 Ω·cm", "≈ 3 Ω·cm")]
        ],
        description: t(
          "轻掺杂 p 型衬底。它与 n 型集电区构成反偏的隔离结，把各个晶体管在电学上分开。",
          "轻掺杂 n 型衬底，与 p 型集电区构成反偏隔离结 (互补工艺中的 PNP)。"
        ),
        apply: (s) => {
          s.setSubstrate(f.sub, f.subConc, EPI);
          s.anim = { kind: "none" };
        }
      },
      {
        id: "blox",
        category: "oxidation",
        title: "掩蔽氧化",
        equipment: "氧化炉 (湿氧)",
        params: [
          ["温度 / 时间", "1000 °C / 45 min"],
          ["用途", "埋层注入掩蔽"]
        ],
        description: "在原始硅片表面生长氧化层，作为埋层注入的硬掩模。",
        apply: (s) => {
          const tox = dealGrove("wet", 1000, 45);
          s.params.tblox = tox;
          s.anneal(1000, 45);
          s.addLayer({ id: "blox", name: "掩蔽氧化", material: "thermalOxide", prisms: slabWithHoles(EPI - tox, EPI, AREA, []) });
          s.results.push(["氧化层厚度", `${(tox * 1000).toFixed(0)} nm`]);
          s.anim = { kind: "grow" };
        }
      },
      {
        id: "bllitho",
        category: "litho",
        title: "光刻 #1：埋层",
        equipment: "i-line 步进光刻机",
        params: [
          ["光刻胶", "正胶 1.0 μm"],
          ["窗口", "8.2 μm × 6.4 μm"]
        ],
        description: "定义埋层区域。埋层位于晶体管正下方，为集电极电流提供低阻的横向通路。",
        apply: (s) => {
          const tox = s.params.tblox;
          s.addLayer({ id: "pr", name: "光刻胶", material: "resist", prisms: slabWithHoles(EPI - tox - 1.0, EPI - tox, AREA, [BL]) });
          s.anim = { kind: "litho", openings: [BL], resistId: "pr" };
        }
      },
      {
        id: "bletch",
        category: "etch",
        title: "氧化层刻蚀 + 去胶",
        equipment: "BOE + O₂ 等离子",
        params: [["刻蚀", "湿法 BOE"]],
        description: "打开埋层窗口，随后去除光刻胶。",
        apply: (s) => {
          const tox = s.params.tblox;
          s.removeLayer("pr");
          s.addLayer({ id: "blox", name: "掩蔽氧化", material: "thermalOxide", prisms: slabWithHoles(EPI - tox, EPI, AREA, [BL]) });
          s.anim = { kind: "etch" };
        }
      },
      {
        id: "blimp",
        category: "implant",
        title: t("埋层注入 (Sb)", "埋层注入 (B)"),
        equipment: "大束流注入机",
        params: [
          ["离子", t("Sb⁺", "B⁺")],
          ["能量", `${f.buriedEnergy} keV`],
          ["剂量", t("3×10¹⁵ cm⁻²", "1.5×10¹⁵ cm⁻²")]
        ],
        description: t(
          "选用扩散系数小的锑形成 n⁺ 埋层，这样在后续高温工艺中埋层向外延层的反扩散 (up-diffusion) 较小。",
          "硼注入形成 p⁺ 埋层 (互补工艺)。硼扩散较快，埋层上扩会更明显。"
        ),
        apply: (s) => s.implant(f.buried, f.buriedEnergy, f.blDose, [BL])
      },
      {
        id: "bldrive",
        category: "anneal",
        title: "埋层推进",
        equipment: "扩散炉",
        params: [
          ["温度 / 时间", `${f.blT} °C / ${f.blMin} min`],
          ["气氛", "N₂ + 少量 O₂"]
        ],
        description: "推进并激活埋层杂质，修复大剂量注入造成的晶格损伤，然后去除全部氧化层准备外延。",
        apply: (s) => {
          s.anneal(f.blT, f.blMin);
          s.removeLayer("blox");
          const prof = depthProfile(s, 5, 0, EPI, D.y1, 600);
          s.results.push(["埋层 R_□", `${sheetResistance(prof, EPI, D.y1 - 0.3).toFixed(1)} Ω/□`]);
        }
      },
      {
        id: "epi",
        category: "epi",
        title: t("n 型外延", "p 型外延"),
        equipment: "单片外延反应腔 (SiH₂Cl₂)",
        params: [
          ["厚度", `${EPI} μm`],
          ["掺杂", t("P, 1×10¹⁶ cm⁻³", "B, 1×10¹⁶ cm⁻³")],
          ["温度 / 时间", "1100 °C / 8 min"]
        ],
        description: t(
          "生长轻掺杂 n 型外延层作为集电区。集电区掺杂越低，集电结耐压 BV_CBO 越高、Early 电压越大，但集电极串联电阻也越大。",
          "生长轻掺杂 p 型外延层作为 PNP 的集电区。"
        ),
        apply: (s) => s.growEpi(f.epi, f.epiConc, EPI, 1100, 8)
      },
      {
        id: "dti",
        category: "etch",
        title: "深槽刻蚀 (DTI)",
        equipment: "DRIE (Bosch 工艺)",
        params: [
          ["深度", `${trench.toFixed(1)} μm`],
          ["宽度", "0.6 μm"],
          ["气体", "SF₆ / C₄F₈ 交替"]
        ],
        description: "各向异性深硅刻蚀穿透外延层和埋层，进入衬底。深槽把相邻晶体管的集电区彻底隔开，比 p⁺ 结隔离面积小、寄生电容低。",
        apply: (s) => {
          s.addTrench({ fill: "void", x0: 0, x1: 0.6, y0: 0, y1: trench, z0: D.z0, z1: 4 });
          s.addTrench({ fill: "void", x0: 9.4, x1: 10, y0: 0, y1: trench, z0: D.z0, z1: 4 });
          s.anim = { kind: "etch" };
        }
      },
      {
        id: "dtifill",
        category: "deposition",
        title: "深槽填充 + CMP",
        equipment: "LPCVD TEOS + 化学机械抛光",
        params: [
          ["衬里", "热氧化 50 nm"],
          ["填充", "TEOS SiO₂"],
          ["平坦化", "CMP"]
        ],
        description: "先热氧化形成衬里，再用 TEOS 氧化物填满深槽，最后 CMP 去除表面多余氧化物。",
        apply: (s) => {
          s.fillTrenches();
          s.anneal(1000, 10);
          s.anim = { kind: "cmp" };
        }
      },
      {
        id: "locos",
        category: "oxidation",
        title: "LOCOS 场氧化",
        equipment: "Si₃N₄ 掩膜 + 湿氧炉",
        params: [
          ["温度 / 时间", "1000 °C / 90 min"],
          ["掩膜", "Si₃N₄ 150 nm (已去除)"],
          ["消耗硅", "≈ 45 %"]
        ],
        description: "氮化硅覆盖有源区，只在场区选择性生长厚氧化层。场氧把基区和集电极引出区隔开，并降低金属连线下方的寄生电容。",
        apply: (s) => {
          const tox = dealGrove("wet", 1000, 90);
          s.params.tlocos = tox;
          s.anneal(1000, 90);
          const holes = [ACTIVE_BASE, ACTIVE_SINK];
          s.addLayer({ id: "locos", name: "场氧", material: "thermalOxide", prisms: slabWithHoles(-0.55 * tox, 0, AREA, holes) });
          const rec = 0.45 * tox;
          s.addTrench({ fill: "oxide", x0: 0.6, x1: ACTIVE_BASE.x0, y0: 0, y1: rec, z0: D.z0, z1: 4 });
          s.addTrench({ fill: "oxide", x0: ACTIVE_BASE.x1, x1: ACTIVE_SINK.x0, y0: 0, y1: rec, z0: D.z0, z1: 4 });
          s.addTrench({ fill: "oxide", x0: ACTIVE_SINK.x1, x1: 9.4, y0: 0, y1: rec, z0: D.z0, z1: 4 });
          s.addTrench({ fill: "oxide", x0: 0.6, x1: 9.4, y0: 0, y1: rec, z0: D.z0, z1: ACTIVE_BASE.z0 });
          s.results.push(["场氧厚度", `${(tox * 1000).toFixed(0)} nm`]);
          s.anim = { kind: "grow" };
        }
      },
      {
        id: "sinker",
        category: "implant",
        title: "光刻 #2 + 集电极 sinker 预淀积",
        equipment: t("POCl₃ 扩散炉", "BBr₃ 扩散炉"),
        params: [
          ["源", t("POCl₃ 液态源", "BBr₃ 液态源")],
          ["温度", "950 °C"],
          ["等效剂量", "1×10¹⁶ cm⁻²"]
        ],
        description: "在集电极引出窗口进行高浓度预淀积，为下一步深推进提供杂质源。",
        apply: (s) => {
          resistLayer(s, "pr", [SINKER]);
          s.implant(f.sinker, 30, 1e16, [SINKER], { rp: 0.0, drp: 0.04 });
        }
      },
      {
        id: "sinkdrive",
        category: "anneal",
        title: "Sinker 推进",
        equipment: "扩散炉",
        params: [
          ["温度 / 时间", `${f.sinkT} °C / 90 min`],
          ["目标", "与埋层连通"]
        ],
        description: "长时间高温推进，使 sinker 向下扩散并与上扩的埋层连通，形成集电极的低阻垂直引出通路。",
        apply: (s) => {
          s.removeLayer("pr");
          s.anneal(f.sinkT, 90);
          const prof = depthProfile(s, 8.1, 0, 0, D.y1, 800);
          let min = Infinity;
          for (let i = 0; i < prof.y.length; i += 1) {
            if (prof.y[i] < EPI + 0.2) min = Math.min(min, Math.abs(prof.nd[i] - prof.na[i]));
          }
          s.results.push(["sinker 通路最低浓度", `${formatConc(min)} cm⁻³`]);
        }
      },
      {
        id: "base",
        category: "implant",
        title: t("光刻 #3 + 基区注入 (B)", "光刻 #3 + 基区注入 (P)"),
        equipment: "中束流注入机",
        params: [
          ["离子", t("B⁺", "P⁺")],
          ["能量", `${f.baseEnergy} keV`],
          ["剂量", "2.5×10¹³ cm⁻²"]
        ],
        description: "基区注入剂量直接决定基区 Gummel 数：剂量低 → β 高但 Early 电压低、易穿通；剂量高 → β 低。这是双极工艺中最关键的一次注入。",
        apply: (s) => {
          resistLayer(s, "pr", [BASE]);
          s.implant(f.base, f.baseEnergy, f.baseDose, [BASE]);
        }
      },
      {
        id: "emitter",
        category: "implant",
        title: "光刻 #4 + 发射区注入",
        equipment: "大束流注入机",
        params: [
          ["离子", f.emitterLabel],
          ["能量", `${f.emitterEnergy} keV`],
          ["剂量", t("6×10¹⁵ cm⁻²", "4×10¹⁵ cm⁻²")],
          ["窗口", "发射区 + 集电极接触"]
        ],
        description: t(
          "砷扩散慢、固溶度高，适合做浅而重掺杂的发射区。同一次注入也在 sinker 表面形成集电极欧姆接触。",
          "BF₂⁺ 分子注入可获得很浅的硼分布，用来形成 PNP 的 p⁺ 浅发射区。"
        ),
        apply: (s) => {
          s.removeLayer("pr");
          resistLayer(s, "pr", [EMITTER, CCONTACT]);
          s.implant(f.emitter, f.emitterEnergy, f.emitterDose, [EMITTER, CCONTACT]);
        }
      },
      {
        id: "bplus",
        category: "implant",
        title: "光刻 #5 + 基区接触注入",
        equipment: "大束流注入机",
        params: [
          ["离子", t("BF₂⁺ (等效 B 10 keV)", "As⁺ 40 keV")],
          ["剂量", "3×10¹⁵ cm⁻²"]
        ],
        description: "在基极引出处形成重掺杂区，降低基极接触电阻和非本征基区电阻 r_bb′。",
        apply: (s) => {
          s.removeLayer("pr");
          resistLayer(s, "pr", [BCONTACT]);
          s.implant(f.bplus, f.bplusEnergy, 3e15, [BCONTACT]);
        }
      },
      {
        id: "rta",
        category: "anneal",
        title: "激活退火",
        equipment: "扩散炉",
        params: [
          ["温度 / 时间", `${f.rtaT} °C / ${f.rtaMin} min`],
          ["作用", "激活 + 确定最终结深"]
        ],
        description: "这一步决定了发射结和集电结的最终位置，二者之差就是基区宽度 W_B。W_B 越小，电子穿越基区越快 (f_T 高)、复合越少 (β 高)。",
        apply: (s) => {
          s.removeLayer("pr");
          s.anneal(f.rtaT, f.rtaMin);
          report(s, f);
        }
      },
      {
        id: "ild",
        category: "deposition",
        title: "层间介质 BPSG",
        equipment: "APCVD + 回流 + CMP",
        params: [
          ["材料", "BPSG (B/P 掺杂 SiO₂)"],
          ["厚度", "0.8 μm (CMP 后)"],
          ["回流", "850 °C / 20 min"]
        ],
        description: "淀积硼磷硅玻璃并回流平坦化，隔离硅器件与第一层金属。",
        apply: (s) => {
          const top = fieldTop(s);
          s.params.ildTop = top - 0.8;
          s.addLayer({
            id: "ild",
            name: "BPSG",
            material: "bpsg",
            prisms: [...slabWithHoles(top - 0.8, top, AREA, []), ...slabWithHoles(top, 0, ACTIVE_BASE, []), ...slabWithHoles(top, 0, ACTIVE_SINK, [])]
          });
          s.anneal(850, 20);
          s.anim = { kind: "deposit" };
        }
      },
      {
        id: "contact",
        category: "metal",
        title: "光刻 #6 接触孔 + 钨塞",
        equipment: "RIE + CVD-W + CMP",
        params: [
          ["阻挡层", "Ti / TiN"],
          ["填充", "CVD 钨"],
          ["接触孔", "E / B / C"]
        ],
        description: "刻开接触孔，淀积 Ti/TiN 阻挡层并用钨填满，CMP 后形成钨塞，把 E、B、C 引到表面。",
        apply: (s) => {
          const top = fieldTop(s);
          const holes = [HOLE_E, HOLE_B, HOLE_C];
          const yTop = s.params.ildTop;
          s.addLayer({
            id: "ild",
            name: "BPSG",
            material: "bpsg",
            prisms: [...slabWithHoles(yTop, top, AREA, holes), ...slabWithHoles(top, 0, ACTIVE_BASE, holes), ...slabWithHoles(top, 0, ACTIVE_SINK, holes)]
          });
          s.addLayer({ id: "plug", name: "W 塞", material: "tungsten", prisms: holes.map((h) => box(h.x0, h.x1, yTop, 0, h.z0, h.z1)) });
          s.anim = { kind: "deposit" };
        }
      },
      {
        id: "metal1",
        category: "metal",
        title: "金属 1 (Al-Cu)",
        equipment: "溅射 + 光刻 #7 + RIE",
        params: [
          ["材料", "Al-0.5%Cu"],
          ["厚度", "0.8 μm"],
          ["线宽", "≥ 1.0 μm"]
        ],
        description: "第一层互连把 E、B、C 引出到焊盘。含铜铝合金可抑制电迁移。",
        apply: (s) => {
          const yTop = s.params.ildTop;
          s.addLayer({
            id: "m1",
            name: "金属 1",
            material: "aluminum",
            prisms: [
              box(3.0, 4.4, yTop - 0.8, yTop, -3.2, 0),
              box(1.3, 2.7, yTop - 0.8, yTop, -3.2, 0),
              box(7.4, 8.8, yTop - 0.8, yTop, -3.2, 0)
            ]
          });
          s.anim = { kind: "deposit" };
        }
      },
      {
        id: "pass",
        category: "deposition",
        title: "钝化",
        equipment: "PECVD",
        params: [["叠层", "SiO₂ 0.3 μm + Si₃N₄ 0.5 μm"]],
        description: "最终钝化保护芯片表面。",
        apply: (s) => {
          const yTop = s.params.ildTop;
          s.addLayer({ id: "pass", name: "钝化", material: "passivation", prisms: slabWithHoles(yTop - 1.4, yTop - 0.8, AREA, []) });
          s.anim = { kind: "deposit" };
        }
      }
    ]
  };
}

export const npn = makeBjt(1);
export const pnp = makeBjt(-1);
