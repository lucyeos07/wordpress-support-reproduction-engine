import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { parseDebugLog, attributeOwner } from "../src/parsers/debug-log/parse.js";

const logDir = resolve(__dirname, "../fixtures/logs");
const expectedDir = resolve(__dirname, "../fixtures/expected-signatures");

const fixtures = readdirSync(logDir)
  .filter((f) => f.endsWith(".txt"))
  .sort();

function load(file: string) {
  const artifactId = basename(file, ".txt");
  const text = readFileSync(resolve(logDir, file), "utf8");
  return { artifactId, text, result: parseDebugLog({ artifactId, text }) };
}

describe("debug log fixtures", () => {
  it.each(fixtures)("%s matches its expected signature", (file) => {
    const { artifactId, result } = load(file);
    const expected: unknown = JSON.parse(
      readFileSync(resolve(expectedDir, `${artifactId}.json`), "utf8"),
    );
    expect(result).toEqual(expected);
  });

  it.each(fixtures)("%s parses deterministically", (file) => {
    const { artifactId, text } = load(file);
    expect(parseDebugLog({ artifactId, text })).toEqual(parseDebugLog({ artifactId, text }));
  });

  it.each(fixtures)("%s: signature evidence points at the real line", (file) => {
    const { text, result } = load(file);
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    for (const evidence of result.signature?.evidence ?? []) {
      const line = evidence.locator.line as number;
      expect((lines[line - 1] ?? "").trim()).toBe(evidence.excerpt.trim());
    }
  });
});

describe("signature extraction", () => {
  it("extracts class, message, file and line from an uncaught error", () => {
    const { result } = load("log-01-plugin-fatal.txt");
    const signature = result.signature;

    expect(signature?.errorClass).toBe("Error");
    expect(signature?.message).toBe("Call to undefined method WC_Cart::get_totals_for_display()");
    expect(signature?.file).toBe(
      "/var/www/html/wp-content/plugins/woocommerce/includes/wc-cart-functions.php",
    );
    expect(signature?.line).toBe(412);
    expect(signature?.frames?.length).toBeGreaterThan(0);
    expect(signature?.frames?.[0]?.raw).toContain("#0");
  });

  it("leaves errorClass undefined for a fatal that genuinely has no class", () => {
    const { result } = load("log-05-memory-exhaustion.txt");
    expect(result.signature?.errorClass).toBeUndefined();
    expect(result.signature?.message).toContain("Allowed memory size");
    expect(result.signature?.line).toBe(208);
  });

  it("returns no signature and warns when the input holds no fatal", () => {
    const { result } = load("log-06-not-a-log.txt");
    expect(result.signature).toBeUndefined();
    expect(result.warnings.map((w) => w.code)).toContain("no_recognised_sections");
  });
});

describe("ownership attribution (docs/SPEC.md §4.5)", () => {
  it("resolves a catalogued plugin directory to a slug at high confidence", () => {
    expect(attributeOwner("/var/www/html/wp-content/plugins/woocommerce/includes/x.php")).toEqual({
      type: "plugin",
      slug: "woocommerce",
      confidence: "high",
    });
  });

  it("refuses to turn an uncatalogued directory into a slug", () => {
    const owner = attributeOwner("/wp-content/plugins/warehouse-sync-bridge/src/bootstrap.php");
    expect(owner.type).toBe("plugin");
    expect(owner.slug).toBeUndefined();
    expect(owner.confidence).toBe("low");
  });

  it("identifies a theme but never gives it a slug", () => {
    const owner = attributeOwner("/wp-content/themes/storefront/inc/functions.php");
    expect(owner.type).toBe("theme");
    expect(owner.slug).toBeUndefined();
    expect(owner.confidence).toBe("medium");
  });

  it("keeps core as core", () => {
    expect(attributeOwner("/var/www/html/wp-includes/class-wp-query.php").type).toBe("core");
    expect(attributeOwner("/var/www/html/wp-admin/includes/plugin.php").type).toBe("core");
  });

  it("keeps an unrecognised path unknown rather than guessing", () => {
    const owner = attributeOwner("/srv/app/lib/vendor/thing.php");
    expect(owner.type).toBe("unknown");
    expect(owner.slug).toBeUndefined();
    expect(owner.confidence).toBe("low");
  });

  it("attributes each fixture to the expected owner", () => {
    expect(load("log-01-plugin-fatal.txt").result.signature?.owner).toMatchObject({
      type: "plugin",
      slug: "woocommerce",
    });
    expect(load("log-02-theme-fatal.txt").result.signature?.owner.type).toBe("theme");
    expect(load("log-03-core-fatal.txt").result.signature?.owner.type).toBe("core");
    expect(load("log-04-unmediated-plugin.txt").result.signature?.owner).toMatchObject({
      type: "plugin",
      confidence: "low",
    });
  });
});
