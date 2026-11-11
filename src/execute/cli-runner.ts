/**
 * Executes a ReproPlan on the CLI surface (docs/SPEC.md §9, §12.2).
 *
 * Boots the instance and hands it to the shared execution core; the semantics —
 * three-way separation, debug.log diffing, honest `observed` — live there and
 * are identical for both surfaces. Behaviour is unchanged from the original
 * single-file implementation; only the orchestration moved so the browser
 * surface cannot drift from it.
 */
import { runCLI } from "@wp-playground/cli";
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

export interface ExecuteOptions {
  port?: number;
  /** Surfaces raw progress for spikes and CI logs. */
  onProgress?: (message: string) => void;
}

export async function executePlan(
  plan: ReproPlan,
  verificationPlan: VerificationPlan,
  options: ExecuteOptions = {},
): Promise<Verification> {
  const progress = options.onProgress ?? ((): void => {});
  const requested = verificationPlan.environmentChecks.expectedInstalledComponents;

  let server: Awaited<ReturnType<typeof runCLI>> | undefined;

  try {
    progress("booting");
    server = await runCLI({
      command: "server",
      blueprint: plan.blueprint as never,
      port: options.port ?? 9500,
      verbosity: "quiet",
      skipBrowser: true,
    });
  } catch (error) {
    // Phase 4.5: one unavailable plugin version aborts the whole boot. The
    // failure is attributed rather than swallowed, and nothing is reported as
    // installed.
    const message = String((error as Error).message).slice(0, 500);
    progress(`boot failed: ${message}`);
    return bootFailureVerification(plan, requested, message);
  }

  const runCLIServer = server as unknown as {
    playground: PlaygroundRunner;
    [Symbol.asyncDispose]: () => Promise<void>;
  };

  try {
    return await verifyAgainstRunner(runCLIServer.playground, plan, verificationPlan, progress);
  } finally {
    await runCLIServer[Symbol.asyncDispose]();
  }
}

/**
 * Boots one subset of components and reports what WordPress installed.
 *
 * Used by boot-failure isolation (`isolate.ts`), which needs many cheap boots
 * and no trigger execution. It shares `readSiteState`/`reconcileComponents`
 * with the execution core, so "installed" means the same thing here as it does
 * in a Verification: read out of WordPress, never taken from the Blueprint.
 */
export async function probeBoot(
  plan: ReproPlan,
  components: string[],
  options: ExecuteOptions = {},
): Promise<BootAttempt> {
  const blueprint = plan.blueprint as { plugins?: Array<{ source: string }> };
  const subset = (blueprint.plugins ?? []).filter((p) => components.includes(p.source));
  const probeBlueprint = { ...blueprint, plugins: subset };

  let server: Awaited<ReturnType<typeof runCLI>> | undefined;
  try {
    server = await runCLI({
      command: "server",
      blueprint: probeBlueprint as never,
      port: options.port ?? 9500,
      verbosity: "quiet",
      skipBrowser: true,
    });
  } catch (error) {
    return {
      components,
      bootSucceeded: false,
      installedComponents: [],
      error: String((error as Error).message).slice(0, 500),
    };
  }

  const booted = server as unknown as {
    playground: PlaygroundRunner;
    [Symbol.asyncDispose]: () => Promise<void>;
  };
  try {
    const state = await readSiteState(booted.playground);
    const { installedComponents } = reconcileComponents(components, state);
    return { components, bootSucceeded: true, installedComponents };
  } finally {
    await booted[Symbol.asyncDispose]();
  }
}
