/**
 * End-to-end check of the product UI against a real Playground instance.
 *
 * Pastes an artifact, clicks Analyze, clicks "Reproduce in WordPress
 * Playground", and waits for the verification panel. This is the check that
 * the UI genuinely works rather than only passing jsdom assertions.
 *
 * Run: npx vite   (then)   npx tsx spike/ui/reproduce.ts [port]
 */
import { chromium } from "playwright";
import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SAMPLE_SSR, SAMPLE_LOG } from "../execute/sample.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../docs/screenshots");
mkdirSync(out, { recursive: true });

const port = process.argv[2] ?? "5173";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 1100 } });
page.on("console", (m) => {
  if (m.type() === "error") console.log("   [page error]", m.text().slice(0, 200));
});

await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
await page.fill("#artifact", `${SAMPLE_SSR}\n${SAMPLE_LOG}`);
await page.click("#analyse");
await page.waitForSelector(".targets .target");
console.log("analysis rendered");

const started = Date.now();
await page.click("#reproduce");

// The progress panel must appear before anything else happens.
await page.waitForSelector(".stages");
console.log("progress stages shown:", await page.locator(".stage").allTextContents());
await page.screenshot({ path: resolve(out, "07-reproducing.png") });

await page.waitForSelector(".panel-ok, .panel-fail", { timeout: 240_000 });
console.log(`verification after ${((Date.now() - started) / 1000).toFixed(1)}s`);

const outcome = await page.locator(".outcome").first().textContent();
const boot = await page.locator(".panel h3").first().textContent();
const bootLine = await page.locator(".panel .status-line").first().textContent();
const installed = await page.locator(".panel ul li").first().textContent();
console.log(`  ${String(boot)}: ${String(bootLine)}`);
console.log(`  installed: ${String(installed)}`);
console.log(`  target outcome: ${String(outcome)}`);
console.log(`  playground iframe visible: ${String(await page.locator("#playground").isVisible())}`);
console.log(`  analysis still visible: ${String(await page.locator("#results .card").first().isVisible())}`);

await page.screenshot({ path: resolve(out, "08-verification.png"), fullPage: true });
await page.locator("#playground-panel").scrollIntoViewIfNeeded();
await page.screenshot({ path: resolve(out, "09-playground.png") });
console.log("wrote 07/08/09 screenshots");

await browser.close();
