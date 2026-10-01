/**
 * State-aware physical explanation: every paragraph quotes numbers from the current solution,
 * so the text always describes what the plots and the 3-D section are showing.
 */
import type { DeviceDefinition } from "../devices/types";
import type { OperatingPoint } from "../physics/compact";
import { VT } from "../physics/constants";
import type { CutData } from "../physics/cutline";

const SUP: Record<string, string> = { "-": "⁻", "+": "", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };

export function sci(v: number, digits = 1) {
  if (!isFinite(v) || v === 0) return "0";
  const e = Math.floor(Math.log10(Math.abs(v)));
  const m = v / Math.pow(10, e);
  const ms = m.toFixed(digits);
  return `${ms}×10${String(e)
    .split("")
    .map((c) => SUP[c] ?? c)
    .join("")}`;
}

export function si(v: number, unit: string) {
  const a = Math.abs(v);
  const table: Array<[number, string]> = [
    [1, ""],
    [1e-3, "m"],
    [1e-6, "μ"],
    [1e-9, "n"],
    [1e-12, "p"],
    [1e-15, "f"]
  ];
  for (const [m, p] of table) if (a >= m * 0.9995) return `${(v / m).toPrecision(3)} ${p}${unit}`;
  return `${v.toExponential(1)} ${unit}`;
}

export interface CutSummary {
  emax: number; // kV/cm
  width: number; // μm total depleted along cut
  bands: Array<[number, number]>;
}

export function summarizeCut(c: CutData | null): CutSummary {
  if (!c) return { emax: 0, width: 0, bands: [] };
  let emax = 0;
  c.field.forEach((f) => (emax = Math.max(emax, Math.abs(f))));
  const bands: Array<[number, number]> = [];
  let start: number | null = null;
  for (let i = 0; i < c.t.length; i += 1) {
    const dep = Math.abs(c.neutral[i]) < 0.5;
    if (dep && start === null) start = c.t[i];
    if (!dep && start !== null) {
      bands.push([start, c.t[i]]);
      start = null;
    }
  }
  const width = bands.reduce((s, b) => s + (b[1] - b[0]), 0);
  return { emax, width, bands };
}

const p = (s: string) => `<p>${s}</p>`;
const b = (s: string) => `<b>${s}</b>`;

export function explainPhysics(def: DeviceDefinition, op: OperatingPoint, cut: CutSummary): string {
  const v = op.values;
  if (def.family === "diode") return diode(op, cut);
  if (def.family === "bjt") return bjt(def, op, cut);
  return mos(def, op, v);
}

function diode(op: OperatingPoint, cut: CutSummary) {
  const v = op.values;
  const vj = v.vj;
  const out: string[] = [];
  const barrier = Math.max(v.vbi - vj, 0);
  if (Math.abs(vj) < 0.02) {
    out.push(
      p(
        `${b("热平衡。")}p⁺ 区的空穴向 n 区扩散、n 区的电子向 p⁺ 区扩散，在结两侧留下不能移动的电离受主 (−) 和电离施主 (+)，形成宽 ${b(`${cut.width.toFixed(2)} μm`)} 的耗尽层。空间电荷建立内建电场（峰值 ${b(`${cut.emax.toFixed(0)} kV/cm`)}），形成 ${b(`qV_bi ≈ ${v.vbi.toFixed(2)} eV`)} 的势垒。`
      ),
      p(`平衡时每一点的扩散电流与漂移电流大小相等、方向相反，净电流为零；能带图中 E_Fn 与 E_Fp 重合为一条水平直线。由于 N_A ≫ N_D，耗尽层几乎全部落在轻掺杂的 n 外延一侧（单边突变结）。`)
    );
  } else if (vj > 0) {
    const boost = Math.exp(vj / VT);
    const narrowed =
      cut.width > 0.01
        ? `耗尽层收窄到 ${b(`${cut.width.toFixed(3)} μm`)}`
        : `耗尽层几乎消失——这是缓变结：p⁺ 区高斯分布的尾部掺杂只有 10¹⁷ cm⁻³ 量级，外加电压已接近把能带拉平`;
    out.push(
      p(
        `${b("正向偏置。")}结上实际电压 V_j = ${vj.toFixed(3)} V，势垒由 ${v.vbi.toFixed(2)} eV 降到 ${b(`${barrier.toFixed(2)} eV`)}，${narrowed}。能带图中准费米能级分裂 E_Fn − E_Fp = qV_j。`
      ),
      p(
        `按"结定律" p_n(0) = p_n0·e^{qV/kT}，耗尽区边界处的少子浓度提高了 ${b(sci(boost))} 倍。注入的少子在中性区一边扩散一边复合，形成扩散电流 I ≈ I_S·e^{qV/nkT}（当前 ${b(si(v.I, "A"))}）。n⁺ 衬底形成高–低结，把空穴"反射"回外延层，所以载流子浓度图中外延层里的空穴浓度几乎是平的，E_Fp 也几乎水平。`
      )
    );
    if (op.region.includes("复合")) out.push(p(`小电流时耗尽区中的 SRH 复合电流（∝ e^{qV/2kT}）占主导，理想因子接近 2，这正是半对数 I–V 曲线低端斜率较缓的原因。`));
    if (op.region.includes("大注入")) out.push(p(`注入的空穴浓度已接近外延掺杂，发生大注入，同时 I·R_S 压降使外加电压不能全部加在结上——I–V 曲线向下弯曲。`));
  } else {
    out.push(
      p(
        `${b("反向偏置。")}外加电压与内建电场同向，势垒升高到 ${b(`${barrier.toFixed(2)} eV`)}，耗尽层展宽到 ${b(`${cut.width.toFixed(2)} μm`)}（∝ √(V_bi + V_R)），峰值电场 ${b(`${cut.emax.toFixed(0)} kV/cm`)}。`
      ),
      p(
        `多子被高势垒挡回，只剩耗尽层内热产生的电子–空穴对被电场分开形成的微小反向电流 ${b(si(v.I, "A"))}，所以反向电流几乎不随电压变化。耗尽层变宽也使结电容 C_j = εA/W 下降（见 C–V 曲线）。`
      )
    );
    if (op.tone === "warn") out.push(p(`${b("雪崩击穿：")}峰值电场接近临界值，载流子在耗尽区中获得足够能量碰撞电离，产生的电子–空穴对再次被加速——倍增使反向电流急剧增大。平面结在窗口边缘弯曲，电场更集中，因此击穿电压低于平行平面结的理论值；阳极金属延伸出的场板用来缓解这一点。`));
  }
  return out.join("");
}

