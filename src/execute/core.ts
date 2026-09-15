/**
 * Surface-agnostic execution core (docs/SPEC.md §9).
 *
 * Everything here works against a `PlaygroundRunner` — a minimal view of a
 * booted Playground instance — so the CLI and the browser produce Verification
 * results by the same code path rather than by two implementations that could
 * drift. It deliberately has no Node imports, because it also runs in a page.
 *
 * SPEC §12 still applies: sharing the orchestration does not mean assuming the
 * two surfaces behave alike. Whether they do is a measured result, not a
 * design assumption — see docs/phase-5-browser-findings.md.
 */
import type { ReproPlan } from "../types/repro.js";
import type { TargetVerification, Verification } from "../types/verification.js";
import type { VerificationPlan } from "../repro/verification-plan.js";
import { newEntries, firstFatal, compareSignature } from "./log-evidence.js";

export const DEBUG_LOG = "/wordpress/wp-content/debug.log";

/** The capabilities both surfaces expose, and nothing more. */
export interface PlaygroundRunner {
  run(options: { code: string }): Promise<{ text: string }>;
  request(options: { url: string }): Promise<{ text: string }>;
}

/** PHP.run() throws on a fatal rather than returning, so every call is wrapped. */
export async function safeRun(
  runner: PlaygroundRunner,
  code: string,
): Promise<{ text: string; threw: boolean }> {
  try {
    const result = await runner.run({ code });
    return { text: String(result.text), threw: false };
  } catch {
    return { text: "", threw: true };
  }
}

export async function readDebugLog(runner: PlaygroundRunner): Promise<string> {
  const result = await safeRun(
    runner,
    `<?php $p='${DEBUG_LOG}'; echo file_exists($p) ? file_get_contents($p) : '';`,
  );
  return result.text;
}

export interface SiteState {
  installed: string[];
  active: string[];
}

/** Asks WordPress what is on disk and what is active, never the Blueprint. */
export async function readSiteState(runner: PlaygroundRunner): Promise<SiteState | undefined> {
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
export function splitReference(reference: string): { slug: string; version?: string } {
  const [slug, version] = reference.split("@");
  return { slug: slug ?? reference, ...(version !== undefined ? { version } : {}) };
}

/**
 * Compares what the plan asked for against what WordPress actually reports.
 * A component counts as installed only if WordPress lists it, and only at the
 * requested version when one was pinned.
 */
export function reconcileComponents(
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
      // Phase 4.5 verified pinning is exact, so a mismatch is a real
      // divergence from the reported environment, not expected fuzziness.
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
export async function executeTrigger(
  runner: PlaygroundRunner,
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
    await runner.request({ url: trigger.path });
  } catch {
    // A fatal during the request is the expected outcome; the log is evidence.
  }
  return { executed: true, before, after: await readDebugLog(runner) };
}

/**
 * Produces the Verification for a booted instance. Callers supply the runner;
 * booting and teardown are surface-specific and stay outside.
 */
export async function verifyAgainstRunner(
  runner: PlaygroundRunner,
  plan: ReproPlan,
  verificationPlan: VerificationPlan,
  progress: (message: string) => void = () => {},
): Promise<Verification> {
  const requested = verificationPlan.environmentChecks.expectedInstalledComponents;

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
    environment: { bootSucceeded: true, installedComponents, failedComponents },
    failureReproduction: { targets },
  };
}

/** The Verification produced when the instance never booted. */
export function bootFailureVerification(
  plan: ReproPlan,
  requested: string[],
  bootFailure: string,
): Verification {
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
        reason: `the environment did not boot, so no trigger could be executed: ${bootFailure}`,
      })),
    },
  };
}
