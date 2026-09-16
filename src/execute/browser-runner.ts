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
  type PlaygroundRunner,
} from "./core.js";

/** Verified in Phase 0 on both surfaces. */
export const DEFAULT_REMOTE_URL = "https://playground.wordpress.net/remote.html";

/** The part of the live client a caller needs to show the site on screen. */
export interface PlaygroundInstance {
  goTo(path: string): Promise<void>;
}

export interface BrowserExecuteOptions {
  iframe: HTMLIFrameElement;
  remoteUrl?: string;
  onProgress?: (message: string) => void;
  /**
   * Receives the live instance once it is ready.
   *
   * Added for the UI: after verification the reproduced site has to be
   * navigated somewhere, or the embedded iframe shows only the blank remote
   * shell. Execution semantics are unchanged — the callback is never used by
   * the verification path.
   */
  onInstance?: (instance: PlaygroundInstance) => void;
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
    options.onInstance?.(started as unknown as PlaygroundInstance);
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
