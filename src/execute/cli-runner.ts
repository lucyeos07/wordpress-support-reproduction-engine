/**
 * Executes a ReproPlan in a real Playground instance via the CLI surface and
 * produces a `Verification` (docs/SPEC.md §9).
 *
 * Three things are kept apart and never collapsed (§9.1):
 *   1. environment reconstruction — did it boot, and what actually installed
 *   2. trigger execution        — was this target's trigger actually run
 *   3. failure reproduction     — did the reported failure appear because of it
 *
 * Reproduction is established only by diffing debug.log around the trigger.
 * Entries already present before the trigger ran are never evidence, which is
 * what stops a boot-time error from being reported as a reproduction
 * (docs/phase-0-findings.md §5).
 */
import { runCLI } from "@wp-playground/cli";
import type { ReproPlan } from "../types/repro.js";
import type { TargetVerification, Verification } from "../types/verification.js";
import type { VerificationPlan } from "../repro/verification-plan.js";
import { newEntries, firstFatal, compareSignature } from "./log-evidence.js";

const DEBUG_LOG = "/wordpress/wp-content/debug.log";

export interface ExecuteOptions {
  port?: number;
  /** Surfaces raw progress for spikes and CI logs. */
  onProgress?: (message: string) => void;
}

interface Runner {
  php: {
    run(options: { code: string }): Promise<{ text: string }>;
    request(options: { url: string }): Promise<{ text: string; httpStatusCode: number }>;
  };
  dispose(): Promise<void>;
}

/** PHP.run() throws on a fatal rather than returning, so every call is wrapped. */
async function safeRun(runner: Runner, code: string): Promise<{ text: string; threw: boolean }> {
  try {
    const result = await runner.php.run({ code });
    return { text: String(result.text), threw: false };
  } catch {
    return { text: "", threw: true };
  }
}

async function readDebugLog(runner: Runner): Promise<string> {
  const result = await safeRun(
    runner,
    `<?php $p='${DEBUG_LOG}'; echo file_exists($p) ? file_get_contents($p) : '';`,
  );
  return result.text;
}

interface SiteState {
  installed: string[];
  active: string[];
}

async function readSiteState(runner: Runner): Promise<SiteState | undefined> {
  const result = await safeRun(
    runner,
    `<?php
require_once '/wordpress/wp-load.php';
require_once '/wordpress/wp-admin/includes/plugin.php';
$all = get_plugins();
$out = [];
foreach ($all as $file => $data) {
  $out[] = $file . '|' . ($data['Version'] ?? '');
}
echo json_encode(['installed' => $out, 'active' => array_values(get_option('active_plugins', []))]);`,
  );
  if (result.threw || result.text.trim() === "") return undefined;
  try {
    return JSON.parse(result.text) as SiteState;
  } catch {
    return undefined;
  }
}

/** `classic-editor@1.6.3` → slug `classic-editor`, version `1.6.3` */
function splitReference(reference: string): { slug: string; version?: string } {
  const [slug, version] = reference.split("@");
  return { slug: slug ?? reference, ...(version !== undefined ? { version } : {}) };
}

/**
 * Compares what the plan asked for against what WordPress actually reports.
 * A component counts as installed only if WordPress lists it, and only at the
 * requested version when one was pinned.
 */
function reconcileComponents(
  requested: string[],
  state: SiteState | undefined,
): { installedComponents: string[]; failedComponents: string[] } {
  if (state === undefined) {
    return { installedComponents: [], failedComponents: [...requested] };
  }

  const bySlug = new Map<string, string>();
  for (const entry of state.installed) {
    const [file, version] = entry.split("|");
    const slug = (file ?? "").split("/")[0] ?? "";
    if (slug !== "") bySlug.set(slug, version ?? "");
  }
  const activeSlugs = new Set(state.active.map((f) => f.split("/")[0] ?? ""));

  const installedComponents: string[] = [];
  const failedComponents: string[] = [];

  for (const reference of requested) {
    const { slug, version } = splitReference(reference);
    const actual = bySlug.get(slug);

    if (actual === undefined) {
      failedComponents.push(`${reference} (not installed)`);
      continue;
    }
    if (version !== undefined && actual !== version) {
      // Phase 4.5 verified that pinning is exact, so a mismatch here is a real
      // divergence from the reported environment, not an expected fuzziness.
      failedComponents.push(`${reference} (installed ${actual} instead)`);
      continue;
    }
    installedComponents.push(
      `${reference}${activeSlugs.has(slug) ? " (active)" : " (installed, not active)"}`,
    );
  }

  return { installedComponents, failedComponents };
}

/**
 * Runs one target's trigger, returning the log written while it ran.
 *
 * `bootLog` is the log as it stood after boot. For a boot trigger that log IS
 * the product of the trigger, so it is diffed against an empty baseline. For
 * every other trigger it is the baseline, so boot noise is excluded.
 */
