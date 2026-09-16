/** Measures the real product app with the same instrumentation as the bisect. */
import { chromium } from "playwright";
import { SAMPLE_SSR, SAMPLE_LOG } from "../execute/sample.js";

const port = process.argv[2] ?? "5174";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1360, height: 1000 } });
const errs: string[] = [];
p.on("pageerror", (e) => errs.push(String(e.message).slice(0, 140)));
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 140)); });

await p.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
await p.fill("#artifact", `${SAMPLE_SSR}\n${SAMPLE_LOG}`);
await p.click("#analyse");
await p.waitForSelector(".targets .target");
await p.click("#reproduce");
await p.waitForSelector(".panel-ok, .panel-fail", { timeout: 240000 });
await p.waitForTimeout(4000);

const dom = await p.evaluate(() => {
  const f = document.querySelector("#playground") as HTMLIFrameElement | null;
  const r = f?.getBoundingClientRect();
  const cs = f ? getComputedStyle(f) : null;
  return { src: f?.getAttribute("src")?.slice(0, 80) ?? null, w: Math.round(r?.width ?? 0),
    h: Math.round(r?.height ?? 0), display: cs?.display, visibility: cs?.visibility,
    top: Math.round(r?.top ?? 0), panelHidden: (document.getElementById("playground-panel") as HTMLElement | null)?.hidden ?? null };
});
const scope = p.frames().find((f) => f.url().includes("/scope:"));
const inner = scope ? await scope.evaluate(() => ({
  title: document.title,
  bodyLen: document.body?.innerText?.trim().length ?? 0,
  head: (document.body?.innerText ?? "").trim().slice(0, 80),
})).catch((e) => ({ error: String(e).slice(0, 120) })) : { error: "no scope frame" };

console.log("dom   :", JSON.stringify(dom));
console.log("scope :", JSON.stringify(inner));
console.log("errors:", JSON.stringify(errs.slice(0, 5)));
await p.locator("#playground-panel").scrollIntoViewIfNeeded();
await p.waitForTimeout(500);
await p.screenshot({ path: "/Users/lucy/Projects/wordpress-support-reproduction-engine/docs/screenshots/bisect/app-measured.png" });
await b.close();
