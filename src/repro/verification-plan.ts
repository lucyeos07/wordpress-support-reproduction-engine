/**
 * The verification PLAN: what Phase 5 should check, and how.
 *
 * Deliberately separate from `Verification` (docs/SPEC.md §9), which holds the
 * results of actually running it. Producing a plan proves nothing; only
 * executing the trigger and observing the outcome does (CLAUDE.md).
 *
 * The log strategy encodes the Phase 0 finding that debug.log is the only
 * authoritative runtime evidence, and that a fatal must be identified by
 * diffing the log around the trigger — never by reading whatever errors the
 * log already contained after boot.
 */
import type { Environment } from "../types/environment.js";
import type { ReproTarget, Omission, ReproductionTrigger } from "../types/repro.js";
import type { InstallDecision } from "./components.js";
import type { BlueprintV2 } from "./blueprint.js";

export interface ExpectedSignature {
  errorClass?: string;
  message?: string;
  file?: string;
  line?: number;
}

export interface TargetVerificationPlan {
  signatureIndex: number;
  attempted: boolean;
  trigger?: ReproductionTrigger;
  reason?: string;
  expectedSignature: ExpectedSignature;
}

export interface VerificationPlan {
  environmentChecks: {
    expectedWordPressVersion?: string;
    expectedPhpVersion?: string;
    /** WordPress.org references the Blueprint asks for. */
    expectedInstalledComponents: string[];
    /** Expected to be absent from the reconstructed site. */
    expectedOmittedComponents: string[];
    /** How to read what actually installed, per Phase 0 §2. */
    howToCheck: string;
  };
  logStrategy: {
    source: "debug.log";
    path: string;
    steps: string[];
  };
  targets: TargetVerificationPlan[];
}

export function buildVerificationPlan(
  environment: Environment,
  installs: InstallDecision[],
  omissions: Omission[],
  targets: ReproTarget[],
  blueprint: BlueprintV2,
): VerificationPlan {
  return {
    environmentChecks: {
      ...(blueprint.wordpressVersion !== undefined
        ? { expectedWordPressVersion: blueprint.wordpressVersion }
        : {}),
      ...(blueprint.phpVersion !== undefined ? { expectedPhpVersion: blueprint.phpVersion } : {}),
      expectedInstalledComponents: installs.map((i) => i.reference),
      expectedOmittedComponents: omissions.map((o) => o.component),
      howToCheck:
        "Execute PHP inside the booted site and read get_plugins() and get_option('active_plugins'). Phase 0 established that run-blueprint reports nothing and that a zero exit code does not prove a plugin installed.",
    },

    logStrategy: {
      source: "debug.log",
      path: "/wordpress/wp-content/debug.log",
      steps: [
        "1. Boot the environment from the Blueprint and let it settle.",
        "2. Snapshot /wordpress/wp-content/debug.log in full. Entries present at this point are boot noise and are never evidence of reproduction.",
        "3. Execute this target's trigger, and only this target's trigger.",
        "4. Snapshot debug.log again.",
        "5. Diff the two snapshots and keep only entries added by step 3.",
        "6. Extract errorClass, message, file and line from the new entries with a fixed pattern, and record the pattern and whether extraction was deterministic.",
        "7. Compare the extracted signature against this target's expectedSignature. observed = true only when the trigger ran in step 3 and a matching new entry appeared.",
      ],
    },

    targets: targets.map((target) => {
      const signature = environment.signatures[target.signatureIndex];
      return {
        signatureIndex: target.signatureIndex,
        attempted: target.attempted,
        ...(target.trigger !== undefined ? { trigger: target.trigger } : {}),
        ...(target.reason !== undefined ? { reason: target.reason } : {}),
        expectedSignature: {
          ...(signature?.errorClass !== undefined ? { errorClass: signature.errorClass } : {}),
          ...(signature?.message !== undefined ? { message: signature.message } : {}),
          ...(signature?.file !== undefined ? { file: signature.file } : {}),
          ...(signature?.line !== undefined ? { line: signature.line } : {}),
        },
      };
    }),
  };
}
