/**
 * Phase 5 parity spike: executes the SAME ReproPlan on both surfaces and
 * compares the two Verification results field by field.
 *
 * docs/SPEC.md §12 forbids assuming one surface from the other, so parity is
 * measured here rather than asserted by construction. Requires
 * `npx vite --config vite.spike.config.ts` serving spike/browser on :9500.
 */
import { chromium } from "playwright";
import { executePlan } from "../../src/execute/cli-runner.js";
import { buildSamplePlan } from "./sample.js";
import type { Verification } from "../../src/types/verification.js";

console.log("=== CLI surface ===");
const { plan, verificationPlan } = buildSamplePlan();
const cliStarted = Date.now();
const cli = await executePlan(plan, verificationPlan, {
  port: 9531,
  onProgress: (m) => console.log("   ·", m),
});
console.log(`   seconds: ${((Date.now() - cliStarted) / 1000).toFixed(1)}`);
console.log(JSON.stringify(cli, null, 2));

console.log("\n=== Browser surface ===");
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.text().startsWith("EXEC ")) console.log("   [page]", m.text().slice(0, 200));
});

const browserStarted = Date.now();
await page.goto("http://localhost:9500/execute.html", { waitUntil: "domcontentloaded" });
try {
  await page.waitForFunction(
    () => (window as unknown as Record<string, any>)["__EXEC__"]?.done === true,
    undefined,
    { timeout: 240_000 },
  );
} catch {
  console.log("   TIMED OUT");
}
const raw = await page.evaluate(() => (window as unknown as Record<string, unknown>)["__EXEC__"]);
await browser.close();

const result = raw as {
  verification?: Verification;
  error?: string;
  seconds?: number;
  proof?: Record<string, unknown>;
  proofError?: string;
};
console.log(`   seconds: ${((Date.now() - browserStarted) / 1000).toFixed(1)}`);
if (result.error !== undefined) console.log("   ERROR:", result.error);
console.log(JSON.stringify(result.verification, null, 2));

console.log("\n=== Browser controlled proof (real fatal) ===");
if (result.proofError !== undefined) console.log("   ERROR:", result.proofError);
console.log("   ", JSON.stringify(result.proof, null, 2));

console.log("\n=== Parity ===");
const web = result.verification;
if (!web) {
  console.log("   browser produced no verification; parity cannot be assessed");
  process.exit(1);
}

const checks: Array<[string, unknown, unknown]> = [
  ["bootSucceeded", cli.environment.bootSucceeded, web.environment.bootSucceeded],
  [
    "installedComponents",
    JSON.stringify(cli.environment.installedComponents),
    JSON.stringify(web.environment.installedComponents),
  ],
  [
    "failedComponents",
    JSON.stringify(cli.environment.failedComponents),
    JSON.stringify(web.environment.failedComponents),
  ],
  ["targetCount", cli.failureReproduction.targets.length, web.failureReproduction.targets.length],
];

for (let i = 0; i < cli.failureReproduction.targets.length; i += 1) {
  const a = cli.failureReproduction.targets[i];
  const b = web.failureReproduction.targets[i];
  checks.push([`target${String(i)}.attempted`, a?.attempted, b?.attempted]);
  checks.push([`target${String(i)}.observed`, a?.observed, b?.observed]);
  checks.push([`target${String(i)}.trigger`, JSON.stringify(a?.trigger), JSON.stringify(b?.trigger)]);
  checks.push([`target${String(i)}.errorClass`, a?.errorClass, b?.errorClass]);
  checks.push([`target${String(i)}.reason`, a?.reason, b?.reason]);
}

let divergences = 0;
for (const [label, a, b] of checks) {
  const same = a === b;
  if (!same) divergences += 1;
  console.log(`   ${same ? "==" : "!="} ${label}`);
  if (!same) {
    console.log(`        cli: ${String(a)}`);
    console.log(`        web: ${String(b)}`);
  }
}
console.log(`\n   divergences: ${String(divergences)} of ${String(checks.length)}`);
process.exit(0);
