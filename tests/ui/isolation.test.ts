// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mountApp, type BrowserExecutor, type BrowserIsolator } from "../../src/ui/app.js";
import type { Verification } from "../../src/types/verification.js";
import type { IsolationResult } from "../../src/execute/isolate.js";

const fixtures = resolve(__dirname, "../../fixtures");
const read = (p: string): string => readFileSync(resolve(fixtures, p), "utf8");
const ARTIFACT = `${read("ssr/01-storefront-baseline.txt")}\n${read("logs/log-01-plugin-fatal.txt")}`;

Element.prototype.scrollIntoView = (): void => {};

const bootFailed = (requested: string[]): Verification => ({
  environment: {
    bootSucceeded: false,
    installedComponents: [],
    failedComponents: requested.map((c) => `${c} (boot failed)`),
  },
  failureReproduction: {
    targets: [
      {
        signatureIndex: 0,
        attempted: false,
        observed: false,
        reason: "the environment did not boot, so no trigger could be executed",
      },
    ],
  },
});

const bootOk = (): Verification => ({
  environment: { bootSucceeded: true, installedComponents: ["woocommerce@8.5.2 (active)"], failedComponents: [] },
  failureReproduction: {
    targets: [
      {
        signatureIndex: 0,
        attempted: true,
        observed: false,
        trigger: { kind: "plugin_activation", slug: "woocommerce" },
        reason: "the trigger ran and wrote no new debug.log entries",
      },
    ],
  },
});

const culpritFound = (culprit: string, without: string[]): IsolationResult => ({
  outcome: {
    kind: "component",
    culprit,
    error: "PHP.run() failed with exit code 255. Uncaught WP_MySQL_On_SQLite_Exception",
    bootableWithout: without.map((c) => `${c} (active)`),
  },
  attempts: [
    { components: [], bootSucceeded: true, installedComponents: [] },
    { components: [culprit], bootSucceeded: false, installedComponents: [], error: "PHP.run() failed with exit code 255" },
    { components: without, bootSucceeded: true, installedComponents: without.map((c) => `${c} (active)`) },
  ],
  used: 3,
  budget: 8,
});

function setup(deps: Parameters<typeof mountApp>[1] = {}) {
  document.body.innerHTML = "";
  const root = document.createElement("main");
  document.body.append(root);
  const app = mountApp(root, { copy: async () => {}, ...deps });
  const textarea = root.querySelector<HTMLTextAreaElement>("#artifact")!;
  textarea.value = ARTIFACT;
  root.querySelector<HTMLFormElement>("#analyse-form")!.dispatchEvent(
    new Event("submit", { cancelable: true, bubbles: true }),
  );
  return { root, ...app };
}

