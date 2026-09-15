/**
 * Deterministic reproduction planner (docs/SPEC.md §6, §8, §11).
 *
 * FIREWALL (§7): this module reads the Environment, its ErrorSignatures, and
 * the documented capabilities in capabilities.json. It must never import from
 * src/rules/, and must never consult a Finding, severity, confidence or
 * remediation text. tests/repro-firewall.test.ts asserts the import edge is
 * absent.
 *
 * Determinism: rules are applied in a fixed order over inputs that are already
 * ordered (plugins in report order, signatures in extraction order). No clock,
 * no randomness, no network.
 */
import type { Environment, Plugin } from "../types/environment.js";
import type {
  Omission,
  Reason,
  ReproPlan,
  ReproStatus,
  ReproTarget,
  Tier,
} from "../types/repro.js";
import { decideComponents, type InstallDecision } from "./components.js";
import { relevanceOf, infrastructureRelevance, isImplicatedBy } from "./relevance.js";
import { deriveTrigger } from "./triggers.js";
import { generateBlueprint, type BlueprintV2 } from "./blueprint.js";
import { buildVerificationPlan, type VerificationPlan } from "./verification-plan.js";
import capabilities from "./capabilities.json" with { type: "json" };

export interface PlanResult {
  plan: ReproPlan;
  /** Kept separate from ReproPlan.verification, which holds Phase 5 results. */
  verificationPlan: VerificationPlan;
}

/** Most reproducible first. Used to summarise, never to overwrite a target. */
const TIER_ORDER: Tier[] = ["A", "B", "C", "D", "E"];

function statusForTier(tier: Tier, partial: boolean): ReproStatus {
  if (tier === "E") return "insufficient_evidence";
  if (partial) return "partial";
  if (tier === "A" || tier === "B") return "reproducible";
  return "blocked";
}

