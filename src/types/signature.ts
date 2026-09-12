/** docs/SPEC.md §4.5 */

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
}
