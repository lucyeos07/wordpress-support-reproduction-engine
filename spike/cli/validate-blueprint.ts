/**
 * Phase 0 spike: validate a Blueprint against the published Playground schema.
 * Schema is vendored at spike/blueprints/blueprint-schema.json so validation
 * needs no network. Re-fetch it from
 * https://playground.wordpress.net/blueprint-schema.json to refresh.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2019 from "ajv/dist/2019.js";
import addFormats from "ajv-formats";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "../blueprints/blueprint-schema.json");

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateBlueprint(blueprint: unknown): ValidationResult {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
  // The published schema declares a draft URI Ajv does not resolve; the body
  // itself is draft-2019 compatible.
  delete schema["$schema"];

  // validateSchema:false is required, not cosmetic. As of 2026-09-12 the
  // published schema sets `deprecated` to explanatory strings in 7 places
  // (e.g. "Use meta.description instead.") where JSON Schema requires a
  // boolean, so Ajv's meta-validation rejects the schema itself. Instance
  // validation below is unaffected.
  const ajv = new Ajv2019({ strict: false, allErrors: true, validateSchema: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const valid = validate(blueprint);

  return {
    valid: Boolean(valid),
    errors: (validate.errors ?? []).map(
      (e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim(),
    ),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: tsx validate-blueprint.ts <blueprint.json>");
    process.exit(2);
  }
  const blueprint: unknown = JSON.parse(readFileSync(target, "utf8"));
  const result = validateBlueprint(blueprint);
  console.log(JSON.stringify({ target, ...result }, null, 2));
  process.exit(result.valid ? 0 : 1);
}
