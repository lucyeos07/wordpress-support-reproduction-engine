import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { parseSystemStatusReport } from "../src/parsers/woo-ssr/parse.js";
import { resolvePlugin } from "../src/catalog/resolve.js";
import catalog from "../src/catalog/plugin-catalog.json" with { type: "json" };
import type { Environment, PluginKind } from "../src/types/environment.js";
import type { Evidence } from "../src/types/evidence.js";
import type { ParserWarningCode } from "../src/types/warning.js";

const ssrDir = resolve(__dirname, "../fixtures/ssr");
const expectedDir = resolve(__dirname, "../fixtures/expected");

const fixtures = readdirSync(ssrDir)
  .filter((f) => f.endsWith(".txt"))
  .sort();

function load(file: string): { artifactId: string; text: string; env: Environment } {
  const artifactId = basename(file, ".txt");
  const text = readFileSync(resolve(ssrDir, file), "utf8");
  return { artifactId, text, env: parseSystemStatusReport({ artifactId, text }) };
}

function byName(env: Environment, name: string) {
  return env.plugins.find((p) => p.name === name);
}

function ofKind(env: Environment, kind: PluginKind) {
  return env.plugins.filter((p) => p.kind === kind);
}

function warningCodes(env: Environment): ParserWarningCode[] {
  return env.provenance.warnings.map((w) => w.code);
}

/** Every Evidence object anywhere in the Environment, warnings included. */
function collectEvidence(value: unknown, found: Evidence[] = []): Evidence[] {
  if (Array.isArray(value)) {
    for (const v of value) collectEvidence(v, found);
    return found;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["artifactId"] === "string" && typeof obj["excerpt"] === "string" && obj["locator"]) {
      found.push(obj as unknown as Evidence);
      return found;
    }
    for (const v of Object.values(obj)) collectEvidence(v, found);
  }
  return found;
}

describe("fixture corpus", () => {
  it("has at least 5 fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
  });

  it.each(fixtures)("%s matches its expected output", (file) => {
    const { env, artifactId } = load(file);
    const expected: unknown = JSON.parse(
      readFileSync(resolve(expectedDir, `${artifactId}.json`), "utf8"),
    );
    expect(env).toEqual(expected);
  });

  it.each(fixtures)("%s parses deterministically", (file) => {
    const { artifactId, text } = load(file);
    const a = parseSystemStatusReport({ artifactId, text });
    const b = parseSystemStatusReport({ artifactId, text });
    expect(a).toEqual(b);
  });
});

describe("evidence integrity", () => {
  // Provenance is only meaningful if a citation really points at the cited
  // line. This checks every Evidence record in every fixture, including the
  // evidence attached to parser warnings.
  it.each(fixtures)("%s: every excerpt matches the line it cites", (file) => {
    const { env, text, artifactId } = load(file);
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const evidence = collectEvidence(env);

    // A report whose sections were not recognised yields no evidence at all,
    // which is the correct outcome: nothing was read, so nothing is cited.
    if (!warningCodes(env).includes("no_recognised_sections")) {
      expect(evidence.length).toBeGreaterThan(0);
    }

    for (const e of evidence) {
      expect(e.artifactId).toBe(artifactId);
      expect(e.adapter).toBe("woo-ssr");
      const lineNo = e.locator.line;
      expect(lineNo).toBeDefined();
      const actual = lines[(lineNo as number) - 1];
      expect(actual, `${file} line ${String(lineNo)}`).toBeDefined();
      expect((actual ?? "").trim()).toBe(e.excerpt.trim());
    }
  });
});

