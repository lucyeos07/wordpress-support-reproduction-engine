/**
 * Phase 4.5 spike: does `slug@version` in a Blueprint v2 `plugins` entry
 * actually install that exact version?
 *
 * The planner emits this form and capabilities.json records
 * versionPinnedVerified: false. This asks WordPress itself rather than
 * trusting the Blueprint parsing or the CLI exit status — Phase 0 established
 * that run-blueprint exits 0 silently and proves nothing.
 *
 * Run: npx tsx spike/version-pinning/cli.ts
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCLI } from "@wp-playground/cli";

const here = dirname(fileURLToPath(import.meta.url));
const blueprintDir = resolve(here, "../blueprints");

/** Latest at the time of the spike, per the plugin's own trunk readme. */
const LATEST = "1.7.0";
const PINNED = "1.6.3";

interface Probe {
  label: string;
  file: string;
  requested: string;
  port: number;
}

const probes: Probe[] = [
  { label: "pinned  (classic-editor@1.6.3)", file: "pinned.v2.json", requested: PINNED, port: 9411 },
  { label: "control (classic-editor)", file: "unpinned.v2.json", requested: "latest", port: 9412 },
];

for (const probe of probes) {
  const blueprint = JSON.parse(readFileSync(resolve(blueprintDir, probe.file), "utf8")) as Record<
    string,
    unknown
  >;

  const started = Date.now();
  const server = await runCLI({
    command: "server",
    blueprint: blueprint as never,
    port: probe.port,
    verbosity: "quiet",
    skipBrowser: true,
  });

  // Ask WordPress what is on disk. get_plugins() reads each plugin's own
  // header, so this is the installed version, not what we asked for.
  const result = await server.playground.run({
    code: `<?php
require_once '/wordpress/wp-load.php';
require_once '/wordpress/wp-admin/includes/plugin.php';
$all = get_plugins();
$classic = isset($all['classic-editor/classic-editor.php'])
  ? $all['classic-editor/classic-editor.php']
  : null;
echo json_encode([
  'installed'      => $classic !== null,
  'version'        => $classic['Version'] ?? null,
  'name'           => $classic['Name'] ?? null,
  'active_plugins' => get_option('active_plugins'),
  'all_plugin_files' => array_keys($all),
], JSON_PRETTY_PRINT);`,
  });

  const parsed = JSON.parse(String(result.text)) as {
    installed: boolean;
    version: string | null;
    active_plugins: string[];
  };

  const verdict =
    parsed.version === null
      ? "NOT INSTALLED"
      : parsed.version === probe.requested
        ? `EXACT MATCH (${parsed.version})`
        : parsed.version === LATEST
          ? `LATEST INSTALLED INSTEAD (${parsed.version}, requested ${probe.requested})`
          : `OTHER VERSION (${parsed.version}, requested ${probe.requested})`;

  console.log(`\n### ${probe.label}`);
  console.log(`   boot seconds     : ${((Date.now() - started) / 1000).toFixed(1)}`);
  console.log(`   requested        : ${probe.requested}`);
  console.log(`   installed version: ${parsed.version ?? "(absent)"}`);
  console.log(`   active           : ${JSON.stringify(parsed.active_plugins)}`);
  console.log(`   VERDICT          : ${verdict}`);

  await server[Symbol.asyncDispose]();
}

process.exit(0);
