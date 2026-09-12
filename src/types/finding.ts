/** docs/SPEC.md §5.1 */

import type { Evidence, Citation } from "./evidence.js";
import type { Confidence } from "./signature.js";

export type Severity = "critical" | "high" | "medium" | "low";

export interface Finding {
  ruleId: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  /** Non-empty. A Finding without evidence must not exist. */
  evidence: Evidence[];
  cause: string;
  fix: string;
  /** Non-empty. Official upstream documentation only. */
  citations: Citation[];
  /**
   * Explanatory text for the reader. Never read by the reproduction planner
   * (docs/SPEC.md §5.2, §7).
   */
  reproducibilityImpact: string;
}
