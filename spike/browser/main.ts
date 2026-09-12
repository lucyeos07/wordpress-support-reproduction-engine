/**
 * Phase 0 browser spike. No product UI.
 *
 * Establishes what the official browser embedding API exposes to the host page:
 * readiness, per-step events, component install/activation state, logs, and
 * whether a plugin activation fatal is observable in any structured form.
 *
 * Results are mirrored to window.__PHASE0__ so an automated driver can read them.
 */
import { startPlaygroundWeb } from "@wp-playground/client";
import minimalV1 from "../blueprints/minimal.v1.json";
import debugV1 from "../blueprints/debug.v1.json";
import minimalV2 from "../blueprints/minimal.v2.json";

// ?debug=1 boots the WP_DEBUG variant to test whether debug.log is readable
// from the browser the way it is from the CLI.
const params = new URLSearchParams(location.search);
const useDebugBlueprint = params.has("debug");
const useV2Blueprint = params.has("v2");
const chosenBlueprint = useV2Blueprint ? minimalV2 : useDebugBlueprint ? debugV1 : minimalV1;

interface Step {
  label: string;
  ok: boolean;
  detail: unknown;
}

const results: { steps: Step[]; done: boolean; fatalError?: string } = { steps: [], done: false };
(window as unknown as Record<string, unknown>)["__PHASE0__"] = results;

const logEl = document.getElementById("log") as HTMLPreElement;
function record(label: string, ok: boolean, detail: unknown): void {
  results.steps.push({ label, ok, detail });
  logEl.textContent += `\n[${ok ? "OK  " : "FAIL"}] ${label}\n${JSON.stringify(detail, null, 2)}\n`;
  console.log(`PHASE0 ${ok ? "OK" : "FAIL"} ${label}`, detail);
}

const iframe = document.getElementById("wp") as HTMLIFrameElement;
const t0 = performance.now();

const stepEvents: Array<{ step: string; output: unknown }> = [];

