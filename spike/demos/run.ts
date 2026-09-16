/**
 * End-to-end demo runner.
 *
 * Runs each demo through the whole pipeline and asserts the expected outcome,
 * exiting non-zero on any mismatch. Demos A, B and D are artifact-driven and
 * need no network for the analysis half; C boots a real Playground instance.
 *
 * Run: npx tsx spike/demos/run.ts
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCLI } from "@wp-playground/cli";
import { analyze } from "../../src/ui/analyze.js";
import { executePlan } from "../../src/execute/cli-runner.js";
import { verifyAgainstRunner, type PlaygroundRunner } from "../../src/execute/core.js";
import { targetOutcome } from "../../src/ui/outcome.js";
import type { ReproPlan } from "../../src/types/repro.js";
import type { VerificationPlan } from "../../src/repro/verification-plan.js";

const here = dirname(fileURLToPath(import.meta.url));
const demos = resolve(here, "../../fixtures/demos");
const read = (f: string): string => readFileSync(resolve(demos, f), "utf8");

let failures = 0;
let infrastructureFailure: string | undefined;

/**
 * Booting downloads WordPress core and plugins, so it can fail for reasons that
 * have nothing to do with the demos — Phase 4.5 recorded exactly this. One
 * bounded retry, and a failure that survives it is reported as an
 * infrastructure failure rather than as a demo regression.
 */
async function boot<T>(label: string, start: () => Promise<T>): Promise<T | undefined> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await start();
    } catch (error) {
      const message = String((error as Error).message).split("\n")[0]?.slice(0, 160) ?? "";
      if (attempt === 2) {
        infrastructureFailure = `${label}: ${message}`;
        console.log(`   INFRA  ${label} failed to boot twice: ${message}`);
        return undefined;
      }
      console.log(`   retry  ${label} boot failed (${message}); retrying once`);
    }
  }
  return undefined;
}
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------- Demo A ---
console.log("\n=== Demo A — deterministic Finding from a System Status Report ===");
{
  const analysis = analyze(read("demo-a-php-requirement.txt"), "auto");
  const finding = analysis.diagnosis.findings.find((f) => f.ruleId === "PHP_BELOW_PLUGIN_REQUIREMENT");

  check("adapters that ran", analysis.format, ["ssr"]);
  check("finding emitted", finding !== undefined, true);
  check("severity", finding?.severity, "high");
  check("confidence", finding?.confidence, "high");
  check("evidence count", finding?.evidence.length, 2);
  check("cites the version's own readme",
    finding?.citations.some((c) => c.url.includes("plugins.svn.wordpress.org/woocommerce/tags/9.1.2")), true);
  check("no signature, so no reproduction target", analysis.plan.targets.length, 0);
  check("plan verdict", analysis.plan.verdict.tier, "E");
  console.log(`         cause: ${String(finding?.cause.split("\n").filter(Boolean).slice(-3).join(" | "))}`);
}

// ---------------------------------------------------------------- Demo B ---
console.log("\n=== Demo B — fatal with catalog-resolved plugin ownership ===");
{
  const analysis = analyze(read("demo-b-plugin-fatal.txt"), "auto");
  const finding = analysis.diagnosis.findings.find((f) => f.ruleId === "FATAL_PLUGIN_OWNER");
  const target = analysis.plan.targets[0];

  check("adapters that ran", analysis.format, ["ssr", "log"]);
  check("ownership resolved through the catalog", analysis.environment.signatures[0]?.owner.slug, "woocommerce");
  check("attribution confidence", analysis.environment.signatures[0]?.owner.confidence, "high");
  check("finding emitted", finding !== undefined, true);
  check("finding confidence follows attribution", finding?.confidence, "high");
  check("trigger is executable", target?.trigger, { kind: "plugin_activation", slug: "woocommerce" });
  check("target tier", target?.verdict.tier, "B");
  check("blueprint pins the reported version",
    (analysis.plan.blueprint as { plugins: Array<{ source: string }> }).plugins.some((p) => p.source === "woocommerce@8.5.2"), true);
}

// ---------------------------------------------------------------- Demo D ---
console.log("\n=== Demo D — honest limitations ===");
{
  const analysis = analyze(read("demo-d-limitations.txt"), "auto");
  const omitted = analysis.plan.omissions.map((o) => o.component);

  check("premium plugin omitted, not installed",
    omitted.some((c) => c.includes("WooCommerce Subscriptions")), true);
  check("unresolved plugin omitted",
    omitted.some((c) => c.includes("Warehouse Sync Bridge")), true);
  check("theme omitted", omitted.some((c) => c.startsWith("theme ")), true);
  check("two independent targets", analysis.plan.targets.length, 2);
  check("theme target has no executable trigger", analysis.plan.targets[0]?.attempted, false);
  check("theme target is dependency-bound", analysis.plan.targets[0]?.verdict.tier, "D");
  check("unresolved-plugin target has no executable trigger", analysis.plan.targets[1]?.attempted, false);
  check("no slug was guessed for the unresolved plugin",
    analysis.environment.plugins.find((p) => p.name === "Warehouse Sync Bridge")?.slug, undefined);

  // The plan is honest about what it cannot do, but still reconstructs what it can.
  check("blueprint still installs what it can",
    (analysis.plan.blueprint as { plugins: unknown[] }).plugins.length > 0, true);
}

