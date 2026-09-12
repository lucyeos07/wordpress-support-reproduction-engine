/** docs/SPEC.md §4.1, §4.4 */

import type { Field, AdapterId, Evidence } from "./evidence.js";
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
  /** Where this plugin's row was read from. */
  evidence?: Evidence;
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
  /** Verbatim as reported (e.g. "512 MB"); not normalised to bytes here. */
  memoryLimit: Field<string>;
  /** Verbatim server string (e.g. "nginx/1.18.0"). */
  webServer: Field<string>;
}

export interface ThemeInfo {
  name: Field<string>;
  version: Field<string>;
  isChildTheme: Field<boolean>;
  parentName: Field<string>;
  parentVersion: Field<string>;
}

/**
 * A WooCommerce template the site overrides. `outdated` is true only when the
 * report itself says the override is out of date; it is never inferred from a
 * version comparison performed here.
 */
export interface TemplateOverride {
  file: string;
  version?: string;
  coreVersion?: string;
  outdated: boolean;
  evidence: Evidence;
}

export interface WooCommerceInfo {
  version: Field<string>;
  databaseVersion: Field<string>;
  templateOverrides: TemplateOverride[];
}

/**
 * WooCommerce reports the database under a single "MySQL Version" label
 * regardless of engine, so `engine` is `inferred` rather than `known` and
 * carries the basis for the derivation.
 */
export interface DatabaseInfo {
  engine: Field<string>;
  version: Field<string>;
}

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
