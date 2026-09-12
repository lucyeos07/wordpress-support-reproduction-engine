/**
 * Parser quality signals.
 *
 * These are NOT `Finding`s and must never be presented as diagnostics. A
 * `Finding` is a statement about the reported site; a `ParserWarning` is a
 * statement about how well this tool managed to read the artifact. They carry
 * no severity, no citation, and no fix, precisely so the two cannot be
 * confused. See docs/SPEC.md §5.2 ("insufficient information" is not a Finding).
 */
import type { Evidence } from "./evidence.js";

export type ParserWarningCode =
  /** Input is structurally a report, but no section heading was recognised. */
  | "no_recognised_sections"
  /** A recognised section contained none of its expected labels. */
  | "section_labels_unrecognised"
  /** A section header declared a count that disagrees with the rows parsed. */
  | "plugin_count_mismatch"
  /** A row inside a plugin section did not match the expected row shape. */
  | "malformed_plugin_row"
  /** An entry under Overrides did not match the expected override shape. */
  | "malformed_override_row"
  /** A row that should have carried continuation lines carried none. */
  | "missing_continuation"
  /** A recognised section was present but could not be read completely. */
  | "section_incomplete";

export interface ParserWarning {
  code: ParserWarningCode;
  /** Human-readable description. Not user-facing copy. */
  detail: string;
  section?: string;
  evidence?: Evidence;
}