// ---------------------------------------------------------------- Demo C ---
try {
console.log("\n=== Demo C — real Playground run reaching observed = true ===");
console.log("   (controlled: the failing plugin is written into the instance —");
console.log("    see fixtures/demos/README.md for why no repository plugin is used)");
{
  const plan: ReproPlan = {
    verdict: { tier: "B", status: "reproducible" },
    targets: [
      {
        signatureIndex: 0,
        trigger: { kind: "plugin_activation", slug: "demo-fatal" },
        attempted: true,
        verdict: { tier: "B", status: "reproducible" },
        reasons: [],
      },
    ],
    reasons: [],
    substitutions: [],
    omissions: [],
    blueprint: {
      $schema: "https://playground.wordpress.net/blueprint-schema.json",
      version: 2,
      wordpressVersion: "6.8.2",
      phpVersion: "8.2",
      plugins: [],
      constants: { WP_DEBUG: true, WP_DEBUG_LOG: true },
    },
  };

  const verificationPlan: VerificationPlan = {
    environmentChecks: {
      expectedWordPressVersion: "6.8.2",
      expectedPhpVersion: "8.2",
      expectedInstalledComponents: [],
      expectedOmittedComponents: [],
      howToCheck: "read get_plugins() inside the booted site",
    },
    logStrategy: { source: "debug.log", path: "/wordpress/wp-content/debug.log", steps: [] },
    targets: [
      {
        signatureIndex: 0,
        attempted: true,
        trigger: { kind: "plugin_activation", slug: "demo-fatal" },
        expectedSignature: {
          errorClass: "Error",
          message: "Call to undefined function demo_missing_function()",
          file: "/var/www/html/wp-content/plugins/demo-fatal/demo-fatal.php",
        },
      },
    ],
  };

  const server = await boot("Demo C", () =>
    runCLI({
      command: "server",
      blueprint: plan.blueprint as never,
      port: 9611,
      verbosity: "quiet",
      skipBrowser: true,
    }),
  );
  if (!server) throw new Error("__infra__");
  const php = server.playground;

  await php.mkdir("/wordpress/wp-content/plugins/demo-fatal");
  await php.writeFile(
    "/wordpress/wp-content/plugins/demo-fatal/demo-fatal.php",
    `<?php
/**
 * Plugin Name: Demo Fatal On Activation
 */
register_activation_hook(__FILE__, function () {
    demo_missing_function();
});
`,
  );

  const verification = await verifyAgainstRunner(
    php as unknown as PlaygroundRunner,
    plan,
    verificationPlan,
  );
  await server[Symbol.asyncDispose]();

  const target = verification.failureReproduction.targets[0]!;
  check("boot succeeded", verification.environment.bootSucceeded, true);
  check("trigger attempted", target.attempted, true);
  check("OBSERVED", target.observed, true);
  check("error class extracted", target.errorClass, "Error");
  check("extraction is deterministic", target.extraction?.deterministic, true);
  check("extracted from debug.log", target.extraction?.source, "debug.log");
  check("outcome", targetOutcome(verification, target), "reproduced");
  console.log(`         message: ${String(target.message)}`);
}
} catch (e) {
  if (String((e as Error).message) !== "__infra__") throw e;
}

// --------------------------------------------------- observed = false ------
console.log("\n=== Demo B executed — observed = false, NOT an environment failure ===");
{
  const analysis = analyze(read("demo-b-plugin-fatal.txt"), "auto");
  // WooCommerce is 20 MB; swap in the small plugin so the demo stays quick
  // while still exercising the real executor end to end.
  const blueprint = analysis.plan.blueprint as { plugins: Array<{ source: string; active: boolean }> };
  blueprint.plugins = [{ source: "classic-editor@1.6.3", active: true }];
  const plan: ReproPlan = {
    ...analysis.plan,
    targets: [{ ...analysis.plan.targets[0]!, trigger: { kind: "plugin_activation", slug: "classic-editor" } }],
  };
  const verificationPlan: VerificationPlan = {
    ...analysis.verificationPlan,
    environmentChecks: { ...analysis.verificationPlan.environmentChecks, expectedInstalledComponents: ["classic-editor@1.6.3"] },
    targets: [{ ...analysis.verificationPlan.targets[0]!, trigger: { kind: "plugin_activation", slug: "classic-editor" } }],
  };

  const verification = await executePlan(plan, verificationPlan, { port: 9612 });
  const target = verification.failureReproduction.targets[0]!;

  check("boot succeeded", verification.environment.bootSucceeded, true);
  check("component installed", verification.environment.installedComponents, ["classic-editor@1.6.3 (active)"]);
  check("trigger attempted", target.attempted, true);
  check("OBSERVED is false", target.observed, false);
  // The distinction the product exists to make.
  check("outcome is NOT environment_failed", targetOutcome(verification, target), "attempted_not_observed");
  console.log(`         reason: ${String(target.reason)}`);
}

if (infrastructureFailure !== undefined) {
  console.log(`\n=== INFRASTRUCTURE FAILURE — not a demo regression ===`);
  console.log(`    ${infrastructureFailure}`);
  console.log("    Playground downloads WordPress core and plugins at boot; see");
  console.log("    docs/phase-4.5-findings.md §6.");
  process.exit(1);
}

console.log(`\n=== ${failures === 0 ? "ALL DEMOS PASSED" : `${String(failures)} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
