/**
 * Drives boot-failure isolation through the real UI, in a real browser.
 *
 * The CLI spike proves the search; this proves the browser surface runs the
 * same search to the same answer, which this project measures rather than
 * assumes (SPEC §12). Pastes demo B, reproduces (the boot fails), clicks
 * "Isolate the failing component", and asserts the result names wordfence.
 *
 * Run: npm run dev   (then)   npx tsx spike/ui/isolate.ts [port]
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const artifact = readFileSync(resolve(root, "fixtures/demos/demo-b-plugin-fatal.txt"), "utf8");
const port = process.argv[2] ?? "5173";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.on("console", (m) => {
  if (m.type() === "error") console.log("   [page error]", m.text().slice(0, 160));
});

await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
await page.fill("#artifact", artifact);
await page.click("#analyse");
await page.waitForSelector(".targets .target");

console.log("reproducing (demo B's boot is expected to fail)…");
await page.click("#reproduce");
await page.waitForSelector(".panel-ok, .panel-fail", { timeout: 300_000 });
const boot = await page.locator(".panel .status-line").first().textContent();
console.log(`  ${String(boot)}`);

const isolateButton = page.locator("#isolate");
if ((await isolateButton.count()) === 0) {
  console.error("FAIL: the boot failed but no isolation was offered");
  process.exit(1);
}

const started = Date.now();
await isolateButton.click();
await page.waitForSelector(".isolation .panel .outcome", { timeout: 900_000 });
const outcome = (await page.locator(".isolation .outcome").textContent()) ?? "";
const attempts = await page.locator(".isolation .attempts li").allTextContents();

console.log(`isolated in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`  outcome: ${outcome}`);
for (const attempt of attempts) console.log(`  attempt: ${attempt.replace(/\s+/g, " ").slice(0, 120)}`);

// The plan must be untouched by the bisection.
const blueprint = (await page.locator(".blueprint pre.code").textContent()) ?? "";
const stillPinned = ["woocommerce@8.5.2", "wordfence@7.11.4"].every((c) => blueprint.includes(c));

if (!outcome.includes("wordfence@7.11.4 aborts the boot")) {
  console.error("FAIL: the browser surface did not name wordfence@7.11.4");
  process.exit(1);
}
if (!stillPinned) {
  console.error("FAIL: the Blueprint was modified by the bisection");
  process.exit(1);
}
console.log("PASS: browser surface names wordfence@7.11.4, and the Blueprint is unchanged");

await browser.close();
