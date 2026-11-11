/**
 * Isolates the component that aborts a boot.
 *
 * Installation is all-or-nothing: one component that cannot be downloaded, or
 * that fatals while Playground activates it, takes the whole environment down
 * and every target is reported as `Environment failed`. That outcome is honest
 * but it is a dead end — a support engineer then bisects by hand.
 *
 * This module does that bisection, by booting subsets of the requested
 * components and reading back what WordPress actually installed. It is
 * surface-agnostic: the caller injects a boot probe, so the CLI and the browser
 * share this logic exactly as they share the execution core.
 *
 * Three rules it does not break:
 *
 * 1. **Nothing is concluded without an attempt.** Every statement it returns is
 *    backed by boots recorded in `attempts`, including their error text.
 * 2. **A single culprit is only named once "everything except it" has been
 *    booted successfully.** Narrowing alone is a hypothesis; the confirming
 *    boot is the evidence.
 * 3. **It never edits the plan.** Removing a component is an experiment, not a
 *    substitution, and the plan the user saw is left exactly as it was.
 */

/** One boot, and what the booted site reported back. */
export interface BootAttempt {
  /** Components the Blueprint asked for on this attempt, in plan order. */
  components: string[];
  bootSucceeded: boolean;
  /** Read out of WordPress, never taken from the Blueprint. */
  installedComponents: string[];
  /** Boot failure text, truncated by the probe. */
  error?: string;
}

export type BootProbe = (components: string[]) => Promise<BootAttempt>;

export type IsolationOutcome =
  /** One component is responsible, and the rest booted without it. */
  | { kind: "component"; culprit: string; error: string; bootableWithout: string[] }
  /** Zero components still fails: the WordPress/PHP environment itself does. */
  | { kind: "environment"; error: string }
  /** Each half boots alone; only together do they fail. */
  | { kind: "combination"; groupA: string[]; groupB: string[] }
  /** The full set booted after all — nothing to isolate. */
  | { kind: "no_failure" }
  /** Ran out of attempts, or the evidence did not support a conclusion. */
  | { kind: "inconclusive"; reason: string };

export interface IsolationResult {
  outcome: IsolationOutcome;
  attempts: BootAttempt[];
  /** Attempts used, and the cap they were bounded by. */
  used: number;
  budget: number;
}

export interface IsolateOptions {
  /**
   * The already-observed failure of the full set, when the caller has one — a
   * Verification whose boot failed, for instance. It is recorded as the first
   * attempt and saves re-booting a set already known to fail.
   *
   * Without it the full set is booted first, because every conclusion here
   * depends on that set actually failing: if it boots, "each half boots alone"
   * means nothing was broken, not that two halves conflict.
   */
  observedFailure?: BootAttempt;
  /**
   * Maximum boots. Each one downloads WordPress and the subset's plugins, so
   * the search is bounded rather than exhaustive. Worst case is
   * `2 * log2(n) + 2`: a control, up to two boots per halving, and the
   * confirming boot. The second boot of each halving is deliberate — it is
   * what separates "the other half contains a bad component" from "the halves
   * conflict with each other", which inference alone cannot tell apart.
   */
  budget?: number;
  onProgress?: (message: string) => void;
}

/**
 * Worst case for n components is `2 * log2(n) + 3`: the full set, a control, up
 * to two boots per halving, and the confirming boot. Six components — demo B —
 * measured 6 boots in 428 s when the caller supplied the observed failure.
 */
const DEFAULT_BUDGET = 10;

/**
 * Narrows a failing component set by binary search, then confirms.
 *
 * The caller passes the components the plan requested and a probe that boots a
 * given subset. `knownFailure` is the already-observed failure of the full set,
 * so the run does not pay for a boot it has already done.
 */
