/**
 * Runs the existing deterministic pipeline over a pasted artifact.
 *
 * Composition only — no parsing, diagnosis or planning logic lives here. It
 * calls the modules built in Phases 1–4 unchanged, and performs no network
 * request of any kind.
 */
import { parseSystemStatusReport } from "../parsers/woo-ssr/parse.js";
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
  format: Exclude<InputFormat, "auto">[];
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

  const useSsr = format === "ssr" || (format === "auto" && looksLikeSystemStatusReport(source));
  const useLog = format === "log" || (format === "auto" && looksLikeDebugLog(source));

  if (!useSsr && !useLog) {
    throw new AnalysisError(
      "This does not look like a WooCommerce System Status Report (no '### Section ###' headings) or a PHP fatal (no 'PHP Fatal error:' line). Choose a format explicitly if you know what it is.",
    );
  }

  const applied: Exclude<InputFormat, "auto">[] = [];

  // The System Status Report adapter is safe to run on any text: unrecognised
  // input simply yields missing fields plus a parser warning.
  let environment = useSsr
    ? parseSystemStatusReport({ artifactId: ARTIFACT_ID, text: source })
    : parseSystemStatusReport({ artifactId: ARTIFACT_ID, text: "" });
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

  return { source, format: applied, environment, diagnosis, plan, verificationPlan };
}