function bjt(def: DeviceDefinition, op: OperatingPoint, cut: CutSummary) {
  const v = op.values;
  const npn = def.polarity === 1;
  const inj = npn ? "电子" : "空穴";
  const maj = npn ? "空穴" : "电子";
  const e = npn ? "V_BE" : "V_EB";
  const out: string[] = [];
  if (op.tone === "off" || v.ic < 1e-10) {
    out.push(p(`${b("截止。")}发射结正偏不足（${e}′ = ${v.vbe.toFixed(3)} V），注入可以忽略；集电极只有反偏集电结的漏电流。能带图中发射结势垒仍然很高，${inj}无法进入基区。`));
    return out.join("");
  }
  out.push(
    p(
      `${b("发射结正偏")}（${e}′ = ${v.vbe.toFixed(3)} V）：发射结势垒降低，发射区${inj}注入基区，基区一侧边界的${inj}浓度达到 ${b(`${sci(v.n0)} cm⁻³`)}（比平衡值高 e^{qV/kT} 倍）。`
    ),
    p(
      `${inj}在宽度 ${b(`W_B = ${(v.wb * 1000).toFixed(0)} nm`)} 的中性基区中以扩散方式穿越，渡越时间 τ_F ≈ W_B²/2D = ${b(si(v.tauF, "s"))}。因为 τ_F 远小于少子寿命，绝大部分${inj}来不及复合——载流子浓度图中基区少子呈近似线性下降，这个浓度梯度就是集电极电流的来源。`
    )
  );
  if (v.vbc < 0.2) {
    out.push(
      p(
        `${b("集电结反偏")}：耗尽区中的强电场（剖面峰值 ${cut.emax.toFixed(0)} kV/cm）把到达集电结边缘的${inj}全部扫入集电区，再经埋层横向流到 sinker 被集电极收集。因此 I_C = ${b(si(v.ic, "A"))} 几乎只由发射结电压决定，而与 V_CE 无关——这就是晶体管的放大作用：输入端小电压控制输出端大电流。`
      ),
      p(
        `基极电流 I_B = ${si(v.ib, "A")} 来自两部分：${maj}向发射区的反注入，以及${maj}与${inj}在基区的复合。电流增益 ${b(`β = ${v.beta.toFixed(0)}`)}。增大 V_CE 会使集电结耗尽层向基区扩展、中性基区变窄，I_C 略微上升（Early 效应）。`
      )
    );
  } else {
    out.push(
      p(
        `${b("集电结也已正偏")}（V_B′C′ = ${v.vbc.toFixed(2)} V）：集电结不再只"收集"，反而向集电区注入载流子，基区中的少子梯度变小，I_C 下降、I_B 增大（β_forced = ${v.beta.toFixed(1)}）。饱和时基区和集电区存储了大量少子，这正是双极开关关断变慢的原因。`
      )
    );
  }
  out.push(p(`小信号参数：g_m = I_C/V_T = ${si(v.gm, "S")}，特征频率 f_T ≈ ${si(v.ft, "Hz")}。`));
  return out.join("");
}

