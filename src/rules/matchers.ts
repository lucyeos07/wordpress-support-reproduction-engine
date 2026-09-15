/**
 * Rule matching predicates.
 *
 * Every matcher reads only the parsed Environment (and the Signature inside
 * it). None of them re-parse raw artifact text, and none of them attribute
 * ownership — ownership arrives already decided from the debug-log adapter
 * (docs/SPEC.md §4.5).
 */
import type { Environment } from "../types/environment.js";
import type { Matcher, MatcherId, MatchResult } from "../types/rule.js";
import type { Citation } from "../types/evidence.js";
import requirements from "./requirements.json" with { type: "json" };

interface PhpRequirement {
  slug: string;
  pluginVersion: string;
  requiresPhp: string;
  citation: Citation;
}

/**
 * Numeric dot-segment comparison. "7.4" vs "7.4.33" compares equal on the
 * shared segments, so 7.4.33 satisfies a ">= 7.4" requirement.
 * Returns <0, 0 or >0.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = Number.parseInt(pa[i] ?? "0", 10);
    const nb = Number.parseInt(pb[i] ?? "0", 10);
    if (Number.isNaN(na) || Number.isNaN(nb)) return 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/** Shared by the two ownership rules; `type` is read, never derived. */
function fatalOwnedBy(environment: Environment, type: "plugin" | "theme"): MatchResult[] {
  // Every signature is considered; none is designated primary and none is
  // discarded (docs/SPEC.md §8.1).
  return environment.signatures.flatMap((signature) => oneFatal(signature, type));
}

function oneFatal(
  signature: Environment["signatures"][number],
  type: "plugin" | "theme",
): MatchResult[] {
  if (signature.owner.type !== type) return [];

  const evidence = signature.evidence ?? [];
  // A Finding without evidence must not exist, so a signature we cannot cite
  // produces nothing rather than an uncited claim.
  if (evidence.length === 0) return [];

  const facts = [
    ...(signature.errorClass !== undefined
      ? [{ label: "Error class", value: signature.errorClass }]
      : []),
    ...(signature.message !== undefined ? [{ label: "Message", value: signature.message }] : []),
    ...(signature.file !== undefined ? [{ label: "File", value: signature.file }] : []),
    ...(signature.line !== undefined
      ? [{ label: "Line", value: String(signature.line) }]
      : []),
    ...(signature.owner.slug !== undefined
      ? [{ label: "Identified plugin slug", value: signature.owner.slug }]
      : []),
    {
      label: "Ownership confidence",
      value:
        signature.owner.slug !== undefined
          ? "resolved through the bundled catalog"
          : "directory name not in the catalog, so the owner is identified by path only",
    },
  ];

  return [
    {
      evidence,
      facts,
      // Never stronger than the attribution the adapter achieved.
      confidence: signature.owner.confidence,
      ...(signature.owner.slug !== undefined ? { titleSuffix: signature.owner.slug } : {}),
    },
  ];
}

const phpRequirementsBySlug = new Map<string, PhpRequirement[]>();
for (const r of requirements.phpRequirements as PhpRequirement[]) {
  const list = phpRequirementsBySlug.get(r.slug) ?? [];
  list.push(r);
  phpRequirementsBySlug.set(r.slug, list);
}

export const matchers: Record<MatcherId, Matcher> = {
  fatal_owned_by_plugin: (environment) => ({
    kind: "matches",
    results: fatalOwnedBy(environment, "plugin"),
  }),

  fatal_owned_by_theme: (environment) => ({
    kind: "matches",
    results: fatalOwnedBy(environment, "theme"),
  }),

  php_below_plugin_requirement: (environment) => {
    const phpField = environment.server.phpVersion;
    const wcField = environment.wooCommerce.version;
    const php = phpField.value;
    const wcVersion = wcField.value;
    if (php === undefined || wcVersion === undefined) {
      return { kind: "matches", results: [] };
    }

    const candidates = phpRequirementsBySlug.get("woocommerce") ?? [];
    const requirement = candidates.find((r) => r.pluginVersion === wcVersion);

    // No sourced requirement for this exact version. Extrapolating from a
    // neighbouring version would be inventing a requirement, so the rule
    // declines instead.
    if (!requirement) {
      return {
        kind: "not_applicable",
        reason: `no authoritative PHP requirement is recorded for WooCommerce ${wcVersion}; requirements are keyed by exact version and never extrapolated`,
      };
    }

    if (compareVersions(php, requirement.requiresPhp) >= 0) {
      return { kind: "matches", results: [] };
    }

    return {
      kind: "matches",
      results: [
        {
          evidence: [...(phpField.evidence ?? []), ...(wcField.evidence ?? [])],
          facts: [
            { label: "Reported PHP version", value: php },
            { label: "Required PHP version", value: `>= ${requirement.requiresPhp}` },
            { label: "Installed WooCommerce version", value: wcVersion },
          ],
          extraCitations: [requirement.citation],
          titleSuffix: `WooCommerce ${wcVersion} requires PHP >= ${requirement.requiresPhp}`,
        },
      ],
    };
  },

  outdated_template_override: (environment) => {
    const field = environment.wooCommerce.templateOverrides;
    const overrides = field.value ?? [];

    const results: MatchResult[] = overrides
      // `outdated` is set only where the report itself says "is out of date".
      // No version comparison happens here.
      .filter((o) => o.outdated)
      .map((o) => ({
        evidence: [o.evidence],
        facts: [
          { label: "Template", value: o.file },
          ...(o.version !== undefined
            ? [{ label: "Override version", value: o.version }]
            : []),
          ...(o.coreVersion !== undefined
            ? [{ label: "Core template version", value: o.coreVersion }]
            : []),
        ],
        titleSuffix: o.file,
      }));

    return { kind: "matches", results };
  },
};
