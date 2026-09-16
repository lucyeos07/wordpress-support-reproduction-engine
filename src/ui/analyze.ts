/**
 * Runs the existing deterministic pipeline over a pasted artifact.
 *
 * Composition only — no parsing, diagnosis or planning logic lives here. It
 * calls the modules built in Phases 1–4 unchanged, and performs no network
 * request of any kind.
 */
import { parseSystemStatusReport } from "../parsers/woo-ssr/parse.js";
import { emptyEnvironment } from "../ir/empty-environment.js";
import { parseDebugLog } from "../parsers/debug-log/parse.js";
import { attachSignature } from "../ir/attach-signature.js";
import { diagnose } from "../rules/engine.js";
import { planReproduction } from "../repro/plan.js";
import type { Environment } from "../types/environment.js";
import type { DiagnosisResult } from "../types/diagnosis.js";
import type { ReproPlan } from "../types/repro.js";
import type { VerificationPlan } from "../repro/verification-plan.js";

export type InputFormat = "auto" | "ssr" | "log";

export const ARTIFACT_ID = "pasted-artifact";

const SECTION_HEADING = /^###\s+.+\s+###\s*$/m;
const FATAL_LINE = /PHP (?:Fatal error|Parse error|Recoverable fatal error):/;

export function looksLikeSystemStatusReport(text: string): boolean {
  return SECTION_HEADING.test(text);
}

export function looksLikeDebugLog(text: string): boolean {
  return FATAL_LINE.test(text);
}

/**
 * What the input demonstrably is, never what it might be.
 *
 * Evidence is deterministic and structural: a `### Section ###` heading is the
 * System Status export's own format, and a `PHP Fatal error:` line is PHP's.
 * Anything else is `unrecognised` — the format is not guessed from prose,
 * length or field names.
 */
export type DetectedFormat = "ssr" | "log" | "both" | "unrecognised";

export function detectFormat(text: string): DetectedFormat {
  const ssr = looksLikeSystemStatusReport(text);
  const log = looksLikeDebugLog(text);
  if (ssr && log) return "both";
  if (ssr) return "ssr";
  if (log) return "log";
  return "unrecognised";
}

/**
 * Splits a pasted log into one block per fatal, each padded with leading
 * newlines so its line numbers stay identical to the original paste.
 *
 * The debug-log adapter returns only the first fatal it finds (a documented
 * Phase 3 limitation). Rather than change the adapter, each fatal is handed to
 * it separately. Padding rather than slicing is what preserves evidence
 * integrity: an excerpt still cites the line it actually occupies in the text
 * the user pasted.
 */
export function splitFatalBlocks(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (FATAL_LINE.test(line)) starts.push(index);
  });

  return starts.map((start, i) => {
    const end = starts[i + 1] ?? lines.length;
    const body = lines.slice(start, end).join("\n");
    return "\n".repeat(start) + body;
  });
}

export interface Analysis {
  /** Verbatim text the user pasted; evidence line numbers refer to it. */
  source: string;
  /** Adapters that actually ran. */
  format: Exclude<InputFormat, "auto">[];
  detected: DetectedFormat;
  environment: Environment;
  diagnosis: DiagnosisResult;
  plan: ReproPlan;
  verificationPlan: VerificationPlan;
}

export class AnalysisError extends Error {}

/**
 * Parse → Environment → Findings → ReproPlan, in that order.
 *
 * `auto` runs both adapters, because a support ticket routinely contains a
 * System Status Report and a fatal in the same paste.
 */
export function analyze(source: string, format: InputFormat = "auto"): Analysis {
  if (source.trim() === "") {
    throw new AnalysisError("Paste a WooCommerce System Status Report or a PHP fatal / debug log.");
  }

  const detected = detectFormat(source);

  if (format === "auto" && detected === "unrecognised") {
    throw new AnalysisError(
      "This does not look like a WooCommerce System Status Report (no '### Section ###' headings) or a PHP fatal (no 'PHP Fatal error:' line). Choose a format explicitly if you know what it is.",
    );
  }

  // An explicit choice is honoured, but not against the evidence: running an
  // adapter over input that cannot match it yields an empty result that looks
  // like a successful parse, which is worse than saying so.
  if (format === "ssr" && !looksLikeSystemStatusReport(source)) {
    throw new AnalysisError(
      "No '### Section ###' headings were found, so this cannot be parsed as a WooCommerce System Status Report. Use Auto-detect, or paste the report from WooCommerce → Status → Get system report.",
    );
  }
  if (format === "log" && !looksLikeDebugLog(source)) {
    throw new AnalysisError(
      "No 'PHP Fatal error:' line was found, so this cannot be parsed as a PHP fatal or debug log. Use Auto-detect, or paste the fatal from wp-content/debug.log.",
    );
  }

  const useSsr = format === "ssr" || (format === "auto" && (detected === "ssr" || detected === "both"));
  const useLog = format === "log" || (format === "auto" && (detected === "log" || detected === "both"));

  const applied: Exclude<InputFormat, "auto">[] = [];

  // Only an adapter that actually ran contributes provenance. Previously the
  // System Status adapter was run over empty text when it did not apply, which
  // recorded a woo-ssr artifact for a report nobody supplied.
  let environment = useSsr
    ? parseSystemStatusReport({ artifactId: ARTIFACT_ID, text: source })
    : emptyEnvironment();
  if (useSsr) applied.push("ssr");

  if (useLog) {
    for (const block of splitFatalBlocks(source)) {
      const result = parseDebugLog({ artifactId: ARTIFACT_ID, text: block });
      environment = attachSignature(environment, ARTIFACT_ID, result);
    }
    applied.push("log");
  }

  const diagnosis = diagnose(environment);
  const { plan, verificationPlan } = planReproduction(environment);

  return { source, format: applied, detected, environment, diagnosis, plan, verificationPlan };
}
