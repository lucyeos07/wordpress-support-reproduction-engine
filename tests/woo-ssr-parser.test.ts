import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { parseSystemStatusReport } from "../src/parsers/woo-ssr/parse.js";
import { resolvePlugin } from "../src/catalog/resolve.js";
import type { Environment } from "../src/types/environment.js";
import type { Evidence } from "../src/types/evidence.js";

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

/** Every Evidence object anywhere in the Environment. */
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
  it("has 5-10 fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
    expect(fixtures.length).toBeLessThanOrEqual(10);
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
  // line. This checks every Evidence record in every fixture.
  it.each(fixtures)("%s: every excerpt matches the line it cites", (file) => {
    const { env, text, artifactId } = load(file);
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const evidence = collectEvidence(env);

    expect(evidence.length).toBeGreaterThan(0);
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
    expect(env.wooCommerce.templateOverrides).toEqual([]);

    // What IS present still parses.
    expect(env.wordPress.version.value).toBe("5.9.3");
    expect(env.wooCommerce.version.value).toBe("6.4.1");
  });

  it("treats an en-dash placeholder as missing rather than as a value", () => {
    const { env } = load("01-storefront-baseline.txt");
    // "Overrides: –" means no overrides, not an override named "–".
    expect(env.wooCommerce.templateOverrides).toEqual([]);
    expect(env.theme.isChildTheme.value).toBe(false);
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
    });
    expect(byName(env, "Yoast SEO")?.slug).toBe("wordpress-seo");
  });

  it("leaves unknown plugins unresolved", () => {
    const { env } = load("05-unknown-and-premium-plugins.txt");
    const unknown = byName(env, "Warehouse Sync Bridge");
    expect(unknown?.source).toBe("unknown");
    expect(unknown?.slug).toBeUndefined();
    // The name is still preserved so it can become an explicit omission later.
    expect(unknown?.author).toBe("Interlink Systems");
    expect(unknown?.version).toBe("4.0.7");
  });

  it("marks known premium plugins as premium with no slug", () => {
    const { env } = load("05-unknown-and-premium-plugins.txt");
    expect(byName(env, "WooCommerce Subscriptions")).toMatchObject({ source: "premium" });
    expect(byName(env, "WooCommerce Subscriptions")?.slug).toBeUndefined();
  });

  it("refuses to match on name alone when the author is unknown", () => {
    // Same display name, different author: must not resolve to woocommerce.
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

describe("active / inactive distinction", () => {
  it("separates the two sections", () => {
    const { env } = load("01-storefront-baseline.txt");
    const active = env.plugins.filter((p) => p.active === true).map((p) => p.name);
    const inactive = env.plugins.filter((p) => p.active === false).map((p) => p.name);

    expect(active).toEqual(["WooCommerce", "Yoast SEO", "Contact Form 7", "Wordfence Security"]);
    expect(inactive).toEqual(["Akismet Anti-Spam", "Classic Editor"]);
  });

  it("handles a report with no Inactive Plugins section", () => {
    const { env } = load("07-update-suffixes-no-inactive.txt");
    expect(env.plugins.every((p) => p.active === true)).toBe(true);
    expect(env.plugins).toHaveLength(5);
  });

  it("agrees with the count in each plugin section header", () => {
    for (const file of fixtures) {
      const { env, text } = load(file);
      const activeHeader = /### Active Plugins \((\d+)\) ###/.exec(text);
      if (activeHeader) {
        const declared = Number(activeHeader[1]);
        expect(env.plugins.filter((p) => p.active === true), file).toHaveLength(declared);
      }
      const inactiveHeader = /### Inactive Plugins \((\d+)\) ###/.exec(text);
      if (inactiveHeader) {
        const declared = Number(inactiveHeader[1]);
        expect(env.plugins.filter((p) => p.active === false), file).toHaveLength(declared);
      }
    }
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
    // Theme section lists Version before Name.
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

  it("marks the database engine as inferred, never as known", () => {
    const mysql = load("01-storefront-baseline.txt").env.database;
    expect(mysql.engine.status).toBe("inferred");
    expect(mysql.engine.value).toBe("MySQL");
    expect(mysql.engine.inferenceBasis).toBeTruthy();

    const maria = load("03-mariadb-litespeed-whitespace.txt").env.database;
    expect(maria.engine.status).toBe("inferred");
    expect(maria.engine.value).toBe("MariaDB");
    expect(maria.version.value).toBe("5.5.5-10.6.16-MariaDB");
  });
});

describe("template overrides", () => {
  it("captures each override and flags only the ones the report calls outdated", () => {
    const { env } = load("02-child-theme-outdated-overrides.txt");
    const overrides = env.wooCommerce.templateOverrides;
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
    expect(env.wooCommerce.templateOverrides).toHaveLength(1);
    expect(env.wooCommerce.templateOverrides[0]?.file).toBe(
      "woocommerce/emails/plain/admin-new-order.php",
    );
  });
});

describe("provenance", () => {
  it("records the artifact each Environment came from", () => {
    const { env } = load("01-storefront-baseline.txt");
    expect(env.provenance.artifacts).toEqual([
      { artifactId: "01-storefront-baseline", adapter: "woo-ssr" },
    ]);
  });
});
