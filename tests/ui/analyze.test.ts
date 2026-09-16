import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyze, detectFormat, AnalysisError, ARTIFACT_ID } from "../../src/ui/analyze.js";

const fixtures = resolve(__dirname, "../../fixtures");
const read = (p: string): string => readFileSync(resolve(fixtures, p), "utf8");

const SSR = read("ssr/01-storefront-baseline.txt");
const LOG = read("logs/log-01-plugin-fatal.txt");
const LOG2 = read("logs/log-02-theme-fatal.txt");
const PROSE = "Hi team, the shop is down since this morning. Can you look? Thanks.";

describe("format detection", () => {
  it("recognises a System Status Report by its own section headings", () => {
    expect(detectFormat(SSR)).toBe("ssr");
  });

  it("recognises a fatal by the PHP error line", () => {
    expect(detectFormat(LOG)).toBe("log");
  });

  it("recognises both in one paste", () => {
    expect(detectFormat(`${SSR}\n${LOG}`)).toBe("both");
  });

  it("refuses to guess at prose", () => {
    expect(detectFormat(PROSE)).toBe("unrecognised");
    expect(detectFormat("")).toBe("unrecognised");
    // Field-name-looking text without the report's structure is not enough.
    expect(detectFormat("PHP Version: 8.1.27\nWP Version: 6.4.3")).toBe("unrecognised");
  });
});

describe("auto mode runs only adapters with deterministic evidence", () => {
  it("runs only the log adapter on a log-only paste", () => {
    const analysis = analyze(LOG, "auto");
    expect(analysis.detected).toBe("log");
    expect(analysis.format).toEqual(["log"]);
  });

  it("records no System Status provenance for a log-only paste", () => {
    // The defect this fixes: the SSR adapter used to be run over empty text,
    // which recorded a woo-ssr artifact for a report nobody supplied.
    const analysis = analyze(LOG, "auto");
    const adapters = analysis.environment.provenance.artifacts.map((a) => a.adapter);
    expect(adapters).toEqual(["debug-log"]);
    expect(adapters).not.toContain("woo-ssr");
  });

  it("records no log provenance for a report-only paste", () => {
    const analysis = analyze(SSR, "auto");
    const adapters = analysis.environment.provenance.artifacts.map((a) => a.adapter);
    expect(adapters).toEqual(["woo-ssr"]);
    expect(analysis.format).toEqual(["ssr"]);
  });

  it("records both adapters when both are present", () => {
    const analysis = analyze(`${SSR}\n${LOG}`, "auto");
    const adapters = analysis.environment.provenance.artifacts.map((a) => a.adapter);
    expect(adapters).toEqual(["woo-ssr", "debug-log"]);
    expect(analysis.format).toEqual(["ssr", "log"]);
  });

  it("leaves a log-only environment entirely missing rather than falsely parsed", () => {
    const analysis = analyze(LOG, "auto");
    expect(analysis.environment.wordPress.version.status).toBe("missing");
    expect(analysis.environment.server.phpVersion.status).toBe("missing");
    expect(analysis.environment.plugins).toEqual([]);
    expect(analysis.environment.provenance.warnings).toEqual([]);
    // But the signature it genuinely does have is present.
    expect(analysis.environment.signatures).toHaveLength(1);
  });
});

describe("unrecognised and ambiguous input is explicit", () => {
  it("refuses prose rather than producing an empty analysis", () => {
    expect(() => analyze(PROSE, "auto")).toThrow(AnalysisError);
    expect(() => analyze(PROSE, "auto")).toThrow(/does not look like/);
  });

  it("refuses empty input", () => {
    expect(() => analyze("   ", "auto")).toThrow(/Paste a WooCommerce/);
  });

  it("refuses an explicit format the evidence contradicts", () => {
    // Honouring the choice silently would render an empty result that looks
    // like a successful parse.
    expect(() => analyze(LOG, "ssr")).toThrow(/cannot be parsed as a WooCommerce System Status Report/);
    expect(() => analyze(SSR, "log")).toThrow(/cannot be parsed as a PHP fatal/);
  });

  it("honours an explicit format the evidence supports", () => {
    expect(analyze(SSR, "ssr").format).toEqual(["ssr"]);
    expect(analyze(LOG, "log").format).toEqual(["log"]);
  });
});

describe("multiple signatures keep correct evidence line numbers", () => {
  it("produces one signature per fatal", () => {
    const analysis = analyze(`${SSR}\n${LOG}\n${LOG2}`, "auto");
    expect(analysis.environment.signatures).toHaveLength(2);
  });

  it("cites the line each fatal actually occupies in the paste", () => {
    const source = `${SSR}\n${LOG}\n${LOG2}`;
    const analysis = analyze(source, "auto");
    const lines = source.replace(/\r\n?/g, "\n").split("\n");

    for (const signature of analysis.environment.signatures) {
      for (const evidence of signature.evidence ?? []) {
        expect(evidence.artifactId).toBe(ARTIFACT_ID);
        const line = evidence.locator.line as number;
        expect((lines[line - 1] ?? "").trim()).toBe(evidence.excerpt.trim());
      }
    }
  });
});

describe("determinism", () => {
  it("produces identical analyses for identical input", () => {
    const a = analyze(`${SSR}\n${LOG}`, "auto");
    const b = analyze(`${SSR}\n${LOG}`, "auto");
    expect(a.environment).toEqual(b.environment);
    expect(a.diagnosis).toEqual(b.diagnosis);
    expect(a.plan).toEqual(b.plan);
  });
});
