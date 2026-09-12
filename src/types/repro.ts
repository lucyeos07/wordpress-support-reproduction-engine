/** docs/SPEC.md §6, §8 */

import type { Evidence } from "./evidence.js";
import type { Verification } from "./verification.js";

export type Tier = "A" | "B" | "C" | "D" | "E";

export type ReproStatus = "reproducible" | "partial" | "blocked" | "insufficient_evidence";

export type Relevance = "relevant" | "irrelevant" | "unknown";

/**
 * MVP supports boot, plugin activation, and admin page load only
 * (docs/SPEC.md §8.1). Flows that cannot actually be executed are never
 * represented here; they surface as `attempted: false` with a reason.
 */
export type ReproductionTrigger =
  | { kind: "boot" }
  | { kind: "plugin_activation"; slug: string }
  | { kind: "admin_page_load"; path: string };

export interface Reason {
  /** Stable machine-readable identifier. */
  code: string;
  detail: string;
  evidence?: Evidence[];
}

export interface Substitution {
  requested: string;
  substituted: string;
  why: string;
}

export interface Omission {
  component: string;
  why: string;
  relevance: Relevance;
}

export interface ReproPlan {
  verdict: {
    tier: Tier;
    status: ReproStatus;
  };
  reasons: Reason[];
  substitutions: Substitution[];
  omissions: Omission[];
  blueprint?: unknown;
  verification?: Verification;
}
