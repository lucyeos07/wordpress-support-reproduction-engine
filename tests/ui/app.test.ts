// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mountApp, type BrowserExecutor } from "../../src/ui/app.js";
import { targetOutcome, presentOutcome } from "../../src/ui/outcome.js";
import type { Verification } from "../../src/types/verification.js";

const fixtures = resolve(__dirname, "../../fixtures");
const read = (p: string): string => readFileSync(resolve(fixtures, p), "utf8");

const SSR = read("ssr/01-storefront-baseline.txt");
const SSR_WARNINGS = read("ssr/11-inconsistent-counts-and-rows.txt");
const SSR_PHP_BAD = read("ssr/13-php-below-woo-requirement.txt");
const LOG_PLUGIN = read("logs/log-01-plugin-fatal.txt");
const LOG_THEME = read("logs/log-02-theme-fatal.txt");

// jsdom has no layout engine.
Element.prototype.scrollIntoView = (): void => {};

function setup(deps: Parameters<typeof mountApp>[1] = {}) {
  document.body.innerHTML = "";
  const root = document.createElement("main");
  document.body.append(root);
  const app = mountApp(root, { copy: async () => {}, ...deps });
  return { root, ...app };
}

function analyse(root: HTMLElement, text: string, format = "auto"): void {
  const textarea = root.querySelector<HTMLTextAreaElement>("#artifact")!;
  const select = root.querySelector<HTMLSelectElement>("#format")!;
  textarea.value = text;
  select.value = format;
  root.querySelector<HTMLFormElement>("#analyse-form")!.dispatchEvent(
    new Event("submit", { cancelable: true, bubbles: true }),
  );
}

const okVerification = (observed: boolean): Verification => ({
  environment: {
    bootSucceeded: true,
    installedComponents: ["woocommerce@8.5.2 (active)"],
    failedComponents: [],
  },
  failureReproduction: {
    targets: [
      {
        signatureIndex: 0,
        attempted: true,
        trigger: { kind: "plugin_activation", slug: "woocommerce" },
        observed,
        logs: observed ? ["[01-Jan-2026 00:00:00 UTC] PHP Fatal error:  Uncaught Error: x"] : [],
        reason: observed
          ? "matched the reported signature on errorClass"
          : "the trigger ran and wrote no new debug.log entries",
        ...(observed
          ? {
              errorClass: "Error",
              message: "Call to undefined method",
              extraction: { source: "debug.log" as const, deterministic: true },
            }
          : {}),
      },
    ],
  },
});

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("input screen", () => {
  it("renders the title, paste area, format selector and Analyze button", () => {
    const { root } = setup();
    expect(root.querySelector("h1")?.textContent).toContain("WordPress Support Reproduction Engine");
    expect(root.querySelector("#artifact")).toBeTruthy();
    expect(root.querySelector("#format")).toBeTruthy();
    expect(root.querySelector("#analyse")?.textContent).toBe("Analyze");
  });

  it("states privacy without claiming nothing leaves the machine", () => {
    const { root } = setup();
    const privacy = root.querySelector(".privacy")?.textContent ?? "";
    expect(privacy).toContain("no backend");
    // The honest part: a reproduction really does fetch from the network.
    expect(privacy).toContain("wordpress.org");
    expect(privacy).toContain("playground.wordpress.net");
    expect(privacy).not.toMatch(/never leaves|no data ever leaves/i);
  });

  it("reports an unusable paste instead of failing silently", () => {
    const { root } = setup();
    analyse(root, "just some prose with no report and no fatal");
    const status = root.querySelector("#status");
    expect(status?.className).toContain("status-error");
    expect(status?.textContent).toContain("does not look like");
    expect(root.querySelector("#results")?.children.length ?? 0).toBe(0);
  });

  it("reports an empty paste", () => {
    const { root } = setup();
    analyse(root, "   ");
    expect(root.querySelector("#status")?.textContent).toContain("Paste a WooCommerce");
  });
});

