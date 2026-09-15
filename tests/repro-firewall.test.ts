import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * docs/SPEC.md §7: "the reproduction module does not import the diagnostic
 * module. A test asserts the absence of that dependency edge."
 *
 * This is structural, not behavioural: it fails if anyone ever adds the import,
 * whether or not the value is used.
 */
const reproDir = resolve(__dirname, "../src/repro");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const files = sourceFiles(reproDir);

/** Anything that carries or produces a diagnostic conclusion. */
const FORBIDDEN_IMPORTS = [
  "rules/",
  "types/finding",
  "types/diagnosis",
  "types/rule",
];

describe("reproduction firewall (docs/SPEC.md §7)", () => {
  it("finds the reproduction module", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [f.replace(resolve(__dirname, ".."), "")]))(
    "%s imports nothing from the diagnostic layer",
    (relative) => {
      const full = resolve(__dirname, "..", relative.replace(/^\//, ""));
      const source = readFileSync(full, "utf8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");

      for (const specifier of imports) {
        for (const forbidden of FORBIDDEN_IMPORTS) {
          expect(
            specifier.includes(forbidden),
            `${relative} imports "${specifier}", which crosses the firewall`,
          ).toBe(false);
        }
      }
    },
  );

  it("never mentions a diagnostic conclusion by name", () => {
    // Catches reading a Finding through a structural type or `any`, which an
    // import check alone would miss.
    const forbiddenIdentifiers = [
      "Finding",
      "diagnose(",
      "severity",
      "confidence",
      "reproducibilityImpact",
      "citations",
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      // Strip comments: the firewall is about code, and the modules discuss
      // the boundary in prose.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const identifier of forbiddenIdentifiers) {
        expect(code.includes(identifier), `${file} references "${identifier}"`).toBe(false);
      }
    }
  });
});
