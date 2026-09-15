import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { parseSystemStatusReport } from "../src/parsers/woo-ssr/parse.js";
import { parseDebugLog } from "../src/parsers/debug-log/parse.js";
import { attachSignature } from "../src/ir/attach-signature.js";
import { diagnose, rules, isAvailable } from "../src/rules/engine.js";
import { matchers, compareVersions } from "../src/rules/matchers.js";
import { DIAGNOSIS_CASES, type DiagnosisCase } from "../src/rules/cases.js";
import type { DiagnosisResult } from "../src/types/diagnosis.js";
import type { Environment } from "../src/types/environment.js";
import type { Finding } from "../src/types/finding.js";

const root = resolve(__dirname, "..");
const ssrDir = resolve(root, "fixtures/ssr");
const logDir = resolve(root, "fixtures/logs");
const expectedFindingsDir = resolve(root, "fixtures/expected-findings");

/** Authoritative publishers. A citation outside this set is not authoritative. */
const AUTHORITATIVE_HOSTS = new Set([
  "developer.wordpress.org",
  "wordpress.org",
  "plugins.svn.wordpress.org",
  "woocommerce.com",
  "developer.woocommerce.com",
  "www.php.net",
  "php.net",
]);

function buildEnvironment(testCase: DiagnosisCase): Environment {
  const ssrId = basename(testCase.ssr, ".txt");
  let environment = parseSystemStatusReport({
    artifactId: ssrId,
    text: readFileSync(resolve(ssrDir, testCase.ssr), "utf8"),
  });
  if (testCase.log !== undefined) {
    const logId = basename(testCase.log, ".txt");
    const logResult = parseDebugLog({
      artifactId: logId,
      text: readFileSync(resolve(logDir, testCase.log), "utf8"),
    });
    environment = attachSignature(environment, logId, logResult);
  }
  return environment;
}

function run(name: string): { environment: Environment; result: DiagnosisResult } {
  const testCase = DIAGNOSIS_CASES.find((c) => c.name === name);
  if (!testCase) throw new Error(`unknown case ${name}`);
  const environment = buildEnvironment(testCase);
  return { environment, result: diagnose(environment) };
}

function findingsFor(result: DiagnosisResult, ruleId: string): Finding[] {
  return result.findings.filter((f) => f.ruleId === ruleId);
}

function outcomeFor(result: DiagnosisResult, ruleId: string): string {
  return result.evaluations.find((e) => e.ruleId === ruleId)?.outcome ?? "absent";
}

/** The verbatim source text an artifactId refers to. */
function artifactText(artifactId: string): string {
  const dir = artifactId.startsWith("log-") ? logDir : ssrDir;
  return readFileSync(resolve(dir, `${artifactId}.txt`), "utf8");
}

