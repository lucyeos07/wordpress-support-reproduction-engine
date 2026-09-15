/** docs/SPEC.md §9 */

import type { ReproductionTrigger } from "./repro.js";

/**
 * Where a PHP error was read from, and whether reading it was deterministic.
 *
 * Phase 0 established that neither Playground surface exposes a structured PHP
 * error object, so `errorClass` and `message` are always extraction results,
 * never runtime-provided fields. §9 requires that the extraction method and its
 * determinism be representable, per target.
 */
export interface LogExtraction {
  source: "debug.log" | "thrown-error-message" | "response-stderr";
  /** False when the value came from anything other than a fixed pattern match. */
  deterministic: boolean;
  /** The pattern applied, recorded so a result can be re-derived and audited. */
  pattern?: string;
}

/**
 * One per `ReproTarget`, matched by `signatureIndex`.
 *
 * `observed` is true only when this target's trigger actually ran and a
 * matching entry appeared in the log written during that run — never inferred
 * from a successful boot, from the environment matching, or from another
 * target's outcome (§9.1).
 */
export interface TargetVerification {
  signatureIndex: number;
  attempted: boolean;
  trigger?: ReproductionTrigger;
  observed: boolean;
  errorClass?: string;
  message?: string;
  /** Entries the trigger newly produced, not the whole log. */
  logs?: string[];
  extraction?: LogExtraction;
  reason?: string;
}

export interface Verification {
  /** Built once; every target is exercised against it. */
  environment: {
    bootSucceeded: boolean;
    installedComponents: string[];
    failedComponents: string[];
  };

  failureReproduction: {
    targets: TargetVerification[];
  };
}
