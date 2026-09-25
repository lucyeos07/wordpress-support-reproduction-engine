/**
 * Captures the three README screenshots from the real application.
 *
 * Drives the documented walkthrough — paste `fixtures/demos/quick-start.txt`,
 * Analyze, click an evidence chip, Reproduce — against a real WordPress
 * Playground, and clips three regions of the resulting page. Nothing is
 * composed, cropped by hand or staged: each image is one continuous region of
 * one real page.
 *
 * Run: npm run dev   (then)   npx tsx spike/ui/portfolio.ts [port]
 */
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const out = resolve(root, "docs/screenshots/portfolio");
mkdirSync(out, { recursive: true });

const port = process.argv[2] ?? "5173";
const artifact = readFileSync(resolve(root, "fixtures/demos/quick-start.txt"), "utf8");

/**
 * Page-coordinate box of the first match. Evaluated as source text rather than
 * a function so the transpiler cannot inject helpers the page does not have.
 */
const boxScript = (selector: string): string => `(() => {
  var el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  var r = el.getBoundingClientRect();
  return { top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left + scrollX, width: r.width };
})()`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1160, height: 1200 }, deviceScaleFactor: 2 });
page.on("console", (m) => {
  if (m.type() === "error") console.log("   [page error]", m.text().slice(0, 160));
});

type Box = { top: number; bottom: number; left: number; width: number };
const box = async (selector: string): Promise<Box> => {
  const result = (await page.evaluate(boxScript(selector))) as Box | null;
  if (result === null) throw new Error(`no element for ${selector}`);
  return result;
};

const COLUMN_LEFT = 30;
const COLUMN_WIDTH = 1100;
const shot = async (file: string, top: number, bottom: number): Promise<void> => {
  await page.screenshot({
    path: resolve(out, file),
    fullPage: true,
    clip: { x: COLUMN_LEFT, y: top, width: COLUMN_WIDTH, height: bottom - top },
  });
  console.log(`wrote ${file} (${String(Math.round(bottom - top))}px tall)`);
};

/**
 * Same capture, but through a viewport tall enough to hold the whole region,
 * scrolled so the region starts at the top and given time to paint.
 *
 * A full-page screenshot does not paint the cross-origin Playground iframe —
 * it comes out blank, which is precisely the false evidence behind the Phase 6
 * defect report that Phase 6.1 withdrew (docs/phase-6.1-findings.md). Anything
 * containing that iframe has to be captured in-viewport, after a settle.
 */
const shotInViewport = async (file: string, top: number, bottom: number): Promise<void> => {
  const height = Math.ceil(bottom - top);
  await page.setViewportSize({ width: 1160, height: height + 40 });
  await page.evaluate(`window.scrollTo(0, ${String(Math.round(top))})`);
  await page.waitForTimeout(2_500);
  await page.screenshot({
    path: resolve(out, file),
    clip: { x: COLUMN_LEFT, y: 0, width: COLUMN_WIDTH, height },
  });
  console.log(`wrote ${file} (${String(height)}px tall, captured in-viewport)`);
};

await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
await page.fill("#artifact", artifact);
await page.click("#analyse");
await page.waitForSelector(".targets .target");

// 1 — Environment, the Finding with its evidence, and the reproducibility plan.
const environment = await box("#results .card");
const why = await box(".targets .target .reasons");
await shot("01-analysis.png", environment.top - 24, why.bottom + 28);

// 2 — The evidence interaction: the chip scrolls the pasted artifact to the
//     line it cites and highlights exactly that line.
await page.locator(".finding .chips .chip").first().click();
await page.waitForSelector(".source-line.highlight");
await page.waitForTimeout(400);
const source = await box("#results .card:has(#source-view)");
await shot("02-evidence.png", source.top - 12, source.bottom + 12);

// 3 — The verification result and the reproduced WordPress running in the page.
await page.click("#reproduce");
await page.waitForSelector(".panel-ok, .panel-fail", { timeout: 300_000 });
// Let Chromium paint the cross-origin Playground iframe before capturing:
// a screenshot taken too early is what produced the withdrawn Phase 6 defect.
await page.waitForTimeout(2_000);
const verification = await box("#results .card:has(.panel-ok), #results .card:has(.panel-fail)");
const playground = await box("#playground-panel");
const scope = page.frames().find((f) => f.url().includes("/scope:"));
if (!scope) throw new Error("no Playground scope frame: nothing to screenshot");
const site = await scope.evaluate("({ title: document.title, len: (document.body?.innerText ?? '').trim().length })");
console.log(`   playground frame: ${JSON.stringify(site)}`);
await shotInViewport("03-reproduction.png", verification.top - 24, playground.bottom + 20);

await browser.close();
