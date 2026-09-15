/**
 * Phase 5 browser execution spike: runs the SAME ReproPlan the CLI spike runs,
 * through the browser executor, and exposes the Verification for comparison.
 */
import { startPlaygroundWeb } from "@wp-playground/client";
import { buildSamplePlan } from "../execute/sample.js";
import { executePlanInBrowser, DEFAULT_REMOTE_URL } from "../../src/execute/browser-runner.js";
import { newEntries, firstFatal, compareSignature } from "../../src/execute/log-evidence.js";

const out: Record<string, unknown> = { done: false };
(window as unknown as Record<string, unknown>)["__EXEC__"] = out;

const logEl = document.getElementById("log") as HTMLPreElement;
const note = (m: string): void => {
  logEl.textContent += `\n· ${m}`;
  console.log(`EXEC ${m}`);
};

try {
  const { plan, verificationPlan } = buildSamplePlan();
  out["planTier"] = plan.verdict.tier;
  out["blueprint"] = plan.blueprint;
  note(`plan tier ${plan.verdict.tier}, ${plan.targets.length} target(s)`);

  const started = performance.now();
  const verification = await executePlanInBrowser(plan, verificationPlan, {
    iframe: document.getElementById("wp") as HTMLIFrameElement,
    onProgress: note,
  });

  out["seconds"] = Number(((performance.now() - started) / 1000).toFixed(1));
  out["verification"] = verification;
  logEl.textContent += `\n\n${JSON.stringify(verification, null, 2)}`;
  console.log("EXEC verification", JSON.stringify(verification));
} catch (e) {
  const err = e as Error;
  out["error"] = `${err.name}: ${err.message}`.slice(0, 600);
  note(`ERROR ${String(out["error"])}`);
}

// Controlled proof that a REAL fatal is detected on THIS surface. The reported
// fatal above is synthetic, so the main run can only ever produce
// observed:false. docs/SPEC.md §12 forbids assuming the CLI's positive result
// carries over, so it is measured here too.
try {
  note("proof: booting a second instance");
  const client = await startPlaygroundWeb({
    iframe: document.getElementById("wp") as HTMLIFrameElement,
    remoteUrl: DEFAULT_REMOTE_URL,
    blueprint: {
      $schema: "https://playground.wordpress.net/blueprint-schema.json",
      version: 2,
      wordpressVersion: "6.8.2",
      phpVersion: "8.2",
      plugins: [],
      constants: { WP_DEBUG: true, WP_DEBUG_LOG: true },
    } as never,
  });
  await client.isReady();

  await client.mkdir("/wordpress/wp-content/plugins/phase5-fatal");
  await client.writeFile(
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
    const r = await client.run({
      code: `<?php $p='/wordpress/wp-content/debug.log'; echo file_exists($p)?file_get_contents($p):'';`,
    });
    return String(r.text);
  };

  const before = await readLog();
  try {
    await client.run({
      code: `<?php
require_once '/wordpress/wp-load.php';
require_once '/wordpress/wp-admin/includes/plugin.php';
activate_plugin('phase5-fatal/phase5-fatal.php');`,
    });
  } catch {
    // Expected: run() throws on a fatal.
  }
  const after = await readLog();

  const added = newEntries(before, after);
  const extracted = firstFatal(added);
  const match =
    extracted !== undefined
      ? compareSignature(extracted, {
          errorClass: "Error",
          message: "Call to undefined function phase5_function_that_does_not_exist()",
          file: "/var/www/html/wp-content/plugins/phase5-fatal/phase5-fatal.php",
        })
      : undefined;
  const wrong =
    extracted !== undefined
      ? compareSignature(extracted, {
          errorClass: "TypeError",
          message: "something entirely different",
        })
      : undefined;

  out["proof"] = {
    newEntries: added.length,
    errorClass: extracted?.errorClass,
    message: extracted?.message,
    file: extracted?.file,
    line: extracted?.line,
    deterministic: extracted?.extraction.deterministic,
    observed: match?.matches ?? false,
    matchedOn: match?.matchedOn,
    negativeControlMatches: wrong?.matches,
    bootNoiseDiff: newEntries(before, before).length,
  };
  note(`proof observed=${String(match?.matches)} entries=${String(added.length)}`);
  console.log("EXEC proof", JSON.stringify(out["proof"]));
} catch (e) {
  out["proofError"] = String((e as Error).message).slice(0, 400);
  note(`proof ERROR ${String(out["proofError"])}`);
}

out["done"] = true;
console.log("EXEC DONE");
