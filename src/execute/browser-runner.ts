/**
 * Executes a ReproPlan on the browser surface (docs/SPEC.md §9, §12.1).
 *
 * Uses the browser embedding API verified in Phase 0: `startPlaygroundWeb`
 * against playground.wordpress.net/remote.html, with `isReady()` as the
 * readiness signal. Phase 0 also established that the embedding page must NOT
 * be cross-origin isolated, or the remote iframe is blocked and
 * startPlaygroundWeb never resolves.
 *
 * This module runs in a page, not in Node. It shares the execution core with
 * the CLI runner so the two surfaces cannot diverge in semantics — whether
 * they diverge in RESULT is a measured question (§12), answered in
 * docs/phase-5-browser-findings.md.
 */
import { startPlaygroundWeb } from "@wp-playground/client";
import type { ReproPlan } from "../types/repro.js";
import type { Verification } from "../types/verification.js";
import type { VerificationPlan } from "../repro/verification-plan.js";
import {
  bootFailureVerification,
  verifyAgainstRunner,
  readSiteState,
  reconcileComponents,
  type PlaygroundRunner,
} from "./core.js";
import type { BootAttempt } from "./isolate.js";

/** Verified in Phase 0 on both surfaces. */
export const DEFAULT_REMOTE_URL = "https://playground.wordpress.net/remote.html";

export interface BrowserExecuteOptions {
  iframe: HTMLIFrameElement;
  remoteUrl?: string;
  onProgress?: (message: string) => void;
}

export async function executePlanInBrowser(
  plan: ReproPlan,
  verificationPlan: VerificationPlan,
  options: BrowserExecuteOptions,
): Promise<Verification> {
  const progress = options.onProgress ?? ((): void => {});
  const requested = verificationPlan.environmentChecks.expectedInstalledComponents;

  let client: PlaygroundRunner;

  try {
    progress("booting");
    const started = await startPlaygroundWeb({
      iframe: options.iframe,
      remoteUrl: options.remoteUrl ?? DEFAULT_REMOTE_URL,
      blueprint: plan.blueprint as never,
    });

    // The readiness signal verified in Phase 0. startPlaygroundWeb resolving is
    // not by itself proof the runtime is usable.
    await started.isReady();
    client = started as unknown as PlaygroundRunner;
    progress("ready");
  } catch (error) {
    // A Blueprint step failure (for example a plugin version no longer served)
    // throws here, exactly as it does on the CLI.
    const message = String((error as Error).message).slice(0, 500);
    progress(`boot failed: ${message}`);
    return bootFailureVerification(plan, requested, message);
  }

  // No teardown: the caller owns the iframe and may want to keep the instance
  // on screen after verification.
  return verifyAgainstRunner(client, plan, verificationPlan, progress);
}

/**
 * The browser half of boot-failure isolation: boots one subset and reports what
 * WordPress installed. Mirrors `probeBoot` on the CLI surface, and shares the
 * same `readSiteState`/`reconcileComponents` as the execution core, so a
 * component counts as installed by the same rule on both surfaces.
 */
export async function probeBootInBrowser(
  plan: ReproPlan,
  components: string[],
  options: { iframe: HTMLIFrameElement; remoteUrl?: string },
): Promise<BootAttempt> {
  const blueprint = plan.blueprint as { plugins?: Array<{ source: string }> };
  const subset = (blueprint.plugins ?? []).filter((p) => components.includes(p.source));
  const probeBlueprint = { ...blueprint, plugins: subset };

  let client: PlaygroundRunner;
  try {
    const started = await startPlaygroundWeb({
      iframe: options.iframe,
      remoteUrl: options.remoteUrl ?? DEFAULT_REMOTE_URL,
      blueprint: probeBlueprint as never,
    });
    await started.isReady();
    client = started as unknown as PlaygroundRunner;
  } catch (error) {
    return {
      components,
      bootSucceeded: false,
      installedComponents: [],
      error: String((error as Error).message).slice(0, 500),
    };
  }

  // Reading the site back is NOT part of the boot, and the guard above stops
  // where the boot does — exactly as it does in `probeBoot` on the CLI. A read
  // that throws must never be reported as `bootSucceeded: false`: the search
  // decides which half to narrow into from that flag alone, so a transport
  // error here would let it name a component the evidence does not implicate.
  // Letting it propagate surfaces an isolation failure instead, which says
  // nothing about any component.
  const state = await readSiteState(client);
  const { installedComponents } = reconcileComponents(components, state);
  return { components, bootSucceeded: true, installedComponents };
}