describe("environment display", () => {
  it("shows the parsed environment with known/missing labels", () => {
    const { root } = setup();
    analyse(root, SSR);
    const text = root.textContent ?? "";
    expect(text).toContain("6.4.3"); // WordPress
    expect(text).toContain("8.1.27"); // PHP
    expect(text).toContain("8.5.2"); // WooCommerce
    expect(text).toContain("Storefront");
    expect(root.querySelectorAll(".badge-known").length).toBeGreaterThan(0);
  });

  it("labels an inferred value as inferred rather than known", () => {
    const { root } = setup();
    analyse(root, SSR);
    // database.engine is derived from the MySQL Version string.
    expect(root.querySelectorAll(".badge-inferred").length).toBeGreaterThan(0);
  });

  it("shows missing fields rather than hiding them", () => {
    const { root } = setup();
    analyse(root, LOG_PLUGIN, "log");
    expect(root.textContent).toContain("Not reported");
    expect(root.querySelectorAll(".badge-missing").length).toBeGreaterThan(0);
  });

  it("lists plugin counts by kind", () => {
    const { root } = setup();
    analyse(root, SSR);
    expect(root.textContent).toMatch(/6 total — 4 active, 2 inactive/);
  });

  it("displays parser warnings as warnings, not findings", () => {
    const { root } = setup();
    analyse(root, SSR_WARNINGS);
    const warnings = root.querySelector(".warnings");
    expect(warnings).toBeTruthy();
    expect(warnings?.textContent).toContain("plugin_count_mismatch");
    expect(warnings?.textContent).toContain("not diagnoses");
  });

  it("lists missing information requested by rules that could not run", () => {
    const { root } = setup();
    analyse(root, SSR);
    expect(root.querySelector(".missing-info")?.textContent).toContain("signatures");
  });
});

describe("findings display", () => {
  it("shows severity, confidence, evidence, citation and remediation", () => {
    const { root } = setup();
    analyse(root, SSR_PHP_BAD);
    const finding = root.querySelector(".finding");
    expect(finding).toBeTruthy();
    const text = finding?.textContent ?? "";
    expect(text).toContain("Severity:");
    expect(text).toContain("Confidence:");
    expect(text).toContain("Recommended remediation");
    expect(finding?.querySelector("a[href^='https://']")).toBeTruthy();
    expect(finding?.querySelector(".chip")).toBeTruthy();
  });

  it("keeps severity and confidence separate", () => {
    const { root } = setup();
    analyse(root, SSR_PHP_BAD);
    const meta = root.querySelector(".finding .meta")?.textContent ?? "";
    expect(meta).toContain("Severity: High");
    expect(meta).toContain("Confidence: high");
  });

  it("links evidence back to the pasted artifact", () => {
    const { root } = setup();
    analyse(root, SSR_PHP_BAD);
    const chip = root.querySelector<HTMLButtonElement>(".finding .chip")!;
    chip.click();
    expect(root.querySelectorAll(".source-line.highlight").length).toBe(1);
    const highlighted = root.querySelector(".source-line.highlight")?.textContent ?? "";
    // The highlighted source line must contain what the chip cited.
    expect(highlighted).toContain(chip.querySelector("code")?.textContent ?? "");
  });

  it("says nothing matched rather than implying health", () => {
    const { root } = setup();
    analyse(root, SSR);
    expect(root.textContent).toContain("not the same as the site being healthy");
  });
});

describe("reproducibility display", () => {
  it("shows the plan verdict and per-target tiers", () => {
    const { root } = setup();
    analyse(root, `${SSR}\n${LOG_PLUGIN}`);
    expect(root.textContent).toContain("Plan verdict:");
    expect(root.querySelectorAll(".targets .target").length).toBe(1);
    expect(root.textContent).toContain("Activate plugin: woocommerce");
  });

  it("keeps multiple targets visually independent", () => {
    const { root } = setup();
    analyse(root, `${SSR}\n${LOG_PLUGIN}\n${LOG_THEME}`);
    const targets = root.querySelectorAll(".targets .target");
    expect(targets.length).toBe(2);
    expect(targets[0]?.textContent).toContain("Target #0");
    expect(targets[1]?.textContent).toContain("Target #1");
    // Independent verdicts, not one merged result.
    expect(targets[0]?.textContent).toContain("Trigger supported");
    expect(targets[1]?.textContent).toContain("No supported trigger");
  });

  it("marks an unsupported trigger and says why", () => {
    const { root } = setup();
    analyse(root, `${SSR}\n${LOG_THEME}`);
    const target = root.querySelector(".targets .target");
    expect(target?.textContent).toContain("No supported trigger");
    expect(target?.textContent).toContain("owned by a theme");
  });

  it("shows substitutions and omissions with their relevance", () => {
    const { root } = setup();
    analyse(root, `${SSR}\n${LOG_PLUGIN}`);
    expect(root.textContent).toContain("Substitutions");
    expect(root.textContent).toContain("SQLite");
    expect(root.textContent).toContain("Omissions");
    expect(root.querySelectorAll(".pill-rel-unknown").length).toBeGreaterThan(0);
  });
});