const click = (root: HTMLElement, selector: string): void => {
  root.querySelector<HTMLButtonElement>(selector)!.dispatchEvent(new Event("click", { bubbles: true }));
};
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("boot failure isolation in the UI", () => {
  it("is not offered when the environment booted", async () => {
    const execute: BrowserExecutor = () => Promise.resolve(bootOk());
    const { root } = setup({ execute });
    click(root, "#reproduce");
    await flush();

    expect(root.querySelector(".outcome")?.textContent).toContain("Trigger attempted");
    expect(root.querySelector("#isolate")).toBeNull();
  });

  it("is offered when the boot failed, and says why none of the components is named yet", async () => {
    const execute: BrowserExecutor = () => Promise.resolve(bootFailed(["woocommerce@8.5.2"]));
    const { root } = setup({ execute });
    click(root, "#reproduce");
    await flush();

    expect(root.querySelector("#isolate")?.textContent).toBe("Isolate the failing component");
    expect(root.querySelector(".isolation")?.textContent).toContain("all-or-nothing");
  });

  it("asks the isolator for exactly the components the plan requested", async () => {
    const execute: BrowserExecutor = () => Promise.resolve(bootFailed(["woocommerce@8.5.2"]));
    const isolate = vi.fn<BrowserIsolator>(() => Promise.resolve(culpritFound("woocommerce@8.5.2", [])));
    const { root, store } = setup({ execute, isolate });
    click(root, "#reproduce");
    await flush();
    click(root, "#isolate");
    await flush();

    expect(isolate).toHaveBeenCalledTimes(1);
    const [plan, components, options] = isolate.mock.calls[0]!;
    const blueprint = plan.blueprint as { plugins: Array<{ source: string }> };
    expect(components).toEqual(blueprint.plugins.map((p) => p.source));
    // The boot that just failed is handed over as evidence, so the search does
    // not spend one of its boots re-establishing it.
    expect(options.observedFailure?.bootSucceeded).toBe(false);
    expect(options.observedFailure?.components).toEqual(components);
    expect(store.get().kind).toBe("isolated");
  });

  it("reports the culprit, the failure text and what booted without it", async () => {
    const execute: BrowserExecutor = () => Promise.resolve(bootFailed(["wordfence@7.11.4"]));
    const isolate: BrowserIsolator = () =>
      Promise.resolve(culpritFound("wordfence@7.11.4", ["woocommerce@8.5.2", "akismet@5.3"]));
    const { root } = setup({ execute, isolate });
    click(root, "#reproduce");
    await flush();
    click(root, "#isolate");
    await flush();

    const text = root.querySelector(".isolation")?.textContent ?? "";
    expect(text).toContain("wordfence@7.11.4 aborts the boot");
    expect(text).toContain("WP_MySQL_On_SQLite_Exception");
    expect(text).toContain("woocommerce@8.5.2 (active)");
    // The attempts that prove it are available, not just the conclusion.
    expect(text).toContain("Boot attempts (3 of a 8 budget)");
  });

  it("never rewrites the plan it bisected", async () => {
    const execute: BrowserExecutor = () => Promise.resolve(bootFailed(["wordfence@7.11.4"]));
    const isolate: BrowserIsolator = () => Promise.resolve(culpritFound("wordfence@7.11.4", ["woocommerce@8.5.2"]));
    const { root, store } = setup({ execute, isolate });
    click(root, "#reproduce");
    await flush();

    const before = JSON.stringify((store.get() as { analysis: { plan: unknown } }).analysis.plan);
    click(root, "#isolate");
    await flush();

    const after = JSON.stringify((store.get() as { analysis: { plan: unknown } }).analysis.plan);
    expect(after).toBe(before);
    // And the Blueprint panel still shows every requested component.
    expect(root.querySelector(".blueprint")?.textContent).toContain("woocommerce@");
  });

  it("keeps an inconclusive result inconclusive", async () => {
    const execute: BrowserExecutor = () => Promise.resolve(bootFailed(["woocommerce@8.5.2"]));
    const isolate: BrowserIsolator = () =>
      Promise.resolve({
        outcome: { kind: "combination", groupA: ["woocommerce@8.5.2"], groupB: ["classic-editor@1.6.3"] },
        attempts: [],
        used: 4,
        budget: 8,
      } satisfies IsolationResult);
    const { root } = setup({ execute, isolate });
    click(root, "#reproduce");
    await flush();
    click(root, "#isolate");
    await flush();

    const text = root.querySelector(".isolation")?.textContent ?? "";
    expect(text).toContain("No single component is responsible");
    expect(text).not.toMatch(/aborts the boot/);
  });

  it("stops calling the Playground frame the reported environment while probing", async () => {
    const execute: BrowserExecutor = () => Promise.resolve(bootFailed(["wordfence@7.11.4"]));
    const isolate: BrowserIsolator = (_plan, _components, options) => {
      options.newFrame();
      return Promise.resolve(culpritFound("wordfence@7.11.4", ["woocommerce@8.5.2"]));
    };
    const { root } = setup({ execute, isolate });
    click(root, "#reproduce");
    await flush();
    expect(root.querySelector("#playground-note")?.textContent).toContain("reported environment");

    click(root, "#isolate");
    await flush();
    const note = root.querySelector("#playground-note")?.textContent ?? "";
    expect(note).toContain("isolation probe");
    expect(note).toContain("not the reported environment");
  });

  it("separates a failure of the bisection itself from a verdict about components", async () => {
    const execute: BrowserExecutor = () => Promise.resolve(bootFailed(["woocommerce@8.5.2"]));
    const isolate: BrowserIsolator = () => Promise.reject(new Error("network unreachable"));
    const { root, store } = setup({ execute, isolate });
    click(root, "#reproduce");
    await flush();
    click(root, "#isolate");
    await flush();

    expect(store.get().kind).toBe("isolation_failed");
    const alert = root.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain("network unreachable");
    expect(alert).toContain("says nothing about which component is responsible");
  });

  it("keeps the verification visible while isolating, and disables both buttons", async () => {
    const execute: BrowserExecutor = () => Promise.resolve(bootFailed(["woocommerce@8.5.2"]));
    let release: (r: IsolationResult) => void = () => {};
    const isolate: BrowserIsolator = () => new Promise<IsolationResult>((resolve) => (release = resolve));
    const { root } = setup({ execute, isolate });
    click(root, "#reproduce");
    await flush();
    click(root, "#isolate");
    await flush();

    expect(root.querySelector<HTMLButtonElement>("#isolate")?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>("#reproduce")?.disabled).toBe(true);
    // The failed verification stays on screen rather than being replaced.
    expect(root.textContent).toContain("Boot failed");

    release(culpritFound("woocommerce@8.5.2", []));
    await flush();
    expect(root.querySelector<HTMLButtonElement>("#isolate")?.disabled).toBe(false);
  });
});
