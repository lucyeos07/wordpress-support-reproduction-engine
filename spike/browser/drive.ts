/**
 * Phase 0 spike driver: loads the bare Vite page in a real Chromium and
 * reports what the host page observed. Exists because the browser surface
 * has to be verified in an ordinary browser, and because it establishes
 * whether the browser path is automatable at all.
 *
 * Assumes `npx vite` is already serving spike/browser on :9500.
 */
import { chromium } from "playwright";

const TIMEOUT_MS = 240_000;

const browser = await chromium.launch();
const page = await browser.newPage();

page.on("console", (msg) => {
  const t = msg.text();
  if (t.startsWith("PHASE0")) console.log("  [page]", t.slice(0, 300));
});
page.on("pageerror", (err) => console.log("  [pageerror]", err.message.slice(0, 300)));

const target = process.argv[2] ?? "http://localhost:9500";
console.log("driving:", target);
await page.goto(target, { waitUntil: "domcontentloaded" });

console.log("crossOriginIsolated:", await page.evaluate(() => window.crossOriginIsolated));

const started = Date.now();
try {
  await page.waitForFunction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (window as any).__PHASE0__?.done === true,
    undefined,
    { timeout: TIMEOUT_MS },
  );
  console.log(`\nspike completed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} catch {
  console.log(`\nTIMED OUT after ${TIMEOUT_MS / 1000}s — reporting partial state`);
}

const results = await page.evaluate(() => (window as unknown as Record<string, unknown>)["__PHASE0__"]);
console.log("\n=== window.__PHASE0__ ===");
console.log(JSON.stringify(results, null, 2));

await browser.close();