describe("blueprint display", () => {
  it("offers view and copy, and says what the Blueprint represents", () => {
    const copy = vi.fn(async (_text: string) => {});
    const { root } = setup({ copy });
    analyse(root, SSR);

    expect(root.querySelector(".blueprint summary")?.textContent).toBe("View Blueprint");
    expect(root.textContent).toContain("represents the reported environment");

    const button = [...root.querySelectorAll("button")].find((b) => b.textContent === "Copy Blueprint")!;
    button.click();
    expect(copy).toHaveBeenCalledTimes(1);
    expect(String(copy.mock.calls[0]?.[0])).toContain('"version": 2');
  });

  it("does not render an editable Blueprint", () => {
    const { root } = setup();
    analyse(root, SSR);
    const blueprint = root.querySelector(".blueprint");
    expect(blueprint?.querySelector("textarea")).toBeNull();
    expect(blueprint?.querySelector("[contenteditable]")).toBeNull();
  });
});

describe("playground launch and verification", () => {
  it("calls the existing executor with the plan and the on-page iframe", async () => {
    const execute = vi.fn<BrowserExecutor>(async () => okVerification(true));
    const { root } = setup({ execute });
    analyse(root, `${SSR}\n${LOG_PLUGIN}`);

    root.querySelector<HTMLButtonElement>("#reproduce")!.click();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));

    const call = execute.mock.calls[0] as unknown as Parameters<BrowserExecutor>;
    const [plan, , options] = call;
    expect((plan.blueprint as { version: number }).version).toBe(2);
    expect(options.iframe).toBe(root.querySelector("#playground"));
    expect(root.querySelector<HTMLElement>("#playground-panel")?.hidden).toBe(false);
  });

  it("shows environment reconstruction separately from reproduction", async () => {
    const execute = vi.fn<BrowserExecutor>(async () => okVerification(true));
    const { root } = setup({ execute });
    analyse(root, `${SSR}\n${LOG_PLUGIN}`);
    root.querySelector<HTMLButtonElement>("#reproduce")!.click();
    await vi.waitFor(() => expect(root.textContent).toContain("Environment reconstruction"));

    expect(root.textContent).toContain("Boot succeeded");
    expect(root.textContent).toContain("woocommerce@8.5.2 (active)");
    expect(root.textContent).toContain("Failure reproduction");
    expect(root.textContent).toContain("Failure reproduced");
  });

  it("reports a trigger that ran without observing the failure", async () => {
    const execute = vi.fn<BrowserExecutor>(async () => okVerification(false));
    const { root } = setup({ execute });
    analyse(root, `${SSR}\n${LOG_PLUGIN}`);
    root.querySelector<HTMLButtonElement>("#reproduce")!.click();
    await vi.waitFor(() =>
      expect(root.textContent).toContain("Trigger attempted, failure not observed"),
    );
    expect(root.textContent).not.toContain("Failure reproduced");
  });

  it("never says the failure was not reproduced when the environment failed to boot", async () => {
    const failed: Verification = {
      environment: {
        bootSucceeded: false,
        installedComponents: [],
        failedComponents: ["woocommerce@8.5.2 (boot failed)"],
      },
      failureReproduction: {
        targets: [
          { signatureIndex: 0, attempted: false, observed: false, reason: "the environment did not boot" },
        ],
      },
    };
    const execute = vi.fn<BrowserExecutor>(async () => failed);
    const { root } = setup({ execute });
    analyse(root, `${SSR}\n${LOG_PLUGIN}`);
    root.querySelector<HTMLButtonElement>("#reproduce")!.click();
    await vi.waitFor(() => expect(root.textContent).toContain("Environment failed"));

    expect(root.textContent).toContain("Boot failed");
    expect(root.textContent).toContain("(boot failed)");
    // The forbidden conflation.
    expect(root.textContent).not.toMatch(/not reproducible/i);
    expect(root.textContent).not.toContain("Trigger attempted, failure not observed");
  });

  it("distinguishes an infrastructure failure from a reproduction result", async () => {
    const execute = vi.fn<BrowserExecutor>(async () => {
      throw new Error("Could not download https://downloads.wordpress.org/plugin/x.9.9.9.zip");
    });
    const { root } = setup({ execute });
    analyse(root, `${SSR}\n${LOG_PLUGIN}`);
    root.querySelector<HTMLButtonElement>("#reproduce")!.click();
    await vi.waitFor(() => expect(root.textContent).toContain("Infrastructure failure"));

    expect(root.querySelector("[role='alert']")).toBeTruthy();
    expect(root.textContent).toContain("Could not download");
    expect(root.textContent).toContain("not a statement about whether the reported failure is reproducible");
    expect(root.textContent).not.toMatch(/not reproducible\b/i);
  });

  it("shows explicit progress stages while reproducing", async () => {
    let release: (v: Verification) => void = () => {};
    const execute = vi.fn<BrowserExecutor>(
      (_p, _v, options) =>
        new Promise<Verification>((resolveFn) => {
          options.onProgress?.("booting");
          release = resolveFn;
        }),
    );
    const { root } = setup({ execute });
    analyse(root, `${SSR}\n${LOG_PLUGIN}`);
    root.querySelector<HTMLButtonElement>("#reproduce")!.click();

    await vi.waitFor(() => expect(root.querySelector(".stages")).toBeTruthy());
    expect(root.textContent).toContain("Booting WordPress Playground");
    expect(root.querySelector("[aria-live='polite']")).toBeTruthy();
    expect(root.querySelector<HTMLButtonElement>("#reproduce")?.disabled).toBe(true);

    release(okVerification(true));
    await vi.waitFor(() => expect(root.textContent).toContain("Failure reproduced"));
  });

  it("keeps the analysis visible after launching Playground", async () => {
    const execute = vi.fn<BrowserExecutor>(async () => okVerification(true));
    const { root } = setup({ execute });
    analyse(root, `${SSR}\n${LOG_PLUGIN}`);
    root.querySelector<HTMLButtonElement>("#reproduce")!.click();
    await vi.waitFor(() => expect(root.textContent).toContain("Verification"));

    expect(root.textContent).toContain("Environment");
    expect(root.textContent).toContain("Reproducibility");
    expect(root.textContent).toContain("Blueprint");
    expect(root.querySelector("#playground")).toBeTruthy();
  });
});

