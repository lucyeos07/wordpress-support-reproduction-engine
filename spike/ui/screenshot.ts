/**
 * Captures screenshots of the product UI for review.
 *
 * Runs the real app in Chromium, pastes a real fixture, clicks Analyze, and
 * captures the result. Not part of the test suite — the UI assertions live in
 * tests/ui/app.test.ts.
 *
 * Run: npx vite   (then)   npx tsx spike/ui/screenshot.ts [port]
 */
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const out = resolve(root, "docs/screenshots");
mkdirSync(out, { recursive: true });

const port = process.argv[2] ?? "5173";
const ssr = readFileSync(resolve(root, "fixtures/ssr/13-php-below-woo-requirement.txt"), "utf8");
const logPlugin = readFileSync(resolve(root, "fixtures/logs/log-01-plugin-fatal.txt"), "utf8");
const logTheme = readFileSync(resolve(root, "fixtures/logs/log-02-theme-fatal.txt"), "utf8");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
await page.screenshot({ path: resolve(out, "01-input.png") });
console.log("wrote 01-input.png");

await page.fill("#artifact", `${ssr}\n${logPlugin}\n${logTheme}`);
await page.click("#analyse");
await page.waitForSelector(".finding", { timeout: 10_000 });

await page.screenshot({ path: resolve(out, "02-analysis-full.png"), fullPage: true });
console.log("wrote 02-analysis-full.png");

const targets = await page.locator(".targets .target").count();
const findings = await page.locator(".finding").count();
const warnings = await page.locator(".warnings").count();
console.log(`findings=${String(findings)} targets=${String(targets)} warningBlocks=${String(warnings)}`);

// Evidence must scroll into and highlight the pasted source.
await page.locator(".finding .chip").first().click();
await page.waitForSelector(".source-line.highlight");
await page.locator(".source-line.highlight").scrollIntoViewIfNeeded();
await page.screenshot({ path: resolve(out, "03-evidence-link.png") });
console.log("wrote 03-evidence-link.png");

await browser.close();
