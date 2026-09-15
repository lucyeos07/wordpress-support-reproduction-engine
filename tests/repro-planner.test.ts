import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { parseSystemStatusReport } from "../src/parsers/woo-ssr/parse.js";
import { parseDebugLog } from "../src/parsers/debug-log/parse.js";
import { attachSignature } from "../src/ir/attach-signature.js";
import { planReproduction, type PlanResult } from "../src/repro/plan.js";
import { resolvePhpVersion } from "../src/repro/blueprint.js";
import { isUsableSignature, isImplicatedBy, relevanceOf } from "../src/repro/relevance.js";
import { PLAN_CASES, type PlanCase } from "../src/repro/cases.js";
import { validateBlueprint } from "../spike/cli/validate-blueprint.js";
import catalog from "../src/catalog/plugin-catalog.json" with { type: "json" };
import type { Environment } from "../src/types/environment.js";

const root = resolve(__dirname, "..");
const ssrDir = resolve(root, "fixtures/ssr");
const logDir = resolve(root, "fixtures/logs");
const expectedPlansDir = resolve(root, "fixtures/expected-plans");

const CATALOG_SLUGS = new Set(
  (catalog.entries as Array<{ slug?: string }>).map((e) => e.slug).filter(Boolean) as string[],
);

function buildEnvironment(planCase: PlanCase): Environment {
  let environment = parseSystemStatusReport({
    artifactId: basename(planCase.ssr, ".txt"),
    text: readFileSync(resolve(ssrDir, planCase.ssr), "utf8"),
  });
  for (const log of planCase.logs ?? []) {
    const logId = basename(log, ".txt");
    environment = attachSignature(
      environment,
      logId,
      parseDebugLog({ artifactId: logId, text: readFileSync(resolve(logDir, log), "utf8") }),
    );
  }
  return environment;
}

function run(name: string): { environment: Environment; result: PlanResult } {
  const planCase = PLAN_CASES.find((c) => c.name === name);
  if (!planCase) throw new Error(`unknown case ${name}`);
  const environment = buildEnvironment(planCase);
  return { environment, result: planReproduction(environment) };
}

const names = PLAN_CASES.map((c) => c.name);

