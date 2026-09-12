/** Output of the diagnostic layer (docs/SPEC.md §5, §10). */

import type { Finding } from "./finding.js";

export type RuleOutcome =
  /** The rule matched and emitted one or more Findings. */
  | "finding"
  /** The rule evaluated and did not match. */
  | "no_match"
  /** Required fields were absent, so the rule did not evaluate (docs/SPEC.md §10). */
  | "insufficient_evidence"
  /** The rule evaluated but does not apply here, e.g. no sourced requirement. */
  | "not_applicable";

export interface RuleEvaluation {
  ruleId: string;
  outcome: RuleOutcome;
  /** Dotted field paths the rule needed but could not find. */
  missingFields?: string[];
  /** Why the rule did not apply, when outcome is "not_applicable". */
  reason?: string;
  findingCount: number;
}

/**
 * A targeted "please provide…" request, derived per docs/SPEC.md §10: take the
 * evidence required by rules that could not evaluate, union it, subtract what
 * is already available, deduplicate.
 *
 * This is NOT a Finding. Insufficient information is a property of the
 * evidence, not a diagnosis about the site.
 */
export interface InformationRequest {
  missingFields: string[];
  requestedBy: Array<{ ruleId: string; missing: string[] }>;
}

export interface DiagnosisResult {
  findings: Finding[];
  /** One entry per rule, in rule id order. Explains the rules that said nothing. */
  evaluations: RuleEvaluation[];
  informationRequest: InformationRequest;
}
