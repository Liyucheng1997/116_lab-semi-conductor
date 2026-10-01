import { chromium } from "playwright";
const [,, url = "http://127.0.0.1:5188/#npn/physics", out = "shot.png", w = "1600", h = "940", wait = "3500", actions = ""] = process.argv;
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("[console]", m.type(), m.text()); });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(url, { waitUntil: "domcontentloaded" }); console.log("loaded");
await page.waitForTimeout(+wait);
if (actions) {
  for (const a of actions.split(";;")) {
    const [kind, arg, arg2] = a.split("|");
    if (kind === "click") await page.click(arg);
    if (kind === "wait") await page.waitForTimeout(+arg);
    if (kind === "eval") await page.evaluate(arg);
    if (kind === "select") await page.selectOption(arg, arg2);
  }
}
await page.screenshot({ path: out });
if (process.env.CLIP) { const [x,y,cw,ch] = process.env.CLIP.split(",").map(Number); await page.screenshot({ path: out.replace(".png", "-clip.png"), clip: { x, y, width: cw, height: ch } }); }
await browser.close();