export function planReproduction(environment: Environment): PlanResult {
  const decisions = decideComponents(environment.plugins);
  const installs: InstallDecision[] = decisions
    .filter((d): d is { decision: "install" } & InstallDecision => d.decision === "install")
    .map(({ plugin, reference, active }) => ({ plugin, reference, active }));

  const installableSlugs = new Set(
    installs.map((i) => i.plugin.slug).filter((s): s is string => s !== undefined),
  );

  // ---- omissions -------------------------------------------------------
  // `relevance` on each Omission is the SPEC §6.1 label, computed across ALL
  // usable signatures. `origin` is kept alongside so a target can be gated on
  // what ITS OWN signature implicates: a component relevant to one target must
  // not downgrade an unrelated one.
  type OmissionOrigin = { plugin: Plugin } | { theme: true } | { infrastructure: true };
  const omissionRecords: Array<{ omission: Omission; origin: OmissionOrigin }> = [];

  for (const decision of decisions) {
    if (decision.decision !== "omit") continue;
    omissionRecords.push({
      omission: {
        component: decision.component,
        why: decision.why,
        relevance: relevanceOf(decision.plugin, environment.signatures),
      },
      origin: { plugin: decision.plugin },
    });
  }

  // The theme is reported but never installable: nothing in the IR yields a
  // slug or URL for it.
  const themeName = environment.theme.name.value;
  if (themeName !== undefined) {
    const themeVersion = environment.theme.version.value;
    omissionRecords.push({
      omission: {
        component: `theme ${themeName}${themeVersion !== undefined ? ` ${themeVersion}` : ""}`,
        why: capabilities.themes.note,
        // §6.1 allows path-based implication only against a component's
        // KNOWN path, and a theme's path is known only when its slug or
        // directory is. The IR carries a theme display name and nothing else,
        // so no deterministic association is possible and relevance stays
        // `unknown`. Inferring the theme from `owner.type === "theme"` would
        // be an extra rule the SPEC does not define.
        relevance: infrastructureRelevance(),
      },
      origin: { theme: true },
    });
  }

  const webServer = environment.server.webServer.value;
  if (webServer !== undefined) {
    omissionRecords.push({
      omission: {
        component: `web server ${webServer}`,
        why: capabilities.webServer.note,
        relevance: infrastructureRelevance(),
      },
      origin: { infrastructure: true },
    });
  }

  const memoryLimit = environment.server.memoryLimit.value;
  if (memoryLimit !== undefined) {
    omissionRecords.push({
      omission: {
        component: `PHP memory limit ${memoryLimit}`,
        why: "the reported memory limit is a server setting; a Blueprint cannot set the PHP memory_limit, so the reconstruction runs with Playground's own limit.",
        relevance: infrastructureRelevance(),
      },
      origin: { infrastructure: true },
    });
  }

  const omissions: Omission[] = omissionRecords.map((r) => r.omission);

  // ---- blueprint and substitutions -------------------------------------
  const { blueprint, substitutions } = generateBlueprint(environment, installs);

  // A substitution is material when it changes something the reported site
  // depended on. A patch-level PHP difference is recorded but not material.
  const materialSubstitutions = substitutions.filter(
    (s) => !s.substituted.includes("patch release chosen by Playground"),
  );

  const unknownRelevanceOmissions = omissions.filter((o) => o.relevance === "unknown");

  // ---- targets ---------------------------------------------------------
  const targets: ReproTarget[] = environment.signatures.map((signature, signatureIndex) => {
    const decision = deriveTrigger(signature, installableSlugs);
    const reasons: Reason[] = [];

    if (!decision.attempted) {
      const tier: Tier = decision.code === "signature_not_usable" ? "E" : "D";
      reasons.push({
        code: decision.code,
        detail: decision.reason ?? "",
        ...(signature.evidence !== undefined ? { evidence: signature.evidence } : {}),
      });
      return {
        signatureIndex,
        attempted: false,
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
        verdict: { tier, status: statusForTier(tier, false) },
        reasons,
      };
    }

    reasons.push({
      code: `trigger_${decision.code}`,
      detail: `a ${decision.trigger?.kind ?? "boot"} trigger can be executed for this signature`,
      ...(signature.evidence !== undefined ? { evidence: signature.evidence } : {}),
    });

    // Only components implicated by THIS signature constrain THIS target. A
    // limitation affecting another target must never downgrade this one.
    // Infrastructure omissions are never per-target blockers: their relevance
    // cannot be established from a signature, so they stay `unknown` and are
    // surfaced rather than used to block (§6.1).
    const relevantOmissions = omissionRecords
      .filter(({ origin }) => {
        if ("plugin" in origin) return isImplicatedBy(origin.plugin, signature);
        // Themes and infrastructure carry `unknown` relevance, which §6.1 says
        // is surfaced rather than resolved; it never silently blocks a target.
        return false;
      })
      .map((r) => r.omission);

    for (const omission of relevantOmissions) {
      reasons.push({
        code: "relevant_component_omitted",
        detail: `${omission.component} is relevant to the reported failure but cannot be installed: ${omission.why}`,
      });
    }

    let tier: Tier;
    let partial = false;
    if (relevantOmissions.length > 0) {
      tier = "D";
      partial = true;
    } else if (materialSubstitutions.length > 0) {
      tier = "B";
      for (const substitution of materialSubstitutions) {
        reasons.push({
          code: "material_substitution",
          detail: `${substitution.requested} → ${substitution.substituted}`,
        });
      }
    } else {
      tier = "A";
    }

    if (tier !== "D" && unknownRelevanceOmissions.length > 0) {
      reasons.push({
        code: "unknown_relevance_omission",
        detail: `${String(unknownRelevanceOmissions.length)} reported component(s) could not be reconstructed and their relevance to this failure could not be determined from the Environment and signatures`,
      });
    }

    return {
      signatureIndex,
      ...(decision.trigger !== undefined ? { trigger: decision.trigger } : {}),
      attempted: true,
      verdict: { tier, status: statusForTier(tier, partial) },
      reasons,
    };
  });

  // ---- plan verdict ----------------------------------------------------
  const planReasons: Reason[] = [];
  let planTier: Tier;
  let planStatus: ReproStatus;

  if (targets.length === 0) {
    planTier = "E";
    planStatus = "insufficient_evidence";
    planReasons.push({
      code: "no_signatures",
      detail:
        "the Environment carries no ErrorSignature, so there is no reported failure to reproduce. The environment can still be reconstructed and booted.",
    });
  } else {
    // Summarises the most reproducible target. Per-target verdicts are
    // preserved in `targets` and are never overwritten by this value.
    const best = [...targets].sort(
      (a, b) => TIER_ORDER.indexOf(a.verdict.tier) - TIER_ORDER.indexOf(b.verdict.tier),
    )[0];
    planTier = best?.verdict.tier ?? "E";
    planStatus = best?.verdict.status ?? "insufficient_evidence";
    planReasons.push({
      code: "target_summary",
      detail: `${String(targets.length)} reproduction target(s); tiers ${targets
        .map((t) => `#${String(t.signatureIndex)}=${t.verdict.tier}`)
        .join(", ")}. The plan verdict reports the most reproducible target and does not override the others.`,
    });
  }

  for (const substitution of materialSubstitutions) {
    planReasons.push({
      code: "shared_environment_substitution",
      detail: `${substitution.requested} → ${substitution.substituted}`,
    });
  }

  const plan: ReproPlan = {
    verdict: { tier: planTier, status: planStatus },
    targets,
    reasons: planReasons,
    substitutions,
    omissions,
    blueprint: blueprint satisfies BlueprintV2,
  };

  return {
    plan,
    verificationPlan: buildVerificationPlan(environment, installs, omissions, targets, blueprint),
  };
}