describe("missing values are never fabricated", () => {
  it("reports absent sections as missing, not as defaults", () => {
    const { env } = load("04-missing-sections.txt");

    expect(env.server.phpVersion.status).toBe("missing");
    expect(env.server.phpVersion.value).toBeUndefined();
    expect(env.server.webServer.status).toBe("missing");
    expect(env.database.version.status).toBe("missing");
    expect(env.database.engine.status).toBe("missing");
    expect(env.theme.name.status).toBe("missing");
    expect(env.theme.isChildTheme.status).toBe("missing");
    expect(env.wooCommerce.databaseVersion.status).toBe("missing");

    expect(env.wordPress.version.value).toBe("5.9.3");
    expect(env.wooCommerce.version.value).toBe("6.4.1");
  });

  it("treats an en-dash placeholder as missing rather than as a value", () => {
    const { env } = load("01-storefront-baseline.txt");
    expect(env.theme.isChildTheme.value).toBe(false);
  });
});

describe("Templates: absent vs explicitly none", () => {
  it("is missing when the report has no Templates section", () => {
    const { env } = load("04-missing-sections.txt");
    expect(env.wooCommerce.templateOverrides.status).toBe("missing");
    expect(env.wooCommerce.templateOverrides.value).toBeUndefined();
  });

  it("is a known empty list when the report states there are no overrides", () => {
    const { env } = load("01-storefront-baseline.txt");
    const overrides = env.wooCommerce.templateOverrides;
    expect(overrides.status).toBe("known");
    expect(overrides.value).toEqual([]);
    // The claim is evidenced by the actual "Overrides: –" line.
    expect(overrides.evidence?.[0]?.excerpt).toContain("Overrides:");
  });

  it("is missing, with a warning, when Templates exists but has no Overrides row", () => {
    const { env } = load("12-templates-without-overrides-row.txt");
    expect(env.wooCommerce.templateOverrides.status).toBe("missing");
    expect(warningCodes(env)).toContain("section_incomplete");
  });
});

describe("plugin kinds", () => {
  it("distinguishes all four categories without collapsing them", () => {
    const { env } = load("09-must-use-and-dropins.txt");

    expect(ofKind(env, "active").map((p) => p.name)).toEqual(["WooCommerce", "Jetpack"]);
    expect(ofKind(env, "inactive").map((p) => p.name)).toEqual(["Classic Editor"]);
    expect(ofKind(env, "must-use").map((p) => p.name)).toEqual([
      "Health Check Troubleshooting Mode",
      "Platform Guardrails",
      "WP Engine System",
    ]);
    expect(ofKind(env, "dropin").map((p) => p.name)).toEqual([
      "advanced-cache.php",
      "object-cache.php",
      "db.php",
    ]);
  });

  it("sets `active` only where the report actually states it", () => {
    const { env } = load("09-must-use-and-dropins.txt");
    expect(byName(env, "WooCommerce")?.active).toBe(true);
    expect(byName(env, "Classic Editor")?.active).toBe(false);
    // Must-use plugins and drop-ins are always loaded, but the report never
    // says "active", so the field stays undefined rather than being invented.
    expect(byName(env, "WP Engine System")?.active).toBeUndefined();
    expect(byName(env, "object-cache.php")?.active).toBeUndefined();
  });

  it("parses a must-use plugin that declares no author", () => {
    const { env } = load("09-must-use-and-dropins.txt");
    const mu = byName(env, "Health Check Troubleshooting Mode");
    expect(mu?.version).toBe("1.7.2");
    expect(mu?.author).toBeUndefined();
    expect(mu?.source).toBe("unknown");
  });

  it("treats drop-in rows as file + description, not as name/author/version", () => {
    const { env } = load("09-must-use-and-dropins.txt");
    const dropin = byName(env, "advanced-cache.php");
    expect(dropin?.version).toBeUndefined();
    expect(dropin?.author).toBeUndefined();
    expect(dropin?.slug).toBeUndefined();
    // The description is not modelled but survives verbatim in the evidence.
    expect(dropin?.evidence?.excerpt).toBe("advanced-cache.php: Advanced caching plugin.");
  });

  it("every plugin carries a kind", () => {
    for (const file of fixtures) {
      const { env } = load(file);
      for (const p of env.plugins) {
        expect(["active", "inactive", "must-use", "dropin"], `${file}:${p.name}`).toContain(p.kind);
      }
    }
  });
});

