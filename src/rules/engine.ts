/**
 * Deterministic diagnostic rule engine (docs/SPEC.md §5, §10).
 *
 * Reads only the parsed Environment. No network, no clock, no randomness, no
 * model involvement. Rules run in rule-id order and matches keep source order,
 * so the same Environment always yields byte-identical output.
 *
 * Two hard gates are enforced here rather than trusted to each rule: a Finding
 * with no evidence and a Finding with no citation are both discarded.
 */
import type { Environment } from "../types/environment.js";
import type { Finding } from "../types/finding.js";
import type { RuleDefinition, MatchResult, Fact } from "../types/rule.js";
import type {
  DiagnosisResult,
  InformationRequest,
  RuleEvaluation,
} from "../types/diagnosis.js";
import { matchers } from "./matchers.js";
import definitions from "./definitions.json" with { type: "json" };

export const rules: RuleDefinition[] = [...(definitions.rules as RuleDefinition[])].sort((a, b) =>
  a.ruleId.localeCompare(b.ruleId),
);

/**
 * Resolves a dotted path and reports whether the value is actually present.
 *
 * A `Field` counts as present only when its status is not "missing"; an empty
 * array counts as absent, because a rule that needs evidence needs at least
 * one item.
 */
export function isAvailable(environment: Environment, path: string): boolean {
  let current: unknown = environment;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return false;
    current = (current as Record<string, unknown>)[segment];
  }

  if (current === null || current === undefined) return false;
  if (Array.isArray(current)) return current.length > 0;
  if (typeof current === "object" && "status" in (current as Record<string, unknown>)) {
    return (current as { status: string }).status !== "missing";
  }
  return true;
}

function renderCause(definition: RuleDefinition, facts: Fact[]): string {
  if (facts.length === 0) return definition.cause;
  const rendered = facts.map((f) => `${f.label}: ${f.value}`).join("\n");
  return `${definition.cause}\n\n${rendered}`;
}

function buildFinding(definition: RuleDefinition, match: MatchResult): Finding | undefined {
  const citations = [...definition.citations, ...(match.extraCitations ?? [])];

  // docs/SPEC.md §5.2: no Finding ships without evidence, and none without an
  // authoritative citation. These are not warnings — the Finding is dropped.
  if (match.evidence.length === 0) return undefined;
  if (citations.length === 0) return undefined;

  return {
    ruleId: definition.ruleId,
    title:
      match.titleSuffix !== undefined
        ? `${definition.title}: ${match.titleSuffix}`
        : definition.title,
    severity: definition.severity,
    // A matcher may only lower confidence, never raise it.
    confidence: match.confidence ?? definition.confidence,
    evidence: match.evidence,
    cause: renderCause(definition, match.facts),
    fix: definition.fix,
    citations,
    reproducibilityImpact: definition.reproducibilityImpact,
  };
}

export function diagnose(environment: Environment): DiagnosisResult {
  const findings: Finding[] = [];
  const evaluations: RuleEvaluation[] = [];
  const requestedBy: InformationRequest["requestedBy"] = [];

  for (const definition of rules) {
    const missing = definition.requires.filter((path) => !isAvailable(environment, path));

    if (missing.length > 0) {
      // docs/SPEC.md §10: this is not a Finding. The rule simply could not be
      // evaluated, and says what it would have needed.
      evaluations.push({
        ruleId: definition.ruleId,
        outcome: "insufficient_evidence",
        missingFields: missing,
        findingCount: 0,
      });
      requestedBy.push({ ruleId: definition.ruleId, missing });
      continue;
    }

    const outcome = matchers[definition.matcher](environment);

    if (outcome.kind === "not_applicable") {
      evaluations.push({
        ruleId: definition.ruleId,
        outcome: "not_applicable",
        reason: outcome.reason,
        findingCount: 0,
      });
      continue;
    }

    const produced = outcome.results
      .map((match) => buildFinding(definition, match))
      .filter((f): f is Finding => f !== undefined);

    findings.push(...produced);
    evaluations.push({
      ruleId: definition.ruleId,
      outcome: produced.length > 0 ? "finding" : "no_match",
      findingCount: produced.length,
    });
  }

  const missingFields = [...new Set(requestedBy.flatMap((r) => r.missing))]
    .filter((path) => !isAvailable(environment, path))
    .sort();

  return {
    findings,
    evaluations,
    informationRequest: { missingFields, requestedBy },
  };
}
