/**
 * Declarative rule definitions (docs/SPEC.md §5).
 *
 * Everything a reviewer needs to audit a rule — severity, confidence, the
 * fields it requires, its remediation text and its citations — is data, held
 * in src/rules/definitions.json. Only the matching predicate is code, because
 * expressing version comparison and ownership checks as data would mean
 * inventing a small language for no benefit. Each definition names its matcher
 * by id, and a test asserts the two sets correspond exactly.
 */
import type { Severity } from "./finding.js";
import type { Confidence } from "./signature.js";
import type { Citation, Evidence } from "./evidence.js";
import type { Environment } from "./environment.js";

export type MatcherId =
  | "fatal_owned_by_plugin"
  | "fatal_owned_by_theme"
  | "php_below_plugin_requirement"
  | "outdated_template_override";

export interface RuleDefinition {
  ruleId: string;
  title: string;
  severity: Severity;
  /**
   * The confidence this rule can achieve at best. A matcher may lower it for a
   * specific instance (for example when ownership rests on an unmediated
   * directory name) but must never raise it.
   */
  confidence: Confidence;
  /** Dotted paths that must be present before the rule can evaluate. */
  requires: string[];
  matcher: MatcherId;
  cause: string;
  fix: string;
  citations: Citation[];
  reproducibilityImpact: string;
}

/** A labelled fact rendered into the Finding's cause, e.g. "Reported PHP version: 7.3". */
export interface Fact {
  label: string;
  value: string;
}

export interface MatchResult {
  /** Must be non-empty; a match with no evidence is discarded by the engine. */
  evidence: Evidence[];
  facts: Fact[];
  /** Lowers the rule's declared confidence for this instance. Never raises it. */
  confidence?: Confidence;
  /** Instance-specific authoritative sources, e.g. a version's readme. */
  extraCitations?: Citation[];
  /** Distinguishes multiple findings from one rule, e.g. a template path. */
  titleSuffix?: string;
}

export type MatcherOutcome =
  | { kind: "matches"; results: MatchResult[] }
  /** The rule cannot be applied here for a reason other than missing fields. */
  | { kind: "not_applicable"; reason: string };

export type Matcher = (environment: Environment) => MatcherOutcome;