function mos(def: DeviceDefinition, op: OperatingPoint, v: Record<string, number>) {
  const n = def.polarity === 1;
  const carrier = n ? "电子" : "空穴";
  const g = n ? "V_GS" : "V_SG";
  const out: string[] = [];
  if (op.tone === "off") {
    out.push(
      p(
        `${b("亚阈值区。")}${g} 低于阈值电压 V_T = ${Math.abs(v.vt).toFixed(3)} V，栅下表面处于耗尽/弱反型。沿沟道的能带图中，源端存在一个${carrier}势垒；只有少数能量足够的${carrier}越过势垒并靠扩散到达漏极。`
      ),
      p(`栅压只能通过"体电容分压"间接降低势垒，所以 I_D ∝ exp(${g}/nV_T)，亚阈斜率 SS = n·V_T·ln10 ≈ ${(v.n * VT * Math.log(10) * 1000).toFixed(0)} mV/dec。当前 I_D = ${b(si(v.id, "A"))}。`)
    );
    return out.join("");
  }
  out.push(
    p(
      `${b("栅压超过阈值")}（V_T = ${Math.abs(v.vt).toFixed(3)} V）：栅氧下方的表面发生强反型，形成连续的 ${n ? "n" : "p"} 型沟道（切换到"${n ? "电子" : "空穴"}浓度"可以看到沟道只有几纳米厚）。反型层面电荷 ≈ C_ox(${g} − V_T)，由栅压直接控制。`
    )
  );
  if (op.region.includes("线性")) {
    out.push(p(`${b("线性区：")}V_DS 小于 V_Dsat = ${v.vdsat.toFixed(2)} V，沟道从源到漏连续，器件像一个受栅压控制的电阻，I_D ≈ μC_ox(W/L)(${g} − V_T)V_DS = ${b(si(v.id, "A"))}。`));
  } else {
    out.push(
      p(
        `${b("饱和区：")}V_DS 超过 V_Dsat = ${v.vdsat.toFixed(2)} V，漏端的反型层消失——沟道在距源端约 ${isFinite(v.xPinch) ? ((v.xPinch - v.xs) * 1000).toFixed(0) : "—"} nm 处夹断。多出来的 V_DS 降落在夹断点与漏之间的耗尽区上，${carrier}在那里被强电场注入漏极，所以 I_D = ${b(si(v.id, "A"))} 基本不再随 V_DS 增大。`
      ),
      p(`短沟道修正：沟长调制和 DIBL 使饱和区曲线略微上翘，速度饱和使 I_D 随过驱动电压近似线性而非平方增长。本征增益 g_m/g_ds = ${(v.gm / Math.max(v.gds, 1e-12)).toFixed(1)}。`)
    );
  }
  return out.join("");
}

export function deviceIntro(def: DeviceDefinition) {
  switch (def.family) {
    case "diode":
      return "平面 p⁺n 结二极管：在 n⁺ 衬底的 n⁻ 外延层上开窗扩硼形成 p⁺ 阳极，背面金属为阴极。外延层的浓度和厚度分别决定击穿电压与串联电阻。";
    case "bjt":
      return def.polarity === 1
        ? "标准埋层集电极 (SBC) 工艺的纵向 NPN：n⁺ 发射区 / p 基区 / n 外延集电区纵向叠置，n⁺ 埋层与 sinker 把集电极电流引回表面，深槽隔离把器件与衬底和相邻器件分开。"
        : "互补双极工艺中的纵向 PNP：掺杂类型与 NPN 完全互补，主要载流子为空穴。空穴迁移率较低，所以同样尺寸下 β 和速度都不如 NPN。";
    default:
      return def.polarity === 1
        ? "0.5 μm 级 CMOS 工艺的 NMOS：浅槽隔离、逆向 p 阱、7 nm 栅氧、n⁺ 多晶硅栅、LDD + 侧墙、自对准硅化物。"
        : "与 NMOS 互补的 PMOS，做在 n 阱中，p⁺ 多晶硅栅。空穴迁移率约为电子的 1/2~1/3，所以 PMOS 通常需要更大的 W。";
  }
}
