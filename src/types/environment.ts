/** docs/SPEC.md §4.1, §4.4 */

import type { Field, AdapterId, Evidence } from "./evidence.js";
import type { ErrorSignature } from "./signature.js";
import type { ParserWarning } from "./warning.js";

export type PluginSource = "wordpress.org" | "premium" | "unknown";

/**
 * How the site loads this component. These are not interchangeable:
 * a must-use plugin and a drop-in are always loaded and cannot be deactivated
 * through the admin, so collapsing them into "active" would misrepresent the
 * site. A drop-in is not a plugin in the repository sense at all — it is a
 * single file in wp-content.
 */
export type PluginKind = "active" | "inactive" | "must-use" | "dropin";

export interface Plugin {
  slug?: string;
  name: string;
  version?: string;
  author?: string;
  /**
   * Set only for the Active/Inactive sections, which is the only place the
   * report states it. Must-use plugins and drop-ins leave this undefined
   * rather than claiming a value the source never gave.
   */
  active?: boolean;
  kind: PluginKind;
  source: PluginSource;
  testedUpTo?: string;
  /** Where this plugin's row was read from. */
  evidence?: Evidence;
}

/**
 * Where this Environment came from and how well it could be read.
 *
 * `warnings` are parser quality signals, never diagnostics. They travel with
 * the Environment so a later consumer can tell "the report said nothing about
 * X" apart from "this tool could not read X".
 */
export interface Provenance {
  artifacts: Array<{
    artifactId: string;
    adapter: AdapterId;
  }>;
  warnings: ParserWarning[];
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
  /**
   * A Field rather than a bare array so that "the report has no Templates
   * section" (`missing`) stays distinct from "the report states there are no
   * overrides" (`known` with an empty array). The two mean different things:
   * only the second is evidence that the site overrides nothing.
   */
  templateOverrides: Field<TemplateOverride[]>;
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