async function executeTrigger(
  runner: Runner,
  target: ReproPlan["targets"][number],
  bootLog: string,
): Promise<{ executed: boolean; before: string; after: string; note?: string }> {
  const trigger = target.trigger;
  if (trigger === undefined) return { executed: false, before: bootLog, after: bootLog };

  if (trigger.kind === "boot") {
    return { executed: true, before: "", after: bootLog };
  }

  if (trigger.kind === "plugin_activation") {
    // The Blueprint already activated the plugin at boot, so the activation
    // must be re-run to be observed. Deactivating first is what makes the
    // activation executable; it is not identical to a first-ever activation,
    // and that caveat is recorded on the result.
    await safeRun(
      runner,
      `<?php
require_once '/wordpress/wp-load.php';
require_once '/wordpress/wp-admin/includes/plugin.php';
$all = array_keys(get_plugins());
foreach ($all as $file) {
  if (strpos($file, ${JSON.stringify(trigger.slug)} . '/') === 0) { deactivate_plugins($file); }
}`,
    );

    const before = await readDebugLog(runner);

    await safeRun(
      runner,
      `<?php
require_once '/wordpress/wp-load.php';
require_once '/wordpress/wp-admin/includes/plugin.php';
$all = array_keys(get_plugins());
foreach ($all as $file) {
  if (strpos($file, ${JSON.stringify(trigger.slug)} . '/') === 0) { activate_plugin($file); }
}`,
    );

    return {
      executed: true,
      before,
      after: await readDebugLog(runner),
      note: "the plugin was deactivated and re-activated so the activation could be executed; this is not identical to a first-ever activation",
    };
  }

  // admin_page_load
  const before = await readDebugLog(runner);
  try {
    await runner.php.request({ url: trigger.path });
  } catch {
    // A fatal during the request is the expected outcome; the log is evidence.
  }
  return { executed: true, before, after: await readDebugLog(runner) };
}

export async function executePlan(
  plan: ReproPlan,
  verificationPlan: VerificationPlan,
  options: ExecuteOptions = {},
): Promise<Verification> {
  const progress = options.onProgress ?? ((): void => {});
  const requested = verificationPlan.environmentChecks.expectedInstalledComponents;

  let runner: Runner | undefined;
  let bootSucceeded = false;
  let bootFailure: string | undefined;

  try {
    progress("booting");
    const server = await runCLI({
      command: "server",
      blueprint: plan.blueprint as never,
      port: options.port ?? 9500,
      verbosity: "quiet",
      skipBrowser: true,
    });
    runner = {
      php: server.playground as unknown as Runner["php"],
      dispose: async () => {
        await server[Symbol.asyncDispose]();
      },
    };
    bootSucceeded = true;
  } catch (error) {
    // Phase 4.5: one unavailable plugin version aborts the whole boot. The
    // failure is attributed rather than swallowed, and nothing is reported as
    // installed.
    bootFailure = String((error as Error).message).slice(0, 500);
    progress(`boot failed: ${bootFailure}`);
  }

  if (!runner) {
    return {
      environment: {
        bootSucceeded: false,
        installedComponents: [],
        failedComponents: requested.map((r) => `${r} (boot failed)`),
      },
      failureReproduction: {
        targets: plan.targets.map((target) => ({
          signatureIndex: target.signatureIndex,
          attempted: false,
          observed: false,
          reason: `the environment did not boot, so no trigger could be executed: ${bootFailure ?? "unknown error"}`,
        })),
      },
    };
  }

  try {
    const state = await readSiteState(runner);
    const { installedComponents, failedComponents } = reconcileComponents(requested, state);
    progress(`installed ${String(installedComponents.length)}, failed ${String(failedComponents.length)}`);

    const bootLog = await readDebugLog(runner);
    const targets: TargetVerification[] = [];

    for (const target of plan.targets) {
      const expected =
        verificationPlan.targets.find((t) => t.signatureIndex === target.signatureIndex)
          ?.expectedSignature ?? {};

      // The planner already decided this target is not executable. Executing
      // something else to fill the slot would be fabrication.
      if (!target.attempted) {
        targets.push({
          signatureIndex: target.signatureIndex,
          attempted: false,
          observed: false,
          ...(target.reason !== undefined ? { reason: target.reason } : {}),
        });
        continue;
      }

      progress(`target ${String(target.signatureIndex)}: ${target.trigger?.kind ?? "none"}`);
      const run = await executeTrigger(runner, target, bootLog);
      const added = newEntries(run.before, run.after);
      const extracted = firstFatal(added);

      if (extracted === undefined) {
        targets.push({
          signatureIndex: target.signatureIndex,
          attempted: run.executed,
          ...(target.trigger !== undefined ? { trigger: target.trigger } : {}),
          observed: false,
          logs: added,
          reason:
            added.length === 0
              ? "the trigger ran and wrote no new debug.log entries"
              : "the trigger ran and wrote new entries, but none was an extractable PHP fatal",
        });
        continue;
      }

      const comparison = compareSignature(extracted, expected);
      const reasonParts = [
        comparison.matches
          ? `matched the reported signature on ${comparison.matchedOn.join(", ")}`
          : comparison.mismatchedOn.length > 0
            ? `a new fatal appeared but disagreed with the reported signature on ${comparison.mismatchedOn.join(", ")}`
            : "a new fatal appeared but no reported field could be compared against it",
        ...(run.note !== undefined ? [run.note] : []),
      ];

      targets.push({
        signatureIndex: target.signatureIndex,
        attempted: run.executed,
        ...(target.trigger !== undefined ? { trigger: target.trigger } : {}),
        // observed requires BOTH that the trigger ran and that what it produced
        // matches what was reported (§9.1).
        observed: run.executed && comparison.matches,
        ...(extracted.errorClass !== undefined ? { errorClass: extracted.errorClass } : {}),
        ...(extracted.message !== undefined ? { message: extracted.message } : {}),
        logs: added,
        extraction: extracted.extraction,
        reason: reasonParts.join("; "),
      });
    }

    return {
      environment: { bootSucceeded, installedComponents, failedComponents },
      failureReproduction: { targets },
    };
  } finally {
    await runner.dispose();
  }
}
