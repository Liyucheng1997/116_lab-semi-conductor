/** Test-bench schematics (inline SVG) with live source values and terminal currents. */
import type { DeviceDefinition } from "../devices/types";
import type { OperatingPoint } from "../physics/compact";
import { si } from "./explain";

const W = "#8fa3b8";
const T = "#d6e0ea";
const A = "#6fe3ff";

function source(x: number, y: number, label: string, value: string, side: "right" | "left" = "right") {
  const tx = side === "right" ? 19 : -19;
  const anchor = side === "right" ? "start" : "end";
  return `
  <g transform="translate(${x},${y})">
    <circle r="13" fill="none" stroke="${W}" stroke-width="1.4"/>
    <text x="0" y="-3" text-anchor="middle" font-size="10" fill="${W}">+</text>
    <text x="0" y="9" text-anchor="middle" font-size="11" fill="${W}">−</text>
    <text x="${tx}" y="-2" font-size="10.5" fill="${T}" text-anchor="${anchor}">${label}</text>
    <text x="${tx}" y="11" font-size="10.5" fill="${A}" text-anchor="${anchor}" font-family="JetBrains Mono, Consolas, monospace">${value}</text>
  </g>`;
}

function ground(x: number, y: number) {
  return `<g stroke="${W}" stroke-width="1.4"><line x1="${x}" y1="${y}" x2="${x}" y2="${y + 6}"/><line x1="${x - 9}" y1="${y + 6}" x2="${x + 9}" y2="${y + 6}"/><line x1="${x - 5}" y1="${y + 10}" x2="${x + 5}" y2="${y + 10}"/><line x1="${x - 2}" y1="${y + 14}" x2="${x + 2}" y2="${y + 14}"/></g>`;
}

function arrowCurrent(x: number, y: number, dir: "down" | "up" | "right" | "left", text: string) {
  const rot = { down: 90, up: -90, right: 0, left: 180 }[dir];
  const tx = dir === "right" || dir === "left" ? x - 6 : x + 8;
  const ty = dir === "right" || dir === "left" ? y - 7 : y + 4;
  return `<g transform="translate(${x},${y}) rotate(${rot})"><path d="M-5,-4 L3,0 L-5,4 Z" fill="${A}"/></g>
    <text x="${tx}" y="${ty}" font-size="10" fill="${A}" font-family="JetBrains Mono, Consolas, monospace">${text}</text>`;
}

