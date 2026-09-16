/**
 * Regenerates committed expectations:
 *   fixtures/expected/*.json          parsed Environment per SSR fixture
 *   fixtures/expected-signatures/*.json  parsed signature per log fixture
 *   fixtures/expected-findings/*.json    diagnosis per named case
 *
 * The generated files are committed and asserted against in tests, so a change
 * in behaviour shows up as a reviewable diff. Regenerating is not a substitute
 * for reading the diff.
 *
 * Run: npx tsx scripts/generate-expected.ts
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSystemStatusReport } from "../src/parsers/woo-ssr/parse.js";
import { parseDebugLog } from "../src/parsers/debug-log/parse.js";
import { attachSignature } from "../src/ir/attach-signature.js";
import { diagnose } from "../src/rules/engine.js";
import { DIAGNOSIS_CASES } from "../tests/cases/diagnosis-cases.js";
import { PLAN_CASES } from "../tests/cases/plan-cases.js";
import { planReproduction } from "../src/repro/plan.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const ssrDir = resolve(root, "fixtures/ssr");
const logDir = resolve(root, "fixtures/logs");
const expectedDir = resolve(root, "fixtures/expected");
const expectedSigDir = resolve(root, "fixtures/expected-signatures");
const expectedFindingsDir = resolve(root, "fixtures/expected-findings");
const expectedPlansDir = resolve(root, "fixtures/expected-plans");

for (const dir of [expectedDir, expectedSigDir, expectedFindingsDir, expectedPlansDir]) {
  mkdirSync(dir, { recursive: true });
}

function write(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
  console.log(`wrote ${basename(path)}`);
}

for (const file of readdirSync(ssrDir).filter((f) => f.endsWith(".txt")).sort()) {
  const artifactId = basename(file, ".txt");
  const text = readFileSync(resolve(ssrDir, file), "utf8");
  write(resolve(expectedDir, `${artifactId}.json`), parseSystemStatusReport({ artifactId, text }));
}

for (const file of readdirSync(logDir).filter((f) => f.endsWith(".txt")).sort()) {
  const artifactId = basename(file, ".txt");
  const text = readFileSync(resolve(logDir, file), "utf8");
  write(resolve(expectedSigDir, `${artifactId}.json`), parseDebugLog({ artifactId, text }));
}

for (const testCase of DIAGNOSIS_CASES) {
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

  write(resolve(expectedFindingsDir, `${testCase.name}.json`), diagnose(environment));
}

for (const planCase of PLAN_CASES) {
  const ssrId = basename(planCase.ssr, ".txt");
  let environment = parseSystemStatusReport({
    artifactId: ssrId,
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

  write(resolve(expectedPlansDir, `${planCase.name}.json`), planReproduction(environment));
}