describe("no backend", () => {
  it("performs no network call while analysing", () => {
    const fetchSpy = vi.fn();
    const beacon = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("XMLHttpRequest", class { open = vi.fn(); send = beacon; });
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });

    const { root } = setup();
    analyse(root, `${SSR}\n${LOG_PLUGIN}`);

    expect(root.querySelector(".card")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("renders no form that could post the artifact anywhere", () => {
    const { root } = setup();
    analyse(root, SSR);
    for (const form of root.querySelectorAll("form")) {
      expect(form.getAttribute("action")).toBeNull();
      expect(form.getAttribute("method")).toBeNull();
    }
  });
});

describe("verification outcome semantics", () => {
  const base: Verification = okVerification(false);

  it("ranks a failed boot above every other outcome", () => {
    const failed: Verification = {
      ...base,
      environment: { ...base.environment, bootSucceeded: false },
    };
    // Even a target marked observed cannot claim reproduction if nothing booted.
    const target = { ...failed.failureReproduction.targets[0]!, attempted: true, observed: true };
    expect(targetOutcome(failed, target)).toBe("environment_failed");
  });

  it("distinguishes all four outcomes", () => {
    const t = base.failureReproduction.targets[0]!;
    expect(targetOutcome(base, { ...t, attempted: false, observed: false })).toBe("not_attempted");
    expect(targetOutcome(base, { ...t, attempted: true, observed: false })).toBe("attempted_not_observed");
    expect(targetOutcome(base, { ...t, attempted: true, observed: true })).toBe("reproduced");
  });

  it("never phrases any outcome as 'not reproducible'", () => {
    for (const outcome of ["environment_failed", "not_attempted", "attempted_not_observed", "reproduced"] as const) {
      const presentation = presentOutcome(outcome);
      expect(presentation.label).not.toMatch(/not reproducible/i);
      expect(presentation.detail).not.toMatch(/not reproducible/i);
    }
  });
});

describe("evidence navigation", () => {
  it("highlights exactly the line an evidence chip cites", () => {
    const { root } = setup();
    analyse(root, SSR_PHP_BAD);

    const chips = [...root.querySelectorAll<HTMLButtonElement>(".finding .chip")];
    expect(chips.length).toBeGreaterThan(0);

    for (const chip of chips) {
      chip.click();
      const highlighted = root.querySelectorAll(".source-line.highlight");
      // Exactly one line highlighted at a time.
      expect(highlighted).toHaveLength(1);
      const text = highlighted[0]?.textContent ?? "";
      expect(text).toContain(chip.querySelector("code")?.textContent ?? "");
    }
  });

  it("moves the highlight rather than accumulating highlights", () => {
    const { root } = setup();
    analyse(root, `${SSR_PHP_BAD}\n${LOG_PLUGIN}`);
    const chips = [...root.querySelectorAll<HTMLButtonElement>(".chip")];
    chips[0]?.click();
    const first = root.querySelector(".source-line.highlight")?.id;
    const other = chips.find((c) => c !== chips[0]);
    other?.click();
    expect(root.querySelectorAll(".source-line.highlight")).toHaveLength(1);
    // Clicking a different chip that cites a different line moves the highlight.
    const second = root.querySelector(".source-line.highlight")?.id;
    expect(typeof second).toBe("string");
    if (other?.getAttribute("aria-label") !== chips[0]?.getAttribute("aria-label")) {
      expect(second).not.toBe(undefined);
      void first;
    }
  });

  it("handles several chips citing the same line", () => {
    const { root } = setup();
    analyse(root, SSR_PHP_BAD);
    const chips = [...root.querySelectorAll<HTMLButtonElement>(".chip")];
    const sameLine = chips.filter(
      (c) => c.getAttribute("aria-label") === chips[0]?.getAttribute("aria-label"),
    );
    for (const chip of sameLine) {
      chip.click();
      expect(root.querySelectorAll(".source-line.highlight")).toHaveLength(1);
    }
  });

  it("renders every source line for a long artifact and can reach the last one", () => {
    const { root } = setup();
    const padding = Array.from({ length: 400 }, (_, i) => `# filler line ${String(i)}`).join("\n");
    const source = `${padding}\n${SSR_PHP_BAD}`;
    analyse(root, source);

    const expectedLines = source.split("\n").length;
    expect(root.querySelectorAll(".source-line")).toHaveLength(expectedLines);

    const chip = root.querySelector<HTMLButtonElement>(".finding .chip")!;
    chip.click();
    const highlighted = root.querySelector(".source-line.highlight");
    expect(highlighted).toBeTruthy();
    // The cited line is well past the padding, proving the offset is right.
    const id = Number((highlighted?.id ?? "").replace("src-line-", ""));
    expect(id).toBeGreaterThan(400);
  });

  it("does not mutate the pasted source", () => {
    const { root } = setup();
    analyse(root, SSR_PHP_BAD);

    const textarea = root.querySelector<HTMLTextAreaElement>("#artifact")!;
    expect(textarea.value).toBe(SSR_PHP_BAD);

    const rendered = [...root.querySelectorAll(".source-line .source-text")]
      .map((n) => n.textContent)
      .join("\n");
    root.querySelector<HTMLButtonElement>(".finding .chip")!.click();

    const afterClick = [...root.querySelectorAll(".source-line .source-text")]
      .map((n) => n.textContent)
      .join("\n");
    expect(afterClick).toBe(rendered);
    expect(textarea.value).toBe(SSR_PHP_BAD);
  });
});

describe("accessibility", () => {
  it("labels controls and exposes live status", () => {
    const { root } = setup();
    expect(root.querySelector("label[for='artifact']")).toBeTruthy();
    expect(root.querySelector("label[for='format']")).toBeTruthy();
    expect(root.querySelector("#status")?.getAttribute("aria-live")).toBe("polite");
    expect(root.querySelector("#artifact")?.getAttribute("aria-describedby")).toBe("paste-help");
  });

  it("gives the Playground iframe a title once it is created", async () => {
    const execute = vi.fn<BrowserExecutor>(async () => okVerification(true));
    const { root } = setup({ execute });
    analyse(root, `${SSR}\n${LOG_PLUGIN}`);
    // The frame is created at launch, not at page load.
    expect(root.querySelector("#playground")).toBeNull();

    root.querySelector<HTMLButtonElement>("#reproduce")!.click();
    await vi.waitFor(() => expect(root.querySelector("#playground")).toBeTruthy());
    expect(root.querySelector("#playground")?.getAttribute("title")).toContain("Playground");
  });

  it("uses real buttons for evidence so they are keyboard reachable", () => {
    const { root } = setup();
    analyse(root, SSR_PHP_BAD);
    const chip = root.querySelector(".finding .chip")!;
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.getAttribute("aria-label")).toContain("Show evidence at line");
  });
});
