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

/**
 * One independent reproduction target per ErrorSignature (docs/SPEC.md §8.1).
 *
 * `verdict` and `reasons` extend the conceptual model in §8.1, which defines
 * only signatureIndex/trigger/attempted/reason. Phase 4 requires each target to
 * carry its own reproducibility assessment, and a plan-level tier alone cannot
 * express that one target is reproducible while another is blocked.
 */
export interface ReproTarget {
  signatureIndex: number;
  trigger?: ReproductionTrigger;
  attempted: boolean;
  reason?: string;
  verdict: { tier: Tier; status: ReproStatus };
  reasons: Reason[];
}

export interface ReproPlan {
  verdict: {
    tier: Tier;
    status: ReproStatus;
  };
  /** One target per ErrorSignature in Environment.signatures, in that order. */
  targets: ReproTarget[];
  reasons: Reason[];
  substitutions: Substitution[];
  omissions: Omission[];
  blueprint?: unknown;
  verification?: Verification;
}
