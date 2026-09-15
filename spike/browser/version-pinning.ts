/**
 * Phase 4.5 browser spike: does `slug@version` pin the exact version in the
 * browser runtime, as it does on the CLI?
 *
 * ?blueprint=pinned|unpinned|missing selects which Blueprint to boot.
 */
import { startPlaygroundWeb } from "@wp-playground/client";
import pinned from "../blueprints/pinned.v2.json";
import unpinned from "../blueprints/unpinned.v2.json";
import missing from "../blueprints/missing-version.v2.json";

const which = new URLSearchParams(location.search).get("blueprint") ?? "pinned";
const blueprint = which === "unpinned" ? unpinned : which === "missing" ? missing : pinned;

const results: Record<string, unknown> = { which, done: false };
(window as unknown as Record<string, unknown>)["__PIN__"] = results;

const logEl = document.getElementById("log") as HTMLPreElement;
function log(label: string, detail: unknown): void {
  logEl.textContent += `\n${label}\n${JSON.stringify(detail, null, 2)}\n`;
  console.log(`PIN ${label}`, detail);
}

try {
  const client = await startPlaygroundWeb({
    iframe: document.getElementById("wp") as HTMLIFrameElement,
    remoteUrl: "https://playground.wordpress.net/remote.html",
    blueprint: blueprint as never,
  });
  await client.isReady();

  const probe = await client.run({
    code: `<?php
require_once '/wordpress/wp-load.php';
require_once '/wordpress/wp-admin/includes/plugin.php';
$all = get_plugins();
$classic = $all['classic-editor/classic-editor.php'] ?? null;
echo json_encode([
  'installed'      => $classic !== null,
  'version'        => $classic['Version'] ?? null,
  'active_plugins' => get_option('active_plugins'),
  'wp_version'     => get_bloginfo('version'),
  'php_version'    => PHP_VERSION,
]);`,
  });

  results["probe"] = JSON.parse(String(probe.text));
  log("probe", results["probe"]);
} catch (e) {
  const err = e as Error;
  results["error"] = `${err.name}: ${err.message}`.slice(0, 600);
  log("ERROR", results["error"]);
}

results["done"] = true;
console.log("PIN DONE");