export function schematic(def: DeviceDefinition, bias: Record<string, number>, op: OperatingPoint) {
  const v = op.values;
  const wire = `stroke="${W}" stroke-width="1.4" fill="none"`;
  if (def.family === "diode") {
    const i = v.I;
    return `<svg viewBox="0 0 240 118" class="schem">
      <path d="M40,78 L40,20 L200,20 L200,50" ${wire}/>
      <path d="M200,82 L200,100 L40,100 L40,92" ${wire}/>
      ${source(40, 78, "V_AK", `${bias.VA.toFixed(3)} V`)}
      <g transform="translate(200,66)"><path d="M-10,-12 L10,-12 L0,4 Z" fill="none" stroke="${T}" stroke-width="1.5"/><line x1="-10" y1="4" x2="10" y2="4" stroke="${T}" stroke-width="1.8"/><line x1="0" y1="-16" x2="0" y2="-12" stroke="${W}" stroke-width="1.4"/><line x1="0" y1="4" x2="0" y2="16" stroke="${W}" stroke-width="1.4"/></g>
      <text x="214" y="58" font-size="10" fill="${T}">A</text><text x="214" y="80" font-size="10" fill="${T}">K</text>
      ${arrowCurrent(120, 20, i >= 0 ? "right" : "left", `I_A = ${si(i, "A")}`)}
      ${ground(120, 100)}
    </svg>`;
  }
  if (def.family === "bjt") {
    const npn = def.polarity === 1;
    const [kb, kc] = npn ? ["VBE", "VCE"] : ["VEB", "VEC"];
    const arrow = npn ? `<path d="M152,76 L160,86 L149,84 Z" fill="${T}"/>` : `<path d="M146,72 L138,64 L149,64 Z" fill="${T}"/>`;
    return `<svg viewBox="0 0 240 132" class="schem">
      <circle cx="150" cy="62" r="20" fill="none" stroke="${W}" stroke-width="1.2"/>
      <line x1="140" y1="48" x2="140" y2="76" stroke="${T}" stroke-width="2"/>
      <line x1="140" y1="56" x2="160" y2="42" stroke="${T}" stroke-width="1.5"/>
      <line x1="140" y1="68" x2="160" y2="82" stroke="${T}" stroke-width="1.5"/>
      ${arrow}
      <path d="M160,42 L160,20 L212,20 L212,58" ${wire}/>
      <path d="M212,86 L212,112 L160,112 L160,82" ${wire}/>
      <path d="M140,62 L64,62 L64,70" ${wire}/>
      <path d="M64,96 L64,112 L160,112" ${wire}/>
      ${source(64, 83, npn ? "V_BE" : "V_EB", `${bias[kb].toFixed(3)} V`)}
      ${source(212, 72, npn ? "V_CE" : "V_EC", `${bias[kc].toFixed(2)} V`, "left")}
      <text x="126" y="58" font-size="10" fill="${T}">B</text>
      <text x="166" y="38" font-size="10" fill="${T}">${npn ? "C" : "C"}</text>
      <text x="166" y="96" font-size="10" fill="${T}">E</text>
      ${arrowCurrent(100, 62, npn ? "right" : "left", `I_B ${si(v.ib, "A")}`)}
      ${arrowCurrent(186, 20, npn ? "left" : "right", `I_C ${si(v.ic, "A")}`)}
      ${ground(110, 112)}
    </svg>`;
  }
  const n = def.polarity === 1;
  const [kg, kd, kb] = n ? ["VGS", "VDS", "VBS"] : ["VSG", "VSD", "VSB"];
  return `<svg viewBox="0 0 240 132" class="schem">
    <line x1="140" y1="40" x2="140" y2="84" stroke="${T}" stroke-width="2"/>
    <line x1="132" y1="44" x2="132" y2="80" stroke="${T}" stroke-width="2"/>
    <path d="M140,46 L160,46 L160,20 L212,20 L212,58" ${wire}/>
    <path d="M140,78 L160,78 L160,112" ${wire}/>
    <path d="M140,62 L178,62" ${wire}/>
    ${n ? `<path d="M150,62 L144,58 L144,66 Z" fill="${T}"/>` : `<path d="M146,62 L152,58 L152,66 Z" fill="${T}"/>`}
    <path d="M132,62 L64,62 L64,70" ${wire}/>
    <path d="M64,96 L64,112 L212,112 L212,86" ${wire}/>
    ${source(64, 83, n ? "V_GS" : "V_SG", `${bias[kg].toFixed(2)} V`)}
    ${source(212, 72, n ? "V_DS" : "V_SD", `${bias[kd].toFixed(2)} V`, "left")}
    <text x="120" y="56" font-size="10" fill="${T}">G</text>
    <text x="164" y="42" font-size="10" fill="${T}">D</text>
    <text x="164" y="92" font-size="10" fill="${T}">S</text>
    <text x="180" y="57" font-size="10" fill="${T}">B</text>
    <text x="8" y="16" font-size="10" fill="${T}">${n ? "V_BS" : "V_SB"} = <tspan fill="${A}" font-family="JetBrains Mono, Consolas, monospace">${bias[kb].toFixed(2)} V</tspan></text>
    ${arrowCurrent(186, 20, n ? "left" : "right", `I_D ${si(v.id, "A")}`)}
    ${ground(120, 112)}
  </svg>`;
}
