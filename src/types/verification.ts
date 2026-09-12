/** docs/SPEC.md §9 */

import type { ReproductionTrigger } from "./repro.js";

/**
 * Where a PHP error was read from, and whether reading it was deterministic.
 *
 * Required by docs/SPEC.md §9: "the extraction method — along with whether it
 * was deterministic — must be representable in the model". Phase 0 established
 * that neither Playground surface exposes a structured PHP error object, so
 * `errorClass` and `message` below are always extraction results, never
 * runtime-provided fields. See docs/phase-0-findings.md.
 */
export interface LogExtraction {
  source: "debug.log" | "thrown-error-message" | "response-stderr";
  /** False when the value came from anything other than a fixed pattern match. */
  deterministic: boolean;
  /** The pattern applied, recorded so a result can be re-derived and audited. */
  pattern?: string;
}

export interface Verification {
  environment: {
    bootSucceeded: boolean;
    installedComponents: string[];
    failedComponents: string[];
  };

  failureReproduction: {
    attempted: boolean;
    trigger?: ReproductionTrigger;
    /** True only if the trigger ran and the result was observed (§9.1). */
    observed: boolean;
    errorClass?: string;
    message?: string;
    logs?: string[];
    extraction?: LogExtraction;
  };
}
