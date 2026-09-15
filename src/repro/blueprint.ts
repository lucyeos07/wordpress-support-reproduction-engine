/**
 * Blueprint v2 generation (docs/SPEC.md §11).
 *
 * Only properties present in the published schema are emitted. Versions come
 * from the Environment when known; when they do not, or when Playground cannot
 * offer them, the difference is recorded as an explicit substitution rather
 * than silently defaulted (CLAUDE.md: never silently substitute).
 */
import type { Environment } from "../types/environment.js";
import type { Substitution } from "../types/repro.js";
import type { InstallDecision } from "./components.js";
import capabilities from "./capabilities.json" with { type: "json" };

const SUPPORTED_PHP: string[] = capabilities.phpVersions.supported;

export interface BlueprintPlugin {
  source: string;
  active: boolean;
}

export interface BlueprintV2 {
  $schema: string;
  version: 2;
  wordpressVersion?: string;
  phpVersion?: string;
  plugins: BlueprintPlugin[];
  constants: Record<string, boolean>;
}

export interface BlueprintResult {
  blueprint: BlueprintV2;
  substitutions: Substitution[];
}

function majorMinor(version: string): string {
  const parts = version.split(".");
  return `${parts[0] ?? ""}.${parts[1] ?? "0"}`;
}

function compare(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * Picks the PHP version Playground will actually run, recording any difference.
 *
 * Playground pins major.minor only, so a reported patch release can never be
 * reproduced exactly. When the reported major.minor is not offered at all, the
 * lowest supported version above it is chosen, which is a material change and
 * is recorded as such.
 */
export function resolvePhpVersion(reported: string | undefined): {
  phpVersion?: string;
  substitutions: Substitution[];
  material: boolean;
} {
  if (reported === undefined) {
    return {
      substitutions: [
        {
          requested: "PHP version (not reported)",
          substituted: "Playground default",
          why: "the artifact did not state a PHP version, so none is pinned and the runtime default applies. The reconstruction may therefore run a different PHP version from the reported site.",
        },
      ],
      material: true,
    };
  }

  const wanted = majorMinor(reported);

  if (SUPPORTED_PHP.includes(wanted)) {
    // Exact major.minor available. A reported patch level still cannot be
    // pinned, so say so when the report gave one.
    const reportedHasPatch = reported.split(".").length > 2;
    return {
      phpVersion: wanted,
      substitutions: reportedHasPatch
        ? [
            {
              requested: `PHP ${reported}`,
              substituted: `PHP ${wanted} (patch release chosen by Playground)`,
              why: "Playground pins PHP to major.minor only; a Blueprint cannot request a specific patch release.",
            },
          ]
        : [],
      material: false,
    };
  }

  const higher = SUPPORTED_PHP.filter((v) => compare(v, wanted) > 0).sort(compare);
  const chosen = higher[0] ?? SUPPORTED_PHP[SUPPORTED_PHP.length - 1];

  return {
    ...(chosen !== undefined ? { phpVersion: chosen } : {}),
    substitutions: [
      {
        requested: `PHP ${reported}`,
        substituted: `PHP ${chosen ?? "none available"}`,
        why: `Playground does not offer PHP ${wanted}; it offers ${SUPPORTED_PHP.join(", ")}. The lowest supported version above the reported one was chosen. Behaviour that depends on the reported PHP version will not be reproduced.`,
      },
    ],
    material: true,
  };
}

export function generateBlueprint(
  environment: Environment,
  installs: InstallDecision[],
): BlueprintResult {
  const substitutions: Substitution[] = [];

  const php = resolvePhpVersion(environment.server.phpVersion.value);
  substitutions.push(...php.substitutions);

  const wordPressVersion = environment.wordPress.version.value;
  if (wordPressVersion === undefined) {
    substitutions.push({
      requested: "WordPress version (not reported)",
      substituted: "Playground default",
      why: "the artifact did not state a WordPress version, so none is pinned and the runtime default applies.",
    });
  }

  // Playground always runs WordPress on SQLite. Any reported MySQL or MariaDB
  // site is therefore reconstructed on a different database engine.
  const reportedEngine = environment.database.engine.value;
  const reportedDbVersion = environment.database.version.value;
  if (reportedEngine !== undefined) {
    substitutions.push({
      requested: `${reportedEngine}${reportedDbVersion !== undefined ? ` ${reportedDbVersion}` : ""}`,
      substituted: "SQLite (SQLite Database Integration)",
      why: capabilities.database.note,
    });
  }

  // Instrumentation, not a reported setting: Phase 0 established debug.log as
  // the only authoritative runtime evidence, and it requires these constants.
  // Recorded as a substitution because it changes the reported configuration.
  const reportedDebug = "the report's own WP_DEBUG setting";
  substitutions.push({
    requested: reportedDebug,
    substituted: "WP_DEBUG = true, WP_DEBUG_LOG = true",
    why: "debug logging is enabled so that /wordpress/wp-content/debug.log exists and can be diffed around the trigger. Phase 0 established this as the only authoritative runtime evidence; without it a fatal leaves no readable record.",
  });

  const blueprint: BlueprintV2 = {
    $schema: capabilities.blueprint.schemaUrl,
    version: 2,
    ...(wordPressVersion !== undefined ? { wordpressVersion: wordPressVersion } : {}),
    ...(php.phpVersion !== undefined ? { phpVersion: php.phpVersion } : {}),
    plugins: installs.map((i) => ({ source: i.reference, active: i.active })),
    constants: { WP_DEBUG: true, WP_DEBUG_LOG: true },
  };

  return { blueprint, substitutions };
}
