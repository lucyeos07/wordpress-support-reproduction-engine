/** docs/SPEC.md §4.5 */

import type { Evidence } from "./evidence.js";

export interface StackFrame {
  file?: string;
  line?: number;
  function?: string;
  /** Verbatim frame text. */
  raw: string;
}

export type OwnerType = "plugin" | "theme" | "core" | "unknown";
export type Confidence = "high" | "medium" | "low";

export interface ErrorSignature {
  errorClass?: string;
  message?: string;
  file?: string;
  line?: number;
  frames?: StackFrame[];

  owner: {
    type: OwnerType;
    slug?: string;
    confidence: Confidence;
  };

  /**
   * Where this signature was read from.
   *
   * docs/SPEC.md §4.5 does not list this field, but §4.3 requires every
   * important parsed value to be traceable to source evidence, and a Finding
   * derived from a signature cannot cite the artifact without it. See
   * docs/phase-3-findings.md.
   */
  evidence?: Evidence[];
}
