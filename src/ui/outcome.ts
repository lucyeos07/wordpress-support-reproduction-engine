/**
 * Verification display semantics (docs/SPEC.md §9.1).
 *
 * The UI must never say "not reproducible" when the environment failed to boot
 * before the trigger could run. These four outcomes are mutually exclusive and
 * are the only things the UI is allowed to claim.
 */
import type { TargetVerification, Verification } from "../types/verification.js";

export type TargetOutcome =
  /** The environment never booted, so nothing could be attempted. */
  | "environment_failed"
  /** The environment booted, but this target had no executable trigger. */
  | "not_attempted"
  /** The trigger ran and the reported failure did not appear. */
  | "attempted_not_observed"
  /** The trigger ran and the reported failure appeared because of it. */
  | "reproduced";

export function targetOutcome(
  verification: Verification,
  target: TargetVerification,
): TargetOutcome {
  // Order matters. A failed boot outranks everything: a target that was never
  // attempted because the site did not exist says nothing about the bug.
  if (!verification.environment.bootSucceeded) return "environment_failed";
  if (!target.attempted) return "not_attempted";
  if (target.observed) return "reproduced";
  return "attempted_not_observed";
}

export interface OutcomePresentation {
  label: string;
  /** Longer sentence shown under the label. */
  detail: string;
  /** Drives the status colour; never used alone to convey meaning. */
  tone: "ok" | "warn" | "fail" | "neutral";
}

export function presentOutcome(outcome: TargetOutcome): OutcomePresentation {
  switch (outcome) {
    case "environment_failed":
      return {
        label: "Environment failed",
        detail:
          "The environment did not boot, so this target's trigger was never run. This says nothing about whether the reported failure is reproducible.",
        tone: "fail",
      };
    case "not_attempted":
      return {
        label: "Trigger not attempted",
        detail:
          "The environment booted, but no supported trigger could be executed for this signature. The reported failure was neither confirmed nor ruled out.",
        tone: "warn",
      };
    case "attempted_not_observed":
      return {
        label: "Trigger attempted, failure not observed",
        detail:
          "The trigger ran against the reconstructed environment and the reported failure did not appear in the newly written log entries.",
        tone: "warn",
      };
    case "reproduced":
      return {
        label: "Failure reproduced",
        detail:
          "The trigger ran and produced a new log entry matching the reported signature.",
        tone: "ok",
      };
  }
}

/** Plan-level summary, derived only from the per-target outcomes. */
export function summariseOutcomes(outcomes: TargetOutcome[]): string {
  if (outcomes.length === 0) return "No reproduction targets.";
  if (outcomes.every((o) => o === "environment_failed")) {
    return "The environment failed to boot; no target was attempted.";
  }
  const reproduced = outcomes.filter((o) => o === "reproduced").length;
  const attempted = outcomes.filter(
    (o) => o === "reproduced" || o === "attempted_not_observed",
  ).length;
  return `${String(reproduced)} of ${String(outcomes.length)} target(s) reproduced; ${String(attempted)} attempted.`;
}
