/**
 * Phase 5 spike: execute real ReproPlans in Playground and print the
 * Verification, plus a controlled proof that a genuine fatal is detected.
 *
 * Run: npx tsx spike/execute/run.ts
 */
import { runCLI } from "@wp-playground/cli";
import { executePlan } from "../../src/execute/cli-runner.js";
import { buildSamplePlan } from "./sample.js";
import { newEntries, firstFatal, compareSignature } from "../../src/execute/log-evidence.js";

console.log("=== A. plan ===");
const { plan, verificationPlan } = buildSamplePlan();
console.log("  tier:", plan.verdict.tier, plan.verdict.status);
console.log("  targets:", plan.targets.map((t) => `#${t.signatureIndex} ${t.trigger?.kind ?? "-"}`).join(", "));
console.log("  blueprint plugins:", JSON.stringify((plan.blueprint as { plugins: unknown[] }).plugins));

console.log("\n=== B. execute ===");
const started = Date.now();
const verification = await executePlan(plan, verificationPlan, {
  port: 9521,
  onProgress: (m) => console.log("   ·", m),
});
console.log(`   seconds: ${((Date.now() - started) / 1000).toFixed(1)}`);
console.log(JSON.stringify(verification, null, 2));

console.log("\n=== C. controlled proof that a REAL fatal is detected ===");
// The reported fatal above is synthetic: Classic Editor does not actually
// contain that function call, so B cannot observe it. This section installs a
// plugin that genuinely fatals on activation and runs the identical
// snapshot/diff/extract/compare pipeline, so the detection path is proven
// against a real runtime error rather than only against fixture text.
const server = await runCLI({
  command: "server",
  blueprint: {
    $schema: "https://playground.wordpress.net/blueprint-schema.json",
    version: 2,
    wordpressVersion: "6.8.2",
    phpVersion: "8.2",
    plugins: [],
    constants: { WP_DEBUG: true, WP_DEBUG_LOG: true },
  } as never,
  port: 9522,
  verbosity: "quiet",
  skipBrowser: true,
});
const php = server.playground;

await php.mkdir("/wordpress/wp-content/plugins/phase5-fatal");
await php.writeFile(
  "/wordpress/wp-content/plugins/phase5-fatal/phase5-fatal.php",
  `<?php
/**
 * Plugin Name: Phase 5 Fatal On Activation
 */
register_activation_hook(__FILE__, function () {
    phase5_function_that_does_not_exist();
});
`,
);

const readLog = async (): Promise<string> => {
  const r = await php.run({
    code: `<?php $p='/wordpress/wp-content/debug.log'; echo file_exists($p)?file_get_contents($p):'';`,
  });
  return String(r.text);
};

const before = await readLog();
try {
  await php.run({
    code: `<?php
require_once '/wordpress/wp-load.php';
require_once '/wordpress/wp-admin/includes/plugin.php';
activate_plugin('phase5-fatal/phase5-fatal.php');`,
  });
} catch {
  // Expected: PHP.run() throws on a fatal.
}
const after = await readLog();

const added = newEntries(before, after);
const extracted = firstFatal(added);
console.log("  new entries:", added.length);
console.log("  extracted  :", JSON.stringify({
  errorClass: extracted?.errorClass,
  message: extracted?.message,
  file: extracted?.file,
  line: extracted?.line,
  extraction: extracted?.extraction,
}, null, 2));

if (extracted) {
  const match = compareSignature(extracted, {
    errorClass: "Error",
    message: "Call to undefined function phase5_function_that_does_not_exist()",
    file: "/var/www/html/wp-content/plugins/phase5-fatal/phase5-fatal.php",
  });
  console.log("  comparison :", JSON.stringify(match));
  console.log("  OBSERVED   :", match.matches);

  const wrong = compareSignature(extracted, {
    errorClass: "TypeError",
    message: "something entirely different",
    file: "/var/www/html/wp-content/themes/storefront/functions.php",
  });
  console.log("  negative control (different reported signature):", JSON.stringify(wrong));
}

// Boot noise must never count as reproduction.
console.log("  boot-only diff (before vs before):", newEntries(before, before).length, "entries");

await server[Symbol.asyncDispose]();
process.exit(0);
