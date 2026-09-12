/**
 * Regenerates fixtures/expected/*.json from fixtures/ssr/*.txt.
 *
 * The generated files are committed and asserted against in tests, so a parser
 * change shows up as a reviewable diff. Regenerating is not a substitute for
 * reading the diff: an expectation nobody looked at proves nothing.
 *
 * Run: npx tsx scripts/generate-expected.ts
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSystemStatusReport } from "../src/parsers/woo-ssr/parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const ssrDir = resolve(here, "../fixtures/ssr");
const expectedDir = resolve(here, "../fixtures/expected");

mkdirSync(expectedDir, { recursive: true });

const files = readdirSync(ssrDir)
  .filter((f) => f.endsWith(".txt"))
  .sort();

for (const file of files) {
  const artifactId = basename(file, ".txt");
  const text = readFileSync(resolve(ssrDir, file), "utf8");
  const environment = parseSystemStatusReport({ artifactId, text });
  const out = resolve(expectedDir, `${artifactId}.json`);
  writeFileSync(out, JSON.stringify(environment, null, 2) + "\n", "utf8");
  console.log(`wrote ${basename(out)}`);
}
