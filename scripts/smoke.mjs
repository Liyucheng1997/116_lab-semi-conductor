// End-to-end smoke test: walks every process step and every physics control of every device.
import { chromium } from "playwright";
const base = process.argv[2] ?? "http://127.0.0.1:5188/";
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
await page.goto(base + "#diode/process", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
for (const dev of ["diode", "npn", "pnp", "nmos", "pmos"]) {
  const t0 = Date.now();
  await page.evaluate((d) => { location.hash = `#${d}/process`; }, dev);
  await page.waitForTimeout(1500);
  const n = await page.evaluate(() => document.querySelectorAll(".steps li").length);
  for (let i = 0; i < n; i += 1) {
    await page.evaluate((k) => document.querySelectorAll(".steps li")[k].click(), i);
    await page.waitForTimeout(250);
  }
  await page.evaluate(() => document.querySelector('[data-step="prev"]').click());
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('.mode-switch [data-mode="physics"]').click());
  await page.waitForTimeout(1500);
  const fields = await page.evaluate(() => [...document.querySelectorAll("#fieldSelect option")].map((o) => o.value));
  for (const f of fields) { await page.selectOption("#fieldSelect", f); await page.waitForTimeout(150); }
  const cuts = await page.evaluate(() => [...document.querySelectorAll("#cutSelect option")].map((o) => o.value));
  for (const c of cuts) { await page.selectOption("#cutSelect", c); await page.waitForTimeout(300); }
  const tabs = await page.evaluate(() => document.querySelectorAll(".card .tabs button").length);
  for (let i = 0; i < tabs; i += 1) { await page.evaluate((k) => document.querySelectorAll(".card .tabs button")[k].click(), i); await page.waitForTimeout(150); }
  const ranges = await page.evaluate(() => document.querySelectorAll("#biasControls input[type=range]").length);
  for (let r = 0; r < ranges; r += 1) {
    for (const frac of [0, 0.35, 0.7, 1, 0.55]) {
      await page.evaluate(([k, f]) => { const el = document.querySelectorAll("#biasControls input[type=range]")[k]; const min = +el.min, max = +el.max; el.value = String(min + (max - min) * f); el.dispatchEvent(new Event("input")); }, [r, frac]);
      await page.waitForTimeout(250);
    }
  }
  for (const v of ["front", "top", "iso"]) { await page.evaluate((vv) => document.querySelector(`[data-view="${vv}"]`).click(), v); await page.waitForTimeout(200); }
  await page.evaluate(() => document.querySelector("#sweepBtn").click());
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector("#sweepBtn").click());
  await page.waitForTimeout(800);
  const status = await page.evaluate(() => document.querySelector("#status span").textContent);
  const region = await page.evaluate(() => document.querySelector("#regionBadge").textContent);
  console.log(`${dev}: ${n} steps ok, ${fields.length} fields, ${cuts.length} cuts, ${tabs} IV views, ${ranges} biases — ${region} — ${status} (${Date.now() - t0} ms)`);
}
console.log(errors.length ? `ERRORS (${errors.length}):\n` + errors.slice(0, 20).join("\n") : "no runtime errors");
await browser.close();
