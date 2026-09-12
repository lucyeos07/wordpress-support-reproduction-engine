/**
 * Phase 0 CLI spike.
 *
 * Purpose: establish experimentally what the Playground CLI exposes to an
 * automated verifier. This is a spike, not product code. It deliberately
 * prints raw observations instead of adapting them to a model.
 *
 * Run: npx tsx spike/cli/run.ts [--fatal]
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCLI } from "@wp-playground/cli";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

interface Observation {
  label: string;
  ok: boolean;
  detail: unknown;
}

const observations: Observation[] = [];
function record(label: string, ok: boolean, detail: unknown): void {
  observations.push({ label, ok, detail });
  console.log(`[${ok ? "OK  " : "FAIL"}] ${label}`);
  if (detail !== undefined) console.log(indent(JSON.stringify(detail, null, 2)));
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => "       " + l)
    .join("\n");
}

const wantFatal = process.argv.includes("--fatal");

// --blueprint=<path> so the same introspection can be pointed at a v2
// Blueprint. `run-blueprint` reports nothing, so an exit code alone never
// proves a plugin installed; this spike checks the booted site instead.
const blueprintArg = process.argv.find((a) => a.startsWith("--blueprint="));
const blueprintPath = blueprintArg
  ? resolve(process.cwd(), blueprintArg.slice("--blueprint=".length))
  : resolve(repoRoot, "spike/blueprints/minimal.v1.json");

console.log(`blueprint: ${blueprintPath}`);
const blueprint = JSON.parse(readFileSync(blueprintPath, "utf8")) as Record<string, unknown>;

const started = Date.now();

const server = await runCLI({
  command: "server",
  blueprint: blueprint as never,
  port: 9401,
  verbosity: "quiet",
  skipBrowser: true,
});

record("boot: runCLI({command:'server'}) resolved", true, {
  serverUrl: server.serverUrl,
  bootSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
});

const php = server.playground;

/**
 * Run PHP inside the booted site and return the raw PHPResponse fields.
 * PHP.run() THROWS on a PHP fatal instead of returning a response, so the
 * throw path is captured rather than allowed to escape.
 */
async function runPhp(code: string): Promise<Record<string, unknown>> {
  try {
    const res = await php.run({ code });
    return {
      threw: false,
      exitCode: res.exitCode,
      text: res.text,
      errors: res.errors,
      httpStatusCode: res.httpStatusCode,
    };
  } catch (e) {
    const err = e as Error & { response?: { httpStatusCode?: number; text?: string; errors?: string } };
    return {
      threw: true,
      jsErrorName: err.name,
      jsErrorConstructor: err.constructor?.name,
      jsErrorMessage: err.message,
      ownEnumerableKeys: Object.keys(err),
      responseHttpStatusCode: err.response?.httpStatusCode,
      responseText: err.response?.text,
      responseErrors: err.response?.errors,
    };
  }
}

// --- What does the runtime expose about installed/active plugins? ---
const pluginProbe = await runPhp(`<?php
require_once '/wordpress/wp-load.php';
require_once '/wordpress/wp-admin/includes/plugin.php';
echo json_encode([
  'all_plugins'    => array_keys(get_plugins()),
  'active_plugins' => get_option('active_plugins'),
  'wp_version'     => get_bloginfo('version'),
  'php_version'    => PHP_VERSION,
], JSON_PRETTY_PRINT);
`);
record("introspect: installed + active plugins via PHP", pluginProbe["exitCode"] === 0, pluginProbe);

// --- Is there a structured error channel on PHPResponse? ---
const errorProbe = await runPhp(`<?php
require_once '/wordpress/wp-load.php';
throw new RuntimeException('phase-0-probe-uncaught');
`);
record("error channel: uncaught exception shape", true, {
  exitCode: errorProbe["exitCode"],
  errorsFieldType: typeof errorProbe["errors"],
  errorsFieldValue: errorProbe["errors"],
  textPrefix: String(errorProbe["text"] ?? "").slice(0, 400),
});

// --- Fatal on activation ---
if (wantFatal) {
  await php.mkdir("/wordpress/wp-content/plugins/phase0-fatal");
  await php.writeFile(
    "/wordpress/wp-content/plugins/phase0-fatal/phase0-fatal.php",
    `<?php
/**
 * Plugin Name: Phase 0 Fatal On Activation
 */
register_activation_hook(__FILE__, function () {
    phase0_function_that_does_not_exist();
});
`,
  );

  const activate = await runPhp(`<?php
require_once '/wordpress/wp-load.php';
require_once '/wordpress/wp-admin/includes/plugin.php';
$result = activate_plugin('phase0-fatal/phase0-fatal.php');
echo json_encode([
  'is_wp_error' => is_wp_error($result),
  'result'      => is_wp_error($result) ? $result->get_error_message() : $result,
  'active_now'  => get_option('active_plugins'),
], JSON_PRETTY_PRINT);
`);
  record("fatal activation: does failure surface?", true, activate);

  const debugLog = await runPhp(`<?php
$p = '/wordpress/wp-content/debug.log';
echo file_exists($p) ? file_get_contents($p) : '((no debug.log))';
`);
  record("fatal activation: debug.log contents", true, {
    text: String(debugLog["text"] ?? "").slice(0, 1500),
  });
}

console.log("\n=== SUMMARY ===");
console.log(JSON.stringify({ totalSeconds: Number(((Date.now() - started) / 1000).toFixed(1)), observations }, null, 2));

await server[Symbol.asyncDispose]();
process.exit(0);