describe("invariants across every plan", () => {
  it.each(names)("%s is deterministic", (name) => {
    const planCase = PLAN_CASES.find((c) => c.name === name)!;
    expect(planReproduction(buildEnvironment(planCase))).toEqual(
      planReproduction(buildEnvironment(planCase)),
    );
  });

  it.each(names)("%s matches its expected plan", (name) => {
    const { result } = run(name);
    const expected: unknown = JSON.parse(
      readFileSync(resolve(expectedPlansDir, `${name}.json`), "utf8"),
    );
    expect(result).toEqual(expected);
  });

  it.each(names)("%s produces a schema-valid Blueprint", (name) => {
    const { result } = run(name);
    const validation = validateBlueprint(result.plan.blueprint);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it.each(names)("%s never installs a slug that is not in the catalog", (name) => {
    const { result } = run(name);
    const blueprint = result.plan.blueprint as { plugins: Array<{ source: string }> };
    for (const plugin of blueprint.plugins) {
      const slug = plugin.source.split("@")[0] ?? "";
      expect(CATALOG_SLUGS, `${name} installs unguessable slug "${slug}"`).toContain(slug);
    }
  });

  it.each(names)("%s carries one target per signature, in order", (name) => {
    const { environment, result } = run(name);
    expect(result.plan.targets).toHaveLength(environment.signatures.length);
    expect(result.plan.targets.map((t) => t.signatureIndex)).toEqual(
      environment.signatures.map((_, i) => i),
    );
  });

  it.each(names)("%s: an unattempted target always states a reason", (name) => {
    const { result } = run(name);
    for (const target of result.plan.targets) {
      if (!target.attempted) {
        expect(target.reason, `target ${String(target.signatureIndex)}`).toBeTruthy();
        expect(target.trigger).toBeUndefined();
      } else {
        expect(target.trigger).toBeDefined();
      }
    }
  });

  it.each(names)("%s: every omission states a reason and a relevance", (name) => {
    const { result } = run(name);
    for (const omission of result.plan.omissions) {
      expect(omission.why.trim()).not.toBe("");
      expect(["relevant", "irrelevant", "unknown"]).toContain(omission.relevance);
    }
  });

  it.each(names)("%s: no substitution is silent", (name) => {
    const { environment, result } = run(name);
    const substituted = result.plan.substitutions;

    // Playground always runs SQLite, so a reported engine must be declared.
    if (environment.database.engine.value !== undefined) {
      expect(substituted.some((s) => s.substituted.includes("SQLite"))).toBe(true);
    }
    // Debug logging is turned on for evidence capture, which changes the
    // reported configuration and must therefore be declared.
    expect(substituted.some((s) => s.substituted.includes("WP_DEBUG"))).toBe(true);

    for (const substitution of substituted) {
      expect(substitution.requested.trim()).not.toBe("");
      expect(substitution.substituted.trim()).not.toBe("");
      expect(substitution.why.trim()).not.toBe("");
    }
  });

  it.each(names)("%s: the plan carries no diagnostic conclusion", (name) => {
    const { result } = run(name);
    const serialised = JSON.stringify(result);
    for (const forbidden of ["severity", "ruleId", "citations", "reproducibilityImpact"]) {
      expect(serialised.includes(`"${forbidden}"`), `plan leaks ${forbidden}`).toBe(false);
    }
  });

  it.each(names)("%s: the reported environment is represented faithfully", (name) => {
    const { environment, result } = run(name);
    const blueprint = result.plan.blueprint as {
      wordpressVersion?: string;
      phpVersion?: string;
    };

    // A reported WordPress version is pinned exactly, never rounded.
    if (environment.wordPress.version.value !== undefined) {
      expect(blueprint.wordpressVersion).toBe(environment.wordPress.version.value);
    } else {
      expect(blueprint.wordpressVersion).toBeUndefined();
    }

    // Every installed plugin traces back to a reported plugin at its version.
    const reported = new Map(
      environment.plugins
        .filter((p) => p.slug !== undefined)
        .map((p) => [p.slug as string, p.version]),
    );
    const installed = (result.plan.blueprint as { plugins: Array<{ source: string }> }).plugins;
    for (const plugin of installed) {
      const [slug, version] = plugin.source.split("@");
      expect(reported.has(slug ?? "")).toBe(true);
      if (version !== undefined) expect(reported.get(slug ?? "")).toBe(version);
    }
  });
});

describe("usability and relevance (docs/SPEC.md §6.1)", () => {
  it("treats a signature with no file, frames or owner as unusable", () => {
    const { environment, result } = run("unusable-signature");
    expect(environment.signatures).toHaveLength(1);
    expect(isUsableSignature(environment.signatures[0]!)).toBe(false);
    expect(result.plan.targets[0]?.verdict.tier).toBe("E");
    expect(result.plan.targets[0]?.attempted).toBe(false);
  });

  it("treats a signature with an identified owner as usable", () => {
    const { environment } = run("plugin-fatal-reproducible");
    expect(isUsableSignature(environment.signatures[0]!)).toBe(true);
  });

  it("marks an inactive plugin that no signature implicates as irrelevant", () => {
    const { environment } = run("inactive-irrelevant");
    const akismet = environment.plugins.find((p) => p.name === "Akismet Anti-Spam");
    expect(akismet?.kind).toBe("inactive");
    expect(relevanceOf(akismet!, environment.signatures)).toBe("irrelevant");
  });

  it("marks the implicated plugin relevant", () => {
    const { environment } = run("plugin-fatal-reproducible");
    const woo = environment.plugins.find((p) => p.slug === "woocommerce");
    expect(relevanceOf(woo!, environment.signatures)).toBe("relevant");
  });

  it("never implicates a plugin whose slug is unresolved", () => {
    // The log names wp-content/plugins/warehouse-sync-bridge/, and the report
    // lists "Warehouse Sync Bridge" — but with no resolved slug there is no
    // known path, so no deterministic association exists (§6.1).
    const { environment } = run("unresolved-plugin");
    const bridge = environment.plugins.find((p) => p.name === "Warehouse Sync Bridge");
    expect(bridge?.slug).toBeUndefined();
    expect(isImplicatedBy(bridge!, environment.signatures[0]!)).toBe(false);
    expect(relevanceOf(bridge!, environment.signatures)).toBe("unknown");
  });

  it("does not let an active but unimplicated plugin be called irrelevant", () => {
    const { environment } = run("plugin-fatal-reproducible");
    const yoast = environment.plugins.find((p) => p.slug === "wordpress-seo");
    expect(yoast?.kind).toBe("active");
    expect(relevanceOf(yoast!, environment.signatures)).toBe("unknown");
  });
});

describe("component handling", () => {
  it("omits must-use plugins and drop-ins rather than installing them", () => {
    const { environment, result } = run("must-use-and-dropins");
    const installedSlugs = (
      result.plan.blueprint as { plugins: Array<{ source: string }> }
    ).plugins.map((p) => p.source.split("@")[0]);

    for (const plugin of environment.plugins) {
      if (plugin.kind !== "must-use" && plugin.kind !== "dropin") continue;
      expect(installedSlugs).not.toContain(plugin.name);
      const omission = result.plan.omissions.find((o) => o.component.includes(plugin.name));
      expect(omission, `${plugin.name} must be an explicit omission`).toBeDefined();
    }

    expect(result.plan.omissions.some((o) => o.component.startsWith("drop-in"))).toBe(true);
    expect(result.plan.omissions.some((o) => o.component.startsWith("must-use plugin"))).toBe(true);
  });

  it("records premium plugins as omissions and never as installed", () => {
    const { environment, result } = run("premium-omission");
    const premium = environment.plugins.filter((p) => p.source === "premium");
    expect(premium.length).toBeGreaterThan(0);

    for (const plugin of premium) {
      const omission = result.plan.omissions.find((o) => o.component.includes(plugin.name));
      expect(omission, `${plugin.name} omitted`).toBeDefined();
      expect(omission?.why).toContain("premium");
    }
  });

  it("omits an unresolved plugin with the reason preserved", () => {
    const { result } = run("unresolved-plugin");
    const omission = result.plan.omissions.find((o) =>
      o.component.includes("Warehouse Sync Bridge"),
    );
    expect(omission?.why).toContain("slug could not be resolved");
    expect(omission?.why).toContain("never guessed");
  });

  it("installs inactive plugins but does not activate them", () => {
    const { result } = run("inactive-irrelevant");
    const blueprint = result.plan.blueprint as {
      plugins: Array<{ source: string; active: boolean }>;
    };
    const akismet = blueprint.plugins.find((p) => p.source.startsWith("akismet"));
    expect(akismet?.active).toBe(false);
    const woo = blueprint.plugins.find((p) => p.source.startsWith("woocommerce@"));
    expect(woo?.active).toBe(true);
  });
});

describe("trigger derivation (docs/SPEC.md §8.1)", () => {
  it("derives plugin activation for a resolvable plugin owner", () => {
    const { result } = run("plugin-fatal-reproducible");
    expect(result.plan.targets[0]?.trigger).toEqual({
      kind: "plugin_activation",
      slug: "woocommerce",
    });
  });

  it("derives an admin page load when a frame names a wp-admin page", () => {
    const { result } = run("admin-page-trigger");
    expect(result.plan.targets[0]?.trigger).toEqual({
      kind: "admin_page_load",
      path: "/wp-admin/edit.php",
    });
  });

  it("derives boot for a core-owned fatal", () => {
    const { result } = run("multiple-signatures");
    expect(result.plan.targets[2]?.trigger).toEqual({ kind: "boot" });
  });

  it("refuses to attempt a theme-owned failure", () => {
    const { result } = run("theme-fatal");
    const target = result.plan.targets[0];
    expect(target?.attempted).toBe(false);
    expect(target?.reason).toContain("owned by a theme");
    expect(target?.verdict.tier).toBe("D");
  });

  it("refuses to attempt an unresolvable plugin owner", () => {
    const { result } = run("unresolved-plugin");
    const target = result.plan.targets[0];
    expect(target?.attempted).toBe(false);
    expect(target?.reason).toContain("not in the bundled catalog");
  });

  it("never emits a trigger outside the supported set", () => {
    for (const name of names) {
      const { result } = run(name);
      for (const target of result.plan.targets) {
        if (target.trigger === undefined) continue;
        expect(["boot", "plugin_activation", "admin_page_load"]).toContain(target.trigger.kind);
      }
    }
  });
});

describe("tiers (docs/SPEC.md §6)", () => {
  it("keeps targets independent: one blocked target does not downgrade another", () => {
    const { result } = run("multiple-signatures");
    expect(result.plan.targets).toHaveLength(3);

    expect(result.plan.targets[0]?.verdict.tier).toBe("B"); // plugin, reproducible
    expect(result.plan.targets[1]?.verdict.tier).toBe("D"); // theme, blocked
    expect(result.plan.targets[2]?.verdict.tier).toBe("B"); // core, boot

    // The plan summarises without overwriting.
    expect(result.plan.verdict.tier).toBe("B");
    expect(result.plan.reasons.some((r) => r.code === "target_summary")).toBe(true);
  });

  it("is not worst-tier-wins", () => {
    const { result } = run("multiple-signatures");
    const tiers = result.plan.targets.map((t) => t.verdict.tier);
    expect(tiers).toContain("D");
    expect(result.plan.verdict.tier).not.toBe("D");
  });

  it("returns E when there is no signature to reproduce", () => {
    const { result } = run("insufficient-evidence");
    expect(result.plan.targets).toEqual([]);
    expect(result.plan.verdict.tier).toBe("E");
    expect(result.plan.verdict.status).toBe("insufficient_evidence");
    expect(result.plan.reasons.some((r) => r.code === "no_signatures")).toBe(true);
  });

  it("returns E for a target whose signature is unusable", () => {
    const { result } = run("unusable-signature");
    expect(result.plan.targets[0]?.verdict.status).toBe("insufficient_evidence");
  });
});

describe("Blueprint generation (docs/SPEC.md §11)", () => {
  it("substitutes an unavailable PHP version and says so", () => {
    const { result } = run("php-version-unavailable");
    const blueprint = result.plan.blueprint as { phpVersion?: string };
    expect(blueprint.phpVersion).toBe("7.4");

    const substitution = result.plan.substitutions.find((s) => s.requested.includes("7.3.33"));
    expect(substitution?.substituted).toContain("7.4");
    expect(substitution?.why).toContain("does not offer PHP 7.3");
  });

  it("records the unpinnable patch release as a substitution", () => {
    const { result } = run("plugin-fatal-reproducible");
    const substitution = result.plan.substitutions.find((s) => s.requested === "PHP 8.1.27");
    expect(substitution?.substituted).toContain("8.1");
    expect(substitution?.why).toContain("major.minor only");
  });

  it("enables debug logging and declares it", () => {
    const { result } = run("plugin-fatal-reproducible");
    const blueprint = result.plan.blueprint as { constants: Record<string, boolean> };
    expect(blueprint.constants).toEqual({ WP_DEBUG: true, WP_DEBUG_LOG: true });
  });

  it("emits Blueprint v2 with only published properties", () => {
    const { result } = run("plugin-fatal-reproducible");
    const blueprint = result.plan.blueprint as Record<string, unknown>;
    expect(blueprint["version"]).toBe(2);
    expect(Object.keys(blueprint).sort()).toEqual([
      "$schema",
      "constants",
      "phpVersion",
      "plugins",
      "version",
      "wordpressVersion",
    ]);
  });

  it("omits a version it cannot pin rather than defaulting silently", () => {
    const { result } = run("insufficient-evidence");
    const blueprint = result.plan.blueprint as { phpVersion?: string };
    expect(blueprint.phpVersion).toBeUndefined();
    expect(
      result.plan.substitutions.some((s) => s.requested.includes("not reported")),
    ).toBe(true);
  });

  it("picks the lowest supported PHP above the reported one", () => {
    expect(resolvePhpVersion("7.3.33").phpVersion).toBe("7.4");
    expect(resolvePhpVersion("7.1").phpVersion).toBe("7.4");
    expect(resolvePhpVersion("8.2.15").phpVersion).toBe("8.2");
    expect(resolvePhpVersion("8.2.15").material).toBe(false);
    expect(resolvePhpVersion("7.3").material).toBe(true);
  });
});

describe("verification plan", () => {
  it("is produced separately from any verification result", () => {
    const { result } = run("plugin-fatal-reproducible");
    // Phase 4 plans; Phase 5 executes. Nothing has been verified yet.
    expect(result.plan.verification).toBeUndefined();
    expect(result.verificationPlan).toBeDefined();
  });

  it("states the debug.log diff strategy rather than reading boot errors", () => {
    const { result } = run("plugin-fatal-reproducible");
    const strategy = result.verificationPlan.logStrategy;
    expect(strategy.source).toBe("debug.log");
    expect(strategy.path).toBe("/wordpress/wp-content/debug.log");
    expect(strategy.steps.join(" ")).toContain("never evidence of reproduction");
    expect(strategy.steps.join(" ")).toContain("Diff the two snapshots");
  });

  it("carries the expected signature for each target", () => {
    const { result } = run("plugin-fatal-reproducible");
    const target = result.verificationPlan.targets[0];
    expect(target?.expectedSignature.errorClass).toBe("Error");
    expect(target?.expectedSignature.file).toContain("wc-cart-functions.php");
    expect(target?.expectedSignature.line).toBe(412);
  });

  it("lists expected installed and omitted components", () => {
    const { result } = run("must-use-and-dropins");
    const checks = result.verificationPlan.environmentChecks;
    expect(checks.expectedInstalledComponents.length).toBeGreaterThan(0);
    expect(checks.expectedOmittedComponents.some((c) => c.startsWith("drop-in"))).toBe(true);
    expect(checks.howToCheck).toContain("get_option('active_plugins')");
  });
});
