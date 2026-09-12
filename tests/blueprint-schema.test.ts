import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { validateBlueprint } from "../spike/cli/validate-blueprint.js";

const blueprintDir = resolve(__dirname, "../spike/blueprints");
const blueprintFiles = readdirSync(blueprintDir).filter(
  (f) => f.endsWith(".json") && f !== "blueprint-schema.json",
);

describe("Blueprint schema validation", () => {
  it("finds blueprints to validate", () => {
    expect(blueprintFiles.length).toBeGreaterThan(0);
  });

  it.each(blueprintFiles)("%s validates against the published schema", (file) => {
    const blueprint: unknown = JSON.parse(readFileSync(resolve(blueprintDir, file), "utf8"));
    const result = validateBlueprint(blueprint);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  // Without this, a validator that accepts everything would pass the suite above.
  it("rejects an unknown top-level property", () => {
    const result = validateBlueprint({ version: 2, phpVersion: "8.2", nonsense: true });
    expect(result.valid).toBe(false);
  });

  it("rejects a malformed phpVersion", () => {
    const result = validateBlueprint({ version: 2, phpVersion: "not-a-version" });
    expect(result.valid).toBe(false);
  });
});
