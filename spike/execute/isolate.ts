/**
 * Isolates demo B's boot failure against a real Playground.
 *
 * Demo B analyses cleanly but its environment never boots, so every target
 * reads "Environment failed". This runs the bisection for real and prints the
 * component responsible, plus the attempts that prove it.
 *
 * Run: npx tsx spike/execute/isolate.ts [fixture]
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../../src/ui/analyze.js";
import { probeBoot } from "../../src/execute/cli-runner.js";
import { isolateBootFailure, summariseIsolation, type BootAttempt } from "../../src/execute/isolate.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const fixture = process.argv[2] ?? "fixtures/demos/demo-b-plugin-fatal.txt";

const analysis = analyze(readFileSync(resolve(root, fixture), "utf8"), "auto");
const blueprint = analysis.plan.blueprint as { plugins?: Array<{ source: string }> };
const components = (blueprint.plugins ?? []).map((p) => p.source);

console.log(`fixture: ${fixture}`);
console.log(`requested components (${String(components.length)}): ${components.join(", ")}\n`);

let port = 9640;
const started = Date.now();
const result = await isolateBootFailure(
  components,
  (subset): Promise<BootAttempt> => {
    port += 1;
    return probeBoot(analysis.plan, subset, { port });
  },
  { onProgress: (m) => console.log(m) },
);

console.log(`\nattempts: ${String(result.used)} of a ${String(result.budget)} boot budget, in ${((Date.now() - started) / 1000).toFixed(1)}s`);
for (const attempt of result.attempts) {
  const label = attempt.components.length === 0 ? "(none)" : attempt.components.join(", ");
  console.log(`  ${attempt.bootSucceeded ? "BOOTED" : "FAILED"}  ${label}`);
  if (attempt.error !== undefined) console.log(`          ${attempt.error.split("\n")[0]?.slice(0, 120) ?? ""}`);
}
console.log(`\noutcome: ${JSON.stringify(result.outcome.kind)}`);
console.log(summariseIsolation(result));

// Assertion, so CI fails when the bisection stops working rather than when a
// human stops reading the output. Only the default fixture has a known answer.
const EXPECTED_CULPRIT = "wordfence@7.11.4";
if (fixture !== "fixtures/demos/demo-b-plugin-fatal.txt") process.exit(0);

if (result.outcome.kind === "environment") {
  // The control boot failed, so the run proves nothing about components. That
  // is an infrastructure failure, not a regression in the bisection.
  console.log("\n=== INFRASTRUCTURE FAILURE — not an isolation regression ===");
  console.log(`    the empty-component control did not boot: ${result.outcome.error.split("\n")[0] ?? ""}`);
  console.log("    Playground downloads WordPress at boot; see docs/phase-4.5-findings.md §6.");
  process.exit(1);
}

if (result.outcome.kind !== "component" || result.outcome.culprit !== EXPECTED_CULPRIT) {
  console.log(`\nFAIL: expected ${EXPECTED_CULPRIT} to be named as the culprit`);
  process.exit(1);
}

console.log(`\nPASS: ${EXPECTED_CULPRIT} named, confirmed by booting the other ${String(result.outcome.bootableWithout.length)} component(s)`);
