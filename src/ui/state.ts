/**
 * Application state machine.
 *
 * Every stage the pipeline can be in is named, so the UI can always say what
 * it is doing and can never fail silently. Nothing here is inferred: a stage
 * changes only when the corresponding step actually starts or finishes.
 */
import type { Analysis } from "./analyze.js";
import type { Verification } from "../types/verification.js";

export type ReproStage =
  | "booting"
  | "verifying_environment"
  | "executing_triggers"
  | "finalising";

export const REPRO_STAGE_LABELS: Record<ReproStage, string> = {
  booting: "Booting WordPress Playground",
  verifying_environment: "Checking what actually installed",
  executing_triggers: "Executing reproduction triggers",
  finalising: "Collecting verification results",
};

export type AppState =
  | { kind: "idle" }
  | { kind: "parsing" }
  | { kind: "planning" }
  | { kind: "analysis_failed"; error: string }
  | { kind: "analysed"; analysis: Analysis }
  | {
      kind: "reproducing";
      analysis: Analysis;
      stage: ReproStage;
      progress: string[];
    }
  | {
      kind: "reproduced";
      analysis: Analysis;
      verification: Verification;
      progress: string[];
    }
  | {
      /** Infrastructure failure: the run could not complete at all. */
      kind: "reproduction_failed";
      analysis: Analysis;
      error: string;
      progress: string[];
    };

export type Listener = (state: AppState) => void;

export class Store {
  private state: AppState = { kind: "idle" };
  private readonly listeners = new Set<Listener>();

  get(): AppState {
    return this.state;
  }

  set(state: AppState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Appends a progress line without leaving the current stage. */
  pushProgress(message: string): void {
    const current = this.state;
    if (
      current.kind === "reproducing" ||
      current.kind === "reproduced" ||
      current.kind === "reproduction_failed"
    ) {
      this.set({ ...current, progress: [...current.progress, message] });
    }
  }
}
