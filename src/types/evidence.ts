/** docs/SPEC.md §4.2, §4.3, §5.1 */

export type FieldStatus = "known" | "missing" | "inferred";

/**
 * A parsed value together with how it came to be known.
 * `missing` carries no value; there is no "default" or "assumed" state.
 */
export interface Field<T> {
  status: FieldStatus;
  value?: T;
  evidence?: Evidence[];
  inferenceBasis?: string;
}

export type AdapterId = "woo-ssr" | "debug-log";

export interface Evidence {
  artifactId: string;
  adapter: AdapterId;
  locator: {
    section?: string;
    line?: number;
  };
  /** Verbatim span from the artifact. Never normalised or summarised. */
  excerpt: string;
}

export interface Citation {
  title: string;
  url: string;
  /** Official upstream source only. */
  publisher: string;
  /** ISO 8601 */
  retrievedAt: string;
}