export async function isolateBootFailure(
  components: string[],
  probe: BootProbe,
  options: IsolateOptions = {},
): Promise<IsolationResult> {
  const budget = options.budget ?? DEFAULT_BUDGET;
  const progress = options.onProgress ?? ((): void => {});
  const attempts: BootAttempt[] = [];

  const boot = async (subset: string[]): Promise<BootAttempt | undefined> => {
    if (attempts.length >= budget) return undefined;
    progress(
      subset.length === 0
        ? "booting with no components"
        : `booting ${String(subset.length)} of ${String(components.length)}: ${subset.join(", ")}`,
    );
    const attempt = await probe(subset);
    attempts.push(attempt);
    progress(`  ${attempt.bootSucceeded ? "booted" : "failed"}`);
    return attempt;
  };

  const done = (outcome: IsolationOutcome): IsolationResult => ({
    outcome,
    attempts,
    used: attempts.length,
    budget,
  });

  const exhausted = (): IsolationResult =>
    done({
      kind: "inconclusive",
      reason: `the search was bounded to ${String(budget)} boots and did not reach a confirmed answer`,
    });

  if (components.length === 0) {
    return done({
      kind: "inconclusive",
      reason: "the plan requested no components, so no component can be responsible",
    });
  }

  // Precondition, not an assumption: the full set has to fail, or the
  // narrowing below answers a question nobody asked.
  if (options.observedFailure !== undefined) {
    attempts.push(options.observedFailure);
    progress(`using the observed failure of all ${String(components.length)} component(s)`);
  } else {
    const full = await boot(components);
    if (full === undefined) return exhausted();
    if (full.bootSucceeded) return done({ kind: "no_failure" });
  }

  // The control. If an empty environment fails, no component is to blame and
  // bisecting the component list would answer the wrong question.
  const control = await boot([]);
  if (control === undefined) return exhausted();
  if (!control.bootSucceeded) {
    return done({
      kind: "environment",
      error: control.error ?? "the boot failed without reporting an error",
    });
  }

  // Narrow: keep halving the set that still fails.
  let failing = [...components];
  while (failing.length > 1) {
    const middle = Math.ceil(failing.length / 2);
    const left = failing.slice(0, middle);
    const right = failing.slice(middle);

    const leftAttempt = await boot(left);
    if (leftAttempt === undefined) return exhausted();
    if (!leftAttempt.bootSucceeded) {
      failing = left;
      continue;
    }

    const rightAttempt = await boot(right);
    if (rightAttempt === undefined) return exhausted();
    if (!rightAttempt.bootSucceeded) {
      failing = right;
      continue;
    }

    // Both halves booted on their own, so no single component explains the
    // failure. Saying which one is "the" culprit here would be a guess.
    return done({ kind: "combination", groupA: left, groupB: right });
  }

  const culprit = failing[0];
  if (culprit === undefined) return exhausted();

  // Confirm: everything except the candidate has to boot. Without this the
  // result is only a hypothesis.
  const without = components.filter((c) => c !== culprit);
  const confirmation = await boot(without);
  if (confirmation === undefined) return exhausted();

  if (!confirmation.bootSucceeded) {
    return done({
      kind: "inconclusive",
      reason: `${culprit} fails on its own, but the environment still fails without it, so at least one other component is also responsible`,
    });
  }

  // The most specific failure available: a boot of the culprit alone says more
  // than the original six-component failure that contained it.
  const failed = attempts
    .filter((a) => !a.bootSucceeded && a.components.includes(culprit))
    .sort((a, b) => a.components.length - b.components.length)[0];
  return done({
    kind: "component",
    culprit,
    error: failed?.error ?? "the boot failed without reporting an error",
    bootableWithout: confirmation.installedComponents,
  });
}

/** One line a support engineer can paste into a ticket. */
export function summariseIsolation(result: IsolationResult): string {
  const outcome = result.outcome;
  switch (outcome.kind) {
    case "component":
      return `${outcome.culprit} aborts the boot. The other ${String(outcome.bootableWithout.length)} component(s) installed without it.`;
    case "environment":
      return "The environment fails to boot with no components installed at all, so no component is responsible.";
    case "combination":
      return `No single component is responsible: [${outcome.groupA.join(", ")}] and [${outcome.groupB.join(", ")}] each boot alone but not together.`;
    case "no_failure":
      return "The full component set booted, so there was nothing to isolate.";
    case "inconclusive":
      return `Inconclusive: ${outcome.reason}.`;
  }
}
