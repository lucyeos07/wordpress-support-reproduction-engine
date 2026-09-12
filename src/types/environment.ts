/** docs/SPEC.md §4.1, §4.4 */

import type { Field, AdapterId } from "./evidence.js";
import type { ErrorSignature } from "./signature.js";

export type PluginSource = "wordpress.org" | "premium" | "unknown";

export interface Plugin {
  slug?: string;
  name: string;
  version?: string;
  author?: string;
  active?: boolean;
  source: PluginSource;
  testedUpTo?: string;
}

/** Which artifacts this Environment was assembled from. */
export interface Provenance {
  artifacts: Array<{
    artifactId: string;
    adapter: AdapterId;
  }>;
}

export interface WordPressInfo {
  version: Field<string>;
}

export interface ServerInfo {
  phpVersion: Field<string>;
  /** Verbatim as reported (e.g. "256M"); not normalised to bytes here. */
  memoryLimit: Field<string>;
}

export interface ThemeInfo {
  name: Field<string>;
  version: Field<string>;
}

export interface WooCommerceInfo {
  version: Field<string>;
}

/**
 * Shape deferred. docs/SPEC.md §4.1 requires a `database` section but does not
 * specify its contents, and no Phase 0 experiment justifies specific fields.
 * Phase 1 defines it from real System Status Report fixtures.
 */
export type DatabaseInfo = Record<string, Field<string>>;

export interface Environment {
  provenance: Provenance;
  wordPress: WordPressInfo;
  server: ServerInfo;
  database: DatabaseInfo;
  theme: ThemeInfo;
  plugins: Plugin[];
  wooCommerce: WooCommerceInfo;
  signature?: ErrorSignature;
}
