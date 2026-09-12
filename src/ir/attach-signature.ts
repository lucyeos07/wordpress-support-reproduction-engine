/**
 * Combines the two MVP adapters into one Environment (docs/SPEC.md §2.2).
 *
 * A System Status Report populates the environment; a debug log populates the
 * signature. Either may be supplied alone. This is deliberately narrow rather
 * than a general merge of two Environments: nothing in the MVP needs to
 * reconcile two conflicting reports of the same field, and inventing a
 * conflict-resolution policy before there is a case for it would be guesswork.
 */
import type { Environment } from "../types/environment.js";
import type { DebugLogParseResult } from "../parsers/debug-log/parse.js";

export function attachSignature(
  environment: Environment,
  artifactId: string,
  result: DebugLogParseResult,
): Environment {
  return {
    ...environment,
    provenance: {
      artifacts: [...environment.provenance.artifacts, { artifactId, adapter: "debug-log" }],
      warnings: [...environment.provenance.warnings, ...result.warnings],
    },
    ...(result.signature !== undefined ? { signature: result.signature } : {}),
  };
}
