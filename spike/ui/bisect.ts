/**
 * Phase 6.1 driver: runs every bisect step in the same Chromium used by the
 * browser integration tests and reports the first step where WordPress stops
 * rendering inside the nested #wp frame.
 */
import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs/screenshots/bisect");
mkdirSync(out, { recursive: true });

const STEPS = (process.argv[2] ?? "").length > 0 ? [Number(process.argv[2])] : [1,2,3,4,5,6,7,8,9,10];
const results: Array<Record<string, unknown>> = [];

const browser = await chromium.launch();

for (const step of STEPS) {
  const page: Page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const navigations: string[] = [];

  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160)); });
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 160)));
  page.on("requestfailed", (r) => failedRequests.push(`${r.url().slice(0, 90)} ${String(r.failure()?.errorText)}`));
  page.on("framenavigated", (f) => navigations.push(f.url().slice(0, 90)));

  await page.goto(`http://localhost:9500/bisect.html?step=${String(step)}`, { waitUntil: "domcontentloaded" });
  let timedOut = false;
  try {
    await page.waitForFunction(() => (window as any).__BISECT__?.done === true, undefined, { timeout: 240000 });
  } catch { timedOut = true; }
  await page.waitForTimeout(4000);

  const harness = await page.evaluate(() => (window as any).__BISECT__);
  const dom = await page.evaluate(() => {
    const f = document.querySelector("iframe") as HTMLIFrameElement | null;
    const r = f?.getBoundingClientRect();
    const cs = f ? getComputedStyle(f) : null;
    return {
      src: f?.getAttribute("src")?.slice(0, 80) ?? null,
      w: Math.round(r?.width ?? 0), h: Math.round(r?.height ?? 0),
      display: cs?.display, visibility: cs?.visibility,
      panelHidden: (document.getElementById("playground-panel") as HTMLElement | null)?.hidden ?? null,
    };
  });

  const scope = page.frames().find((f) => f.url().includes("/scope:"));
  // Ground truth: the WordPress document lives in the wrapper's nested #wp.
  // The scope frame IS the WordPress document; there is no nested #wp. An
  // earlier detector looked for one and reported every step blank, including
  // the known-good control.
  const nested = scope
    ? await scope.evaluate(() => {
        const inner = document.querySelector("#wp") as HTMLIFrameElement | null;
        return {
          scopeTitle: document.title,
          scopeBodyLen: document.body?.innerText?.trim().length ?? 0,
          scopeBodyHead: (document.body?.innerText ?? "").trim().slice(0, 60),
          nestedExists: Boolean(inner),
          nestedBodyLen: inner?.contentDocument?.body?.innerText?.trim().length ?? 0,
        };
      }).catch((e) => ({ error: String(e).slice(0, 120) }))
    : { error: "no scope frame" };

  const scopeLen = (nested as { scopeBodyLen?: number }).scopeBodyLen ?? 0;
  const nestedLen = (nested as { nestedBodyLen?: number }).nestedBodyLen ?? 0;
  const rendered = scopeLen > 0 || nestedLen > 0;

  await page.screenshot({ path: `${out}/step-${String(step).padStart(2, "0")}.png` });

  results.push({ step, rendered, timedOut, applied: harness?.applied?.length ?? 0, dom, nested,
    consoleErrors: consoleErrors.slice(0, 3), pageErrors: pageErrors.slice(0, 3),
    failedRequests: failedRequests.slice(0, 3), navCount: navigations.length,
    harnessErrors: harness?.errors ?? [] });

  console.log(`step ${String(step).padStart(2)}  rendered=${rendered ? "YES" : "NO "}  ` +
    `frame=${String(dom.w)}x${String(dom.h)} ${String(dom.display)}/${String(dom.visibility)}  ` +
    `scopeLen=${String(scopeLen)} nestedLen=${String(nestedLen)} title=${JSON.stringify((nested as { scopeTitle?: string }).scopeTitle ?? "-")}  ` +
    `errs=${String(pageErrors.length + consoleErrors.length)}`);
  await page.close();
}

await browser.close();

const firstFail = results.find((r) => r.rendered === false);
console.log("\n=== SUMMARY ===");
for (const r of results) console.log(`  step ${String(r.step).padStart(2)}: ${r.rendered ? "RENDERED" : "BLANK"}`);
console.log(firstFail ? `\nFIRST BLANK STEP: ${String(firstFail.step)}` : "\nno blank step found");
if (firstFail) console.log(JSON.stringify(firstFail, null, 2));