try {
  const client = await startPlaygroundWeb({
    iframe,
    remoteUrl: "https://playground.wordpress.net/remote.html",
    blueprint: chosenBlueprint as never,
    onBlueprintValidated: (bp) => {
      record("onBlueprintValidated fired", true, { keys: Object.keys(bp as object) });
    },
    onBlueprintStepCompleted: (output: unknown, step: unknown) => {
      const s = step as { step?: string };
      stepEvents.push({ step: s?.step ?? "(unknown)", output });
      console.log("PHASE0 step completed", s?.step, output);
    },
  });

  record("startPlaygroundWeb resolved", true, {
    bootSeconds: Number(((performance.now() - t0) / 1000).toFixed(1)),
  });

  // Readiness signal
  await client.isReady();
  record("client.isReady() resolved", true, { bootSeconds: Number(((performance.now() - t0) / 1000).toFixed(1)) });

  record("onBlueprintStepCompleted events observed", stepEvents.length > 0, stepEvents);

  // Runtime state inspection
  const info = await client.run({
    code: `<?php
require_once '/wordpress/wp-load.php';
require_once '/wordpress/wp-admin/includes/plugin.php';
echo json_encode([
  'all_plugins'    => array_keys(get_plugins()),
  'active_plugins' => get_option('active_plugins'),
  'wp_version'     => get_bloginfo('version'),
  'php_version'    => PHP_VERSION,
]);`,
  });
  record("installed + active components via client.run()", true, {
    exitCode: info.exitCode,
    httpStatusCode: info.httpStatusCode,
    errors: info.errors,
    text: info.text,
  });

  // Does the browser client expose a fatal in any structured way?
  await client.mkdir("/wordpress/wp-content/plugins/phase0-fatal");
  await client.writeFile(
    "/wordpress/wp-content/plugins/phase0-fatal/phase0-fatal.php",
    `<?php
/**
 * Plugin Name: Phase 0 Fatal On Activation
 */
register_activation_hook(__FILE__, function () {
    phase0_browser_missing_function();
});
`,
  );
  record("wrote failing plugin into VFS", true, null);

  try {
    const activation = await client.run({
      code: `<?php
require_once '/wordpress/wp-load.php';
require_once '/wordpress/wp-admin/includes/plugin.php';
$r = activate_plugin('phase0-fatal/phase0-fatal.php');
echo json_encode(['is_wp_error' => is_wp_error($r)]);`,
    });
    record("plugin activation fatal: run() RESOLVED (did not throw)", true, {
      exitCode: activation.exitCode,
      httpStatusCode: activation.httpStatusCode,
      errors: activation.errors,
      text: String(activation.text).slice(0, 600),
    });
  } catch (e) {
    const err = e as Error & Record<string, unknown>;
    const response = err["response"] as { httpStatusCode?: number; errors?: string; text?: string } | undefined;
    record("plugin activation fatal: run() THREW", true, {
      constructor: err.constructor?.name,
      ownEnumerableKeys: Object.keys(err),
      originalErrorClassName: err["originalErrorClassName"],
      source: err["source"],
      responseHttpStatusCode: response?.httpStatusCode,
      responseErrors: response?.errors,
      message: String(err.message).slice(0, 900),
    });
  }

  // Is the PHP error text recoverable in the browser by any means?
  record(
    "client surface: method names",
    true,
    Object.keys(client as unknown as Record<string, unknown>).sort(),
  );

  try {
    await client.run({
      code: `<?php
ini_set('log_errors', '1');
ini_set('error_log', '/tmp/phase0-php-errors.log');
ini_set('display_errors', '1');
require_once '/wordpress/wp-load.php';
phase0_definitely_missing_function();`,
    });
    record("logged-fatal probe: unexpectedly resolved", false, null);
  } catch (e) {
    const err = e as Error & Record<string, unknown>;
    const response = err["response"] as { text?: string; errors?: string } | undefined;
    record("logged-fatal probe: threw", true, {
      message: String(err.message).slice(0, 300),
      responseText: String(response?.text ?? "").slice(0, 300),
      responseErrors: String(response?.errors ?? "").slice(0, 300),
    });
  }

  const logRead = await client.run({
    code: `<?php
$p='/tmp/phase0-php-errors.log';
echo file_exists($p) ? file_get_contents($p) : '((no error log file))';`,
  });
  record("logged-fatal probe: error_log file contents", true, {
    text: String(logRead.text).slice(0, 800),
  });

  // Does an HTTP request (rather than run()) expose the fatal body?
  await client.writeFile(
    "/wordpress/phase0-fatal-page.php",
    `<?php require_once '/wordpress/wp-load.php'; phase0_missing_on_request();`,
  );
  const httpResp = await client.request({ url: "/phase0-fatal-page.php" });
  record("fatal via client.request(): response shape", true, {
    httpStatusCode: httpResp.httpStatusCode,
    errors: String(httpResp.errors ?? "").slice(0, 300),
    text: String(httpResp.text ?? "").slice(0, 600),
  });

  const debugLog = await client.run({
    code: `<?php
$p='/wordpress/wp-content/debug.log';
echo file_exists($p) ? file_get_contents($p) : '((absent))';`,
  });
  record("debug.log readable from browser", true, {
    blueprintUsed: useV2Blueprint ? "minimal.v2.json" : useDebugBlueprint ? "debug.v1.json" : "minimal.v1.json",
    text: String(debugLog.text).slice(0, 900),
  });

  record("TOTAL", true, { seconds: Number(((performance.now() - t0) / 1000).toFixed(1)) });
} catch (e) {
  const err = e as Error;
  results.fatalError = `${err.name}: ${err.message}`;
  record("SPIKE ABORTED", false, { name: err.name, message: err.message, stack: err.stack?.slice(0, 800) });
}

results.done = true;
console.log("PHASE0 DONE");