describe("parser warnings (quality signals, not Findings)", () => {
  it("flags a report whose sections cannot be recognised at all", () => {
    const { env } = load("10-localised-spanish.txt");
    expect(warningCodes(env)).toContain("no_recognised_sections");

    // The point of the warning: without it this looks like a valid English
    // report describing a site that has almost nothing configured.
    expect(env.wordPress.version.status).toBe("missing");
    expect(env.server.phpVersion.status).toBe("missing");
    expect(env.plugins).toEqual([]);
  });

  it("flags a declared plugin count that disagrees with the rows parsed", () => {
    const { env } = load("11-inconsistent-counts-and-rows.txt");
    const warning = env.provenance.warnings.find((w) => w.code === "plugin_count_mismatch");
    expect(warning).toBeDefined();
    expect(warning?.detail).toContain("6");
    expect(warning?.detail).toContain("4");
  });

  it("flags a malformed plugin row and still records the rest of the section", () => {
    const { env } = load("11-inconsistent-counts-and-rows.txt");
    expect(warningCodes(env)).toContain("malformed_plugin_row");
    // The good rows either side are still parsed.
    expect(byName(env, "WooCommerce")?.version).toBe("8.1.0");
    expect(byName(env, "Contact Form 7")?.version).toBe("5.8");
  });

  it("flags an override entry that is not a template path", () => {
    const { env } = load("11-inconsistent-counts-and-rows.txt");
    expect(warningCodes(env)).toContain("malformed_override_row");
    // The valid entry on the following line is still captured.
    const overrides = env.wooCommerce.templateOverrides.value ?? [];
    expect(overrides.map((o) => o.file)).toEqual(["woocommerce/cart/cart.php"]);
  });

  it("emits no warnings for well-formed reports", () => {
    for (const file of [
      "01-storefront-baseline.txt",
      "02-child-theme-outdated-overrides.txt",
      "05-unknown-and-premium-plugins.txt",
      "08-code-fenced-crlf.txt",
      "09-must-use-and-dropins.txt",
    ]) {
      const { env } = load(file);
      expect(env.provenance.warnings, file).toEqual([]);
    }
  });

  it("never carries Finding-shaped fields", () => {
    for (const file of fixtures) {
      const { env } = load(file);
      for (const w of env.provenance.warnings) {
        expect(w).not.toHaveProperty("severity");
        expect(w).not.toHaveProperty("citations");
        expect(w).not.toHaveProperty("fix");
        expect(w).not.toHaveProperty("ruleId");
      }
    }
  });

  it("either agrees with every declared section count or warns about it", () => {
    for (const file of fixtures) {
      const { env, text } = load(file);
      const checks: Array<[RegExp, PluginKind]> = [
        [/### Active Plugins \((\d+)\) ###/, "active"],
        [/### Inactive Plugins \((\d+)\) ###/, "inactive"],
        [/### Must Use Plugins \((\d+)\) ###/, "must-use"],
        [/### Dropin Plugins \((\d+)\) ###/, "dropin"],
      ];
      for (const [re, kind] of checks) {
        const header = re.exec(text);
        if (!header) continue;
        const declared = Number(header[1]);
        const parsed = ofKind(env, kind).length;
        if (declared !== parsed) {
          expect(warningCodes(env), `${file}/${kind}`).toContain("plugin_count_mismatch");
        }
      }
    }
  });
});

describe("plugin slug resolution", () => {
  it("resolves catalogued WordPress.org plugins", () => {
    const { env } = load("01-storefront-baseline.txt");
    expect(byName(env, "WooCommerce")).toMatchObject({
      slug: "woocommerce",
      source: "wordpress.org",
      author: "Automattic",
      version: "8.5.2",
      active: true,
      kind: "active",
    });
    expect(byName(env, "Yoast SEO")?.slug).toBe("wordpress-seo");
  });

  it("leaves unknown plugins unresolved", () => {
    const { env } = load("05-unknown-and-premium-plugins.txt");
    const unknown = byName(env, "Warehouse Sync Bridge");
    expect(unknown?.source).toBe("unknown");
    expect(unknown?.slug).toBeUndefined();
    expect(unknown?.author).toBe("Interlink Systems");
    expect(unknown?.version).toBe("4.0.7");
  });

  it("marks known premium plugins as premium with no slug", () => {
    const { env } = load("05-unknown-and-premium-plugins.txt");
    expect(byName(env, "WooCommerce Subscriptions")).toMatchObject({ source: "premium" });
    expect(byName(env, "WooCommerce Subscriptions")?.slug).toBeUndefined();
  });

  it("refuses to match on name alone when the author is unknown", () => {
    expect(resolvePlugin("WooCommerce", "Some Other Vendor")).toEqual({ source: "unknown" });
    expect(resolvePlugin("WooCommerce", undefined)).toEqual({ source: "unknown" });
    expect(resolvePlugin("WooCommerce", "Automattic")).toEqual({
      slug: "woocommerce",
      source: "wordpress.org",
    });
  });

  it("is case- and whitespace-insensitive", () => {
    expect(resolvePlugin("  woocommerce ", "automattic")).toEqual({
      slug: "woocommerce",
      source: "wordpress.org",
    });
  });
});

describe("catalog integrity", () => {
  const entries = catalog.entries as Array<{
    name: string;
    author: string;
    kind: string;
    slug?: string;
  }>;

  it("has no duplicate (name, author) keys", () => {
    const keys = entries.map((e) => `${e.name.toLowerCase()}|${e.author.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every wordpress.org entry a repository-shaped slug", () => {
    for (const e of entries.filter((x) => x.kind === "wordpress.org")) {
      expect(e.slug, e.name).toBeDefined();
      expect(e.slug, e.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("gives no premium entry a slug", () => {
    for (const e of entries.filter((x) => x.kind === "premium")) {
      expect(e.slug, e.name).toBeUndefined();
    }
  });

  it("requires both a name and an author on every entry", () => {
    for (const e of entries) {
      expect(e.name.trim()).not.toBe("");
      expect(e.author.trim()).not.toBe("");
    }
  });
});

describe("active / inactive distinction", () => {
  it("separates the two sections", () => {
    const { env } = load("01-storefront-baseline.txt");
    expect(ofKind(env, "active").map((p) => p.name)).toEqual([
      "WooCommerce",
      "Yoast SEO",
      "Contact Form 7",
      "Wordfence Security",
    ]);
    expect(ofKind(env, "inactive").map((p) => p.name)).toEqual([
      "Akismet Anti-Spam",
      "Classic Editor",
    ]);
  });

  it("handles a report with no Inactive Plugins section", () => {
    const { env } = load("07-update-suffixes-no-inactive.txt");
    expect(env.plugins.every((p) => p.active === true)).toBe(true);
    expect(env.plugins).toHaveLength(5);
  });
});

describe("formatting variation", () => {
  it("tolerates irregular whitespace around the colon", () => {
    const { env } = load("03-mariadb-litespeed-whitespace.txt");
    expect(env.wordPress.version.value).toBe("6.3.2");
    expect(env.server.webServer.value).toBe("LiteSpeed");
    expect(byName(env, "Elementor")?.version).toBe("3.18.3");
  });

  it("handles a code-fenced report with CRLF line endings", () => {
    const { env } = load("08-code-fenced-crlf.txt");
    expect(env.wordPress.version.value).toBe("6.3.1");
    expect(env.server.webServer.value).toBe("Microsoft-IIS/10.0");
    // The closing fence must not be read as content.
    expect(env.provenance.warnings).toEqual([]);
  });

  it("keeps a colon inside a plugin name intact", () => {
    const { env } = load("08-code-fenced-crlf.txt");
    const akismet = byName(env, "Akismet Anti-spam: Spam Protection");
    expect(akismet).toBeDefined();
    expect(akismet?.slug).toBe("akismet");
    expect(akismet?.version).toBe("5.2");
  });

  it("ignores unknown fields and unknown sections", () => {
    const { env } = load("06-unknown-fields-reordered.txt");
    expect(env.wordPress.version.value).toBe("6.6.1");
    expect(env.server.phpVersion.value).toBe("8.3.7");
    expect(env.plugins).toHaveLength(4);
  });

  it("reads rows regardless of their order within a section", () => {
    const { env } = load("06-unknown-fields-reordered.txt");
    expect(env.theme.name.value).toBe("Blocksy");
    expect(env.theme.version.value).toBe("2.1.0");
  });

  it("strips the update-available suffix from versions", () => {
    const { env } = load("07-update-suffixes-no-inactive.txt");
    expect(byName(env, "WooCommerce")?.version).toBe("7.2.3");
    expect(byName(env, "WooCommerce PayPal Payments")?.version).toBe("2.0.4");
  });
});

describe("theme and database derivation", () => {
  it("captures child and parent theme", () => {
    const { env } = load("02-child-theme-outdated-overrides.txt");
    expect(env.theme.isChildTheme.value).toBe(true);
    expect(env.theme.name.value).toBe("Boutique Child");
    expect(env.theme.parentName.value).toBe("Storefront");
    expect(env.theme.parentVersion.value).toBe("4.3.1");
  });

  it("prefers PHP Memory Limit over WP Memory Limit when both exist", () => {
    const { env } = load("02-child-theme-outdated-overrides.txt");
    expect(env.server.memoryLimit.value).toBe("384 MB");
    expect(env.server.memoryLimit.evidence?.[0]?.excerpt).toContain("PHP Memory Limit");
  });

  it("marks the database engine inferred and records what it was inferred from", () => {
    const mysql = load("01-storefront-baseline.txt").env.database;
    expect(mysql.engine.status).toBe("inferred");
    expect(mysql.engine.value).toBe("MySQL");
    expect(mysql.engine.inferenceBasis).toContain("not stated by the report");
    // The basis must point at the version string it was derived from.
    expect(mysql.engine.evidence?.[0]?.excerpt).toContain("MySQL Version");

    const maria = load("03-mariadb-litespeed-whitespace.txt").env.database;
    expect(maria.engine.status).toBe("inferred");
    expect(maria.engine.value).toBe("MariaDB");
    expect(maria.engine.inferenceBasis).toContain("5.5.5-10.6.16-MariaDB");
    expect(maria.version.value).toBe("5.5.5-10.6.16-MariaDB");
  });

  it("never reports the engine as known", () => {
    for (const file of fixtures) {
      const { env } = load(file);
      expect(env.database.engine.status, file).not.toBe("known");
    }
  });
});

describe("template overrides", () => {
  it("captures each override and flags only the ones the report calls outdated", () => {
    const { env } = load("02-child-theme-outdated-overrides.txt");
    const overrides = env.wooCommerce.templateOverrides.value ?? [];
    expect(overrides).toHaveLength(4);

    expect(overrides[0]).toMatchObject({
      file: "woocommerce/cart/cart.php",
      version: "3.8.0",
      coreVersion: "7.9.0",
      outdated: true,
    });

    const current = overrides.find((o) => o.file === "woocommerce/global/quantity-input.php");
    expect(current?.outdated).toBe(false);
    expect(current?.version).toBeUndefined();
  });

  it("reads a single override given on the Overrides line itself", () => {
    const { env } = load("07-update-suffixes-no-inactive.txt");
    const overrides = env.wooCommerce.templateOverrides.value ?? [];
    expect(overrides).toHaveLength(1);
    expect(overrides[0]?.file).toBe("woocommerce/emails/plain/admin-new-order.php");
  });
});

describe("provenance", () => {
  it("records the artifact each Environment came from", () => {
    const { env } = load("01-storefront-baseline.txt");
    expect(env.provenance.artifacts).toEqual([
      { artifactId: "01-storefront-baseline", adapter: "woo-ssr" },
    ]);
  });

  it("always carries a warnings array", () => {
    for (const file of fixtures) {
      const { env } = load(file);
      expect(Array.isArray(env.provenance.warnings), file).toBe(true);
    }
  });
});
