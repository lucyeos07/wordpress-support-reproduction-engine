/**
 * Drives the Phase 4.5 browser spike in a real Chromium.
 *
 * The embedded Claude browser pane forces cross-origin isolation, which blocks
 * the playground.wordpress.net iframe (Phase 0 §3). Playwright's Chromium is
 * not isolated, so it is what the browser surface is verified in.
 *
 * Assumes `npx vite --config vite.config.ts` is serving spike/browser on :9500.
 */
import { chromium } from "playwright";

const TIMEOUT_MS = 240_000;
const variants = ["pinned", "unpinned", "missing"];

const browser = await chromium.launch();

for (const variant of variants) {
  const page = await browser.newPage();
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.startsWith("PIN")) console.log("   [page]", text.slice(0, 260));
  });

  const started = Date.now();
  await page.goto(`http://localhost:9500/version-pinning.html?blueprint=${variant}`, {
    waitUntil: "domcontentloaded",
  });

  console.log(`\n### ${variant}`);
  try {
    await page.waitForFunction(
      () => (window as unknown as Record<string, any>)["__PIN__"]?.done === true,
      undefined,
      { timeout: TIMEOUT_MS },
    );
  } catch {
    console.log(`   TIMED OUT after ${TIMEOUT_MS / 1000}s`);
  }

  const results = await page.evaluate(() => (window as unknown as Record<string, unknown>)["__PIN__"]);
  console.log(`   seconds: ${((Date.now() - started) / 1000).toFixed(1)}`);
  console.log(`   ${JSON.stringify(results)}`);
  await page.close();
}

await browser.close();