describe("rule corpus wiring", () => {
  it("every definition names a matcher that exists, and every matcher is used", () => {
    const declared = new Set(rules.map((r) => r.matcher));
    const implemented = new Set(Object.keys(matchers));
    expect([...declared].sort()).toEqual([...implemented].sort());
  });

  it("rule ids are unique and evaluated in a stable order", () => {
    const ids = rules.map((r) => r.ruleId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
  });

  it("every rule declares severity, confidence, requires and remediation", () => {
    for (const rule of rules) {
      expect(["critical", "high", "medium", "low"], rule.ruleId).toContain(rule.severity);
      expect(["high", "medium", "low"], rule.ruleId).toContain(rule.confidence);
      expect(rule.requires.length, rule.ruleId).toBeGreaterThan(0);
      expect(rule.cause.trim(), rule.ruleId).not.toBe("");
      expect(rule.fix.trim(), rule.ruleId).not.toBe("");
      expect(rule.reproducibilityImpact.trim(), rule.ruleId).not.toBe("");
      expect(rule.citations.length, rule.ruleId).toBeGreaterThan(0);
    }
  });
});

describe("invariants across every case", () => {
  it.each(DIAGNOSIS_CASES.map((c) => c.name))("%s: every Finding carries evidence", (name) => {
    const { result } = run(name);
    for (const finding of result.findings) {
      expect(finding.evidence.length, finding.ruleId).toBeGreaterThan(0);
    }
  });

  it.each(DIAGNOSIS_CASES.map((c) => c.name))(
    "%s: every evidence excerpt exists verbatim in its artifact",
    (name) => {
      const { result } = run(name);
      for (const finding of result.findings) {
        for (const evidence of finding.evidence) {
          const lines = artifactText(evidence.artifactId).replace(/\r\n?/g, "\n").split("\n");
          const line = evidence.locator.line;
          expect(line, `${finding.ruleId} evidence has no line`).toBeDefined();
          expect((lines[(line as number) - 1] ?? "").trim()).toBe(evidence.excerpt.trim());
        }
      }
    },
  );

  it.each(DIAGNOSIS_CASES.map((c) => c.name))(
    "%s: every Finding carries at least one authoritative citation",
    (name) => {
      const { result } = run(name);
      for (const finding of result.findings) {
        expect(finding.citations.length, finding.ruleId).toBeGreaterThan(0);
        for (const citation of finding.citations) {
          expect(citation.title.trim()).not.toBe("");
          expect(citation.publisher.trim()).not.toBe("");
          expect(citation.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          const url = new URL(citation.url);
          expect(url.protocol).toBe("https:");
          expect(AUTHORITATIVE_HOSTS, `${finding.ruleId} cites ${url.host}`).toContain(url.host);
        }
      }
    },
  );

  it.each(DIAGNOSIS_CASES.map((c) => c.name))("%s: diagnosis is deterministic", (name) => {
    const testCase = DIAGNOSIS_CASES.find((c) => c.name === name);
    const a = diagnose(buildEnvironment(testCase!));
    const b = diagnose(buildEnvironment(testCase!));
    expect(a).toEqual(b);
  });

  it.each(DIAGNOSIS_CASES.map((c) => c.name))("%s: matches its expected output", (name) => {
    const { result } = run(name);
    const expected: unknown = JSON.parse(
      readFileSync(resolve(expectedFindingsDir, `${name}.json`), "utf8"),
    );
    expect(result).toEqual(expected);
  });

  it("parser warnings never become Findings", () => {
    // 11 has malformed rows and a count mismatch; 10 is unreadable entirely.
    for (const ssr of ["11-inconsistent-counts-and-rows.txt", "10-localised-spanish.txt"]) {
      const environment = parseSystemStatusReport({
        artifactId: basename(ssr, ".txt"),
        text: readFileSync(resolve(ssrDir, ssr), "utf8"),
      });
      expect(environment.provenance.warnings.length).toBeGreaterThan(0);

      const result = diagnose(environment);
      const warningCodes = new Set(environment.provenance.warnings.map((w) => w.code));
      for (const finding of result.findings) {
        expect(warningCodes).not.toContain(finding.ruleId);
        expect(finding.ruleId).toMatch(/^[A-Z_]+$/);
      }
    }
  });

  it("emits no Finding whose rule reported insufficient evidence", () => {
    for (const testCase of DIAGNOSIS_CASES) {
      const { result } = run(testCase.name);
      const declined = result.evaluations
        .filter((e) => e.outcome === "insufficient_evidence")
        .map((e) => e.ruleId);
      for (const ruleId of declined) {
        expect(findingsFor(result, ruleId), `${testCase.name}/${ruleId}`).toHaveLength(0);
      }
    }
  });
});

describe("FATAL_PLUGIN_OWNER", () => {
  it("positive: plugin-owned fatal resolved through the catalog", () => {
    const { result } = run("plugin-fatal");
    const [finding] = findingsFor(result, "FATAL_PLUGIN_OWNER");

    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("critical");
    expect(finding?.confidence).toBe("high");
    expect(finding?.title).toContain("woocommerce");
    expect(finding?.cause).toContain("Call to undefined method");
    expect(finding?.cause).toContain("Identified plugin slug: woocommerce");
    expect(finding?.reproducibilityImpact).toContain("strong reproduction candidate");
    expect(finding?.citations[0]?.url).toBe(
      "https://developer.wordpress.org/advanced-administration/debug/debug-wordpress/",
    );
    expect(finding?.evidence[0]?.adapter).toBe("debug-log");
  });

  it("positive: uncatalogued plugin directory drops confidence and yields no slug", () => {
    const { environment, result } = run("plugin-fatal-unmediated");
    const [finding] = findingsFor(result, "FATAL_PLUGIN_OWNER");

    expect(environment.signatures[0]?.owner.type).toBe("plugin");
    expect(environment.signatures[0]?.owner.slug).toBeUndefined();
    // Severity is unchanged; only confidence reflects the weaker attribution.
    expect(finding?.severity).toBe("critical");
    expect(finding?.confidence).toBe("low");
    expect(finding?.title).not.toContain(":");
  });

  it("positive: a classless fatal inside a plugin still attributes ownership", () => {
    const { result } = run("memory-exhaustion");
    const [finding] = findingsFor(result, "FATAL_PLUGIN_OWNER");
    expect(finding).toBeDefined();
    expect(finding?.cause).not.toContain("Error class:");
    expect(finding?.cause).toContain("Allowed memory size");
  });

  it("negative: a theme-owned fatal does not trigger it", () => {
    const { result } = run("theme-fatal");
    expect(findingsFor(result, "FATAL_PLUGIN_OWNER")).toHaveLength(0);
    expect(outcomeFor(result, "FATAL_PLUGIN_OWNER")).toBe("no_match");
  });

  it("negative: a core-owned fatal stays core and triggers nothing", () => {
    const { environment, result } = run("core-fatal");
    expect(environment.signatures[0]?.owner.type).toBe("core");
    expect(result.findings).toHaveLength(0);
  });

  it("negative: unrelated plugin data in the report cannot trigger it", () => {
    // 05 lists many plugins, including unknown ones, but has no signature.
    const { result } = run("php-no-requirement-data");
    expect(findingsFor(result, "FATAL_PLUGIN_OWNER")).toHaveLength(0);
    expect(outcomeFor(result, "FATAL_PLUGIN_OWNER")).toBe("insufficient_evidence");
  });
});

describe("FATAL_THEME_OWNER", () => {
  it("positive: theme-owned fatal", () => {
    const { result } = run("theme-fatal");
    const [finding] = findingsFor(result, "FATAL_THEME_OWNER");

    expect(finding?.severity).toBe("critical");
    expect(finding?.confidence).toBe("medium");
    expect(finding?.cause).toContain("storefront-template-functions.php");
    expect(finding?.reproducibilityImpact).toContain("only if the exact theme");
    expect(finding?.citations[0]?.url).toBe(
      "https://developer.wordpress.org/themes/advanced-topics/debugging/",
    );
  });

  it("negative: a plugin-owned fatal does not trigger it", () => {
    const { result } = run("plugin-fatal");
    expect(findingsFor(result, "FATAL_THEME_OWNER")).toHaveLength(0);
  });

  it("negative: the report naming a theme is not enough without a signature", () => {
    // 01 has theme Storefront 4.5.3, but no fatal was reported.
    const { environment, result } = run("no-overrides-reported");
    expect(environment.theme.name.value).toBe("Storefront");
    expect(findingsFor(result, "FATAL_THEME_OWNER")).toHaveLength(0);
    expect(outcomeFor(result, "FATAL_THEME_OWNER")).toBe("insufficient_evidence");
  });
});

describe("PHP_BELOW_PLUGIN_REQUIREMENT", () => {
  it("positive: PHP below the version's declared minimum", () => {
    const { result } = run("php-below-requirement");
    const [finding] = findingsFor(result, "PHP_BELOW_PLUGIN_REQUIREMENT");

    expect(finding?.severity).toBe("high");
    expect(finding?.confidence).toBe("high");
    expect(finding?.cause).toContain("Reported PHP version: 7.3.33");
    expect(finding?.cause).toContain("Required PHP version: >= 7.4");
    expect(finding?.reproducibilityImpact).toContain("Playground pins PHP");

    // Both the parsed PHP row and the parsed WooCommerce row back the claim.
    expect(finding?.evidence.map((e) => e.excerpt)).toEqual([
      "PHP Version: 7.3.33",
      "WC Version: 9.1.2",
    ]);

    // The version-specific requirement is cited alongside the general one.
    const urls = finding?.citations.map((c) => c.url) ?? [];
    expect(urls).toContain("https://plugins.svn.wordpress.org/woocommerce/tags/9.1.2/readme.txt");
  });

  it("negative: PHP comfortably above the requirement", () => {
    const { result } = run("php-satisfies-requirement");
    expect(findingsFor(result, "PHP_BELOW_PLUGIN_REQUIREMENT")).toHaveLength(0);
    expect(outcomeFor(result, "PHP_BELOW_PLUGIN_REQUIREMENT")).toBe("no_match");
  });

  it("negative: a patch-level PHP version still satisfies a two-part requirement", () => {
    // 7.4.3 must satisfy ">= 7.2"; naive string comparison would fail here.
    expect(compareVersions("7.4.3", "7.2")).toBeGreaterThan(0);
    expect(compareVersions("7.4", "7.4.33")).toBeLessThan(0);
    expect(compareVersions("8.1.27", "7.4")).toBeGreaterThan(0);
    expect(compareVersions("7.3.33", "7.4")).toBeLessThan(0);
  });

  it("declines rather than guessing when no requirement is recorded for the version", () => {
    // A WooCommerce version absent from the sourced corpus must not be
    // extrapolated from a neighbouring version.
    const environment = parseSystemStatusReport({
      artifactId: "synthetic",
      text: "### WordPress Environment ###\n\nWC Version: 99.9.9\n\n### Server Environment ###\n\nPHP Version: 5.6.40\n",
    });
    const result = diagnose(environment);
    const evaluation = result.evaluations.find((e) => e.ruleId === "PHP_BELOW_PLUGIN_REQUIREMENT");
    expect(evaluation?.outcome).toBe("not_applicable");
    expect(evaluation?.reason).toContain("no authoritative PHP requirement");
    expect(findingsFor(result, "PHP_BELOW_PLUGIN_REQUIREMENT")).toHaveLength(0);
  });
});

describe("OUTDATED_TEMPLATE_OVERRIDE", () => {
  it("positive: one Finding per override the report marks out of date", () => {
    const { result } = run("outdated-templates");
    const found = findingsFor(result, "OUTDATED_TEMPLATE_OVERRIDE");

    // Four overrides exist; only the three the report calls outdated qualify.
    expect(found).toHaveLength(3);
    expect(found.map((f) => f.title.split(": ")[1])).toEqual([
      "woocommerce/cart/cart.php",
      "woocommerce/checkout/form-checkout.php",
      "woocommerce/single-product/add-to-cart/variable.php",
    ]);

    const first = found[0];
    expect(first?.severity).toBe("medium");
    expect(first?.confidence).toBe("high");
    expect(first?.cause).toContain("Override version: 3.8.0");
    expect(first?.cause).toContain("Core template version: 7.9.0");
    expect(first?.reproducibilityImpact).toContain("Not reproducible from the report alone");
    expect(first?.citations.map((c) => c.url)).toContain(
      "https://developer.woocommerce.com/docs/theming/theme-development/fixing-outdated-woocommerce-templates",
    );
  });

  it("negative: an override the report does not call outdated", () => {
    const { environment, result } = run("current-template-override");
    expect(environment.wooCommerce.templateOverrides.value).toHaveLength(1);
    expect(findingsFor(result, "OUTDATED_TEMPLATE_OVERRIDE")).toHaveLength(0);
    expect(outcomeFor(result, "OUTDATED_TEMPLATE_OVERRIDE")).toBe("no_match");
  });

  it("negative: the report states there are no overrides", () => {
    const { result } = run("no-overrides-reported");
    expect(findingsFor(result, "OUTDATED_TEMPLATE_OVERRIDE")).toHaveLength(0);
    expect(outcomeFor(result, "OUTDATED_TEMPLATE_OVERRIDE")).toBe("no_match");
  });

  it("declines when the report has no Templates section at all", () => {
    const { result } = run("insufficient-evidence");
    expect(outcomeFor(result, "OUTDATED_TEMPLATE_OVERRIDE")).toBe("insufficient_evidence");
  });
});

describe("insufficient evidence (docs/SPEC.md §10)", () => {
  it("produces an information request instead of Findings", () => {
    const { result } = run("insufficient-evidence");

    expect(result.findings).toEqual([]);
    expect(result.informationRequest.missingFields).toEqual([
      "server.phpVersion",
      "signatures",
      "wooCommerce.templateOverrides",
    ]);
    expect(result.informationRequest.requestedBy.map((r) => r.ruleId)).toEqual([
      "FATAL_PLUGIN_OWNER",
      "FATAL_THEME_OWNER",
      "OUTDATED_TEMPLATE_OVERRIDE",
      "PHP_BELOW_PLUGIN_REQUIREMENT",
    ]);
  });

  it("subtracts fields that are already available", () => {
    // 01 has the PHP version, so it must never be requested there.
    const { result } = run("no-overrides-reported");
    expect(result.informationRequest.missingFields).not.toContain("server.phpVersion");
    expect(result.informationRequest.missingFields).not.toContain("wooCommerce.templateOverrides");
  });

  it("deduplicates a field wanted by more than one rule", () => {
    const { result } = run("insufficient-evidence");
    const unique = new Set(result.informationRequest.missingFields);
    expect(unique.size).toBe(result.informationRequest.missingFields.length);
    // Both ownership rules want the signatures collection.
    const wanters = result.informationRequest.requestedBy.filter((r) =>
      r.missing.includes("signatures"),
    );
    expect(wanters.length).toBe(2);
  });

  it("is not a Finding", () => {
    const { result } = run("insufficient-evidence");
    expect(result.findings).toHaveLength(0);
    for (const evaluation of result.evaluations) {
      expect(evaluation).not.toHaveProperty("severity");
      expect(evaluation).not.toHaveProperty("citations");
    }
  });
});

describe("field availability", () => {
  it("treats a missing Field, an absent path and an empty array as unavailable", () => {
    const { environment } = run("insufficient-evidence");
    expect(isAvailable(environment, "server.phpVersion")).toBe(false);
    expect(isAvailable(environment, "signatures")).toBe(false);
    expect(isAvailable(environment, "nonsense.path.here")).toBe(false);
    expect(isAvailable(environment, "wordPress.version")).toBe(true);
  });
});
