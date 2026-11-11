import { describe, it, expect } from "vitest";
import {
  isolateBootFailure,
  summariseIsolation,
  type BootAttempt,
  type BootProbe,
} from "../src/execute/isolate.js";

const SIX = ["woocommerce@8.5.2", "wordpress-seo@21.7", "contact-form-7@5.8.6", "wordfence@7.11.4", "akismet@5.3", "classic-editor@1.6.3"];

/**
 * A probe that fails whenever the subset contains any of `breaks`, mirroring
 * all-or-nothing installation. Records every subset it was asked for.
 */
function probeFailingOn(breaks: string[], log: string[][] = []): { probe: BootProbe; calls: string[][] } {
  const probe: BootProbe = (components) => {
    log.push(components);
    const offender = components.find((c) => breaks.includes(c));
    const attempt: BootAttempt =
      offender === undefined
        ? { components, bootSucceeded: true, installedComponents: components.map((c) => `${c} (active)`) }
        : { components, bootSucceeded: false, installedComponents: [], error: `PHP.run() failed: ${offender}` };
    return Promise.resolve(attempt);
  };
  return { probe, calls: log };
}

describe("boot failure isolation", () => {
  it("names the single component that aborts the boot", async () => {
    const { probe } = probeFailingOn(["wordfence@7.11.4"]);
    const result = await isolateBootFailure(SIX, probe);

    expect(result.outcome.kind).toBe("component");
    if (result.outcome.kind !== "component") return;
    expect(result.outcome.culprit).toBe("wordfence@7.11.4");
    expect(result.outcome.error).toContain("wordfence@7.11.4");
  });

  it("only names a culprit after booting everything except it", async () => {
    const { probe, calls } = probeFailingOn(["wordfence@7.11.4"]);
    const result = await isolateBootFailure(SIX, probe);

    const without = SIX.filter((c) => c !== "wordfence@7.11.4");
    expect(calls).toContainEqual(without);

    // And that confirming boot is the evidence reported back.
    if (result.outcome.kind !== "component") throw new Error("expected a component outcome");
    expect(result.outcome.bootableWithout).toEqual(without.map((c) => `${c} (active)`));
  });

  it("reports the environment, not a component, when an empty set already fails", async () => {
    const calls: string[][] = [];
    const probe: BootProbe = (components) => {
      calls.push(components);
      return Promise.resolve({ components, bootSucceeded: false, installedComponents: [], error: "SQLite integration is not 5.2-compatible" });
    };

    const result = await isolateBootFailure(SIX, probe);
    expect(result.outcome.kind).toBe("environment");
    if (result.outcome.kind !== "environment") return;
    expect(result.outcome.error).toContain("5.2");
    // The full set, then the empty control — and no bisection after that,
    // because no component can explain a failure an empty site also has.
    expect(calls).toEqual([SIX, []]);
  });

  it("refuses to name a culprit when each half boots alone", async () => {
    // Fails only when both of these are present — a conflict, not a bad plugin.
    const probe: BootProbe = (components) => {
      const clash = components.includes("woocommerce@8.5.2") && components.includes("classic-editor@1.6.3");
      return Promise.resolve(
        clash
          ? { components, bootSucceeded: false, installedComponents: [], error: "conflict" }
          : { components, bootSucceeded: true, installedComponents: components },
      );
    };

    const result = await isolateBootFailure(SIX, probe);
    expect(result.outcome.kind).toBe("combination");
    if (result.outcome.kind !== "combination") return;
    expect(result.outcome.groupA).toContain("woocommerce@8.5.2");
    expect(result.outcome.groupB).toContain("classic-editor@1.6.3");
  });

  it("stays inconclusive when a second component is also responsible", async () => {
    const { probe } = probeFailingOn(["wordfence@7.11.4", "akismet@5.3"]);
    const result = await isolateBootFailure(SIX, probe);

    expect(result.outcome.kind).toBe("inconclusive");
    if (result.outcome.kind !== "inconclusive") return;
    expect(result.outcome.reason).toContain("at least one other component");
  });

  it("is bounded by its budget and says so rather than guessing", async () => {
    const { probe, calls } = probeFailingOn(["classic-editor@1.6.3"]);
    const result = await isolateBootFailure(SIX, probe, { budget: 2 });

    expect(calls.length).toBe(2);
    expect(result.outcome.kind).toBe("inconclusive");
    if (result.outcome.kind !== "inconclusive") return;
    expect(result.outcome.reason).toContain("bounded to 2 boots");
  });

  it("needs far fewer boots than components", async () => {
    const many = Array.from({ length: 16 }, (_, i) => `plugin-${String(i)}@1.0`);
    const { probe, calls } = probeFailingOn(["plugin-11@1.0"]);
    const result = await isolateBootFailure(many, probe, { budget: 12 });

    if (result.outcome.kind !== "component") throw new Error("expected a component outcome");
    expect(result.outcome.culprit).toBe("plugin-11@1.0");
    // Worst case is control + 2 boots per halving + confirmation: booting the
    // half we are about to discard is what distinguishes "the other half
    // contains a bad component" from "the two halves conflict", so it is paid
    // for deliberately rather than inferred.
    expect(calls.length).toBeLessThanOrEqual(2 * Math.log2(16) + 2);
    expect(calls.length).toBeLessThan(16);
  });

  it("quotes the most specific failure it saw, not the widest one", async () => {
    const probe: BootProbe = (components) => {
      const offending = components.includes("wordfence@7.11.4");
      return Promise.resolve(
        offending
          ? {
              components,
              bootSucceeded: false,
              installedComponents: [],
              // Real boots name the failing blueprint step, whose number
              // depends on how many components preceded it.
              error: `blueprint step #${String(components.length)} failed`,
            }
          : { components, bootSucceeded: true, installedComponents: components },
      );
    };

    const result = await isolateBootFailure(SIX, probe, {
      observedFailure: { components: SIX, bootSucceeded: false, installedComponents: [], error: "blueprint step #6 failed" },
    });

    if (result.outcome.kind !== "component") throw new Error("expected a component outcome");
    // The boot of the culprit on its own, not the original six-component one.
    expect(result.outcome.error).toBe("blueprint step #1 failed");
  });

  it("records every attempt it made, with its error text", async () => {
    const { probe } = probeFailingOn(["wordfence@7.11.4"]);
    const result = await isolateBootFailure(SIX, probe);

    expect(result.attempts.length).toBe(result.used);
    expect(result.attempts.every((a) => Array.isArray(a.components))).toBe(true);
    expect(result.attempts.some((a) => !a.bootSucceeded && (a.error ?? "").length > 0)).toBe(true);
  });

  it("reports nothing to isolate when the full set actually boots", async () => {
    const { probe, calls } = probeFailingOn([]);
    const result = await isolateBootFailure(SIX, probe);

    expect(result.outcome.kind).toBe("no_failure");
    // It checked rather than assumed, and stopped there.
    expect(calls).toEqual([SIX]);
  });

  it("accepts an already-observed failure instead of re-booting the full set", async () => {
    const observedFailure = {
      components: SIX,
      bootSucceeded: false,
      installedComponents: [],
      error: "PHP.run() failed with exit code 255",
    };
    const { probe, calls } = probeFailingOn(["wordfence@7.11.4"]);
    const result = await isolateBootFailure(SIX, probe, { observedFailure });

    // The full set is never re-booted...
    expect(calls).not.toContainEqual(SIX);
    // ...but it is reported as evidence alongside the boots that were run.
    expect(result.attempts[0]).toEqual(observedFailure);
    expect(result.outcome.kind).toBe("component");
  });

  it("reports nothing to isolate when no component is requested", async () => {
    const { probe, calls } = probeFailingOn([]);
    const result = await isolateBootFailure([], probe);

    expect(calls.length).toBe(0);
    expect(result.outcome.kind).toBe("inconclusive");
  });

  it("summarises each outcome in one pasteable line", async () => {
    const { probe } = probeFailingOn(["wordfence@7.11.4"]);
    const result = await isolateBootFailure(SIX, probe);

    expect(summariseIsolation(result)).toBe(
      "wordfence@7.11.4 aborts the boot. The other 5 component(s) installed without it.",
    );
  });
});
