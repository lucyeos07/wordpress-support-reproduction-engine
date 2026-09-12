/**
 * Phase 0 spike: does enabling WP_DEBUG make a plugin activation fatal
 * recoverable as text, and can an error class / message / file / line be
 * extracted deterministically from it?
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCLI } from "@wp-playground/cli";

const here = dirname(fileURLToPath(import.meta.url));
const blueprint = JSON.parse(
  readFileSync(resolve(here, "../blueprints/debug.v1.json"), "utf8"),
) as Record<string, unknown>;

const server = await runCLI({
  command: "server",
  blueprint: blueprint as never,
  port: 9403,
  verbosity: "quiet",
  skipBrowser: true,
});
const php = server.playground;

await php.mkdir("/wordpress/wp-content/plugins/phase0-fatal");
await php.writeFile(
  "/wordpress/wp-content/plugins/phase0-fatal/phase0-fatal.php",
  `<?php
/**
 * Plugin Name: Phase 0 Fatal On Activation
 */
register_activation_hook(__FILE__, function () {
    phase0_missing_function();
});
`,
);

console.log("=== A. activate_plugin() via php.run() ===");
let thrownMessage = "";
try {
  await php.run({
    code: `<?php
require_once '/wordpress/wp-load.php';
require_once '/wordpress/wp-admin/includes/plugin.php';
activate_plugin('phase0-fatal/phase0-fatal.php');`,
  });
  console.log("resolved (no throw)");
} catch (e) {
  const err = e as Error & Record<string, unknown>;
  thrownMessage = String(err.message);
  const response = err["response"] as { httpStatusCode?: number; errors?: string } | undefined;
  console.log("threw. httpStatusCode:", response?.httpStatusCode);
  console.log("stderr field:", JSON.stringify(response?.errors));
  console.log("message:\n" + thrownMessage.slice(0, 900));
}

console.log("\n=== B. debug.log after the fatal ===");
const log = await php.run({
  code: `<?php $p='/wordpress/wp-content/debug.log'; echo file_exists($p)?file_get_contents($p):'((absent))';`,
});
console.log(String(log.text).slice(0, 900));

console.log("\n=== C. deterministic extraction attempt from thrown message ===");
const decoded = thrownMessage
  .replace(/<br\s*\/?>/g, "\n")
  .replace(/<\/?b>/g, "")
  .replace(/&quot;/g, '"')
  .replace(/&gt;/g, ">")
  .replace(/&lt;/g, "<")
  .replace(/&amp;/g, "&");
const m = /Uncaught\s+([A-Za-z_\\][A-Za-z0-9_\\]*)\s*:\s*([\s\S]*?)\s+in\s+(\/[^\s:]+):(\d+)/.exec(decoded);
console.log(
  JSON.stringify(
    m
      ? { errorClass: m[1], message: m[2], file: m[3], line: Number(m[4]) }
      : { extracted: false, reason: "pattern did not match" },
    null,
    2,
  ),
);

await server[Symbol.asyncDispose]();
process.exit(0);
