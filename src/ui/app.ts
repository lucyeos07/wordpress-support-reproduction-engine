/**
 * Application wiring.
 *
 * Holds no business logic: it moves the state machine and calls the existing
 * pipeline modules. The browser executor is injected so tests can run without
 * a real Playground; the production default lazily imports the very same
 * `executePlanInBrowser` used by the Phase 5 parity spike. There is no second
 * implementation.
 */
import { analyze, AnalysisError, type Analysis, type InputFormat } from "./analyze.js";
import { Store, type AppState } from "./state.js";
import {
  renderEnvironment,
  renderFindings,
  renderReproducibility,
  renderBlueprint,
  renderSource,
  renderProgress,
  renderVerification,
  renderIsolationPanel,
} from "./render.js";
import { el, clear } from "./dom.js";
import type { Verification } from "../types/verification.js";
import type { ReproPlan } from "../types/repro.js";
import type { VerificationPlan } from "../repro/verification-plan.js";
import type { BootAttempt, IsolationResult } from "../execute/isolate.js";

export type BrowserExecutor = (
  plan: ReproPlan,
  verificationPlan: VerificationPlan,
  options: { iframe: HTMLIFrameElement; onProgress?: (message: string) => void },
) => Promise<Verification>;

/**
 * Bisects a failed boot. Injected like the executor so UI tests can run it
 * without a real Playground; production uses the same modules the CLI does.
 */
export type BrowserIsolator = (
  plan: ReproPlan,
  components: string[],
  options: {
    newFrame: () => HTMLIFrameElement;
    observedFailure?: BootAttempt;
    onProgress?: (message: string) => void;
  },
) => Promise<IsolationResult>;

export interface AppDeps {
  execute?: BrowserExecutor;
  isolate?: BrowserIsolator;
  copy?: (text: string) => Promise<void>;
}

const defaultExecutor: BrowserExecutor = async (plan, verificationPlan, options) => {
  const { executePlanInBrowser } = await import("../execute/browser-runner.js");
  return executePlanInBrowser(plan, verificationPlan, options);
};

const defaultIsolator: BrowserIsolator = async (plan, components, options) => {
  const [{ isolateBootFailure }, { probeBootInBrowser }] = await Promise.all([
    import("../execute/isolate.js"),
    import("../execute/browser-runner.js"),
  ]);
  return isolateBootFailure(components, (subset) => probeBootInBrowser(plan, subset, { iframe: options.newFrame() }), {
    ...(options.observedFailure !== undefined ? { observedFailure: options.observedFailure } : {}),
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
  });
};

const defaultCopy = async (text: string): Promise<void> => {
  await navigator.clipboard.writeText(text);
};

export function mountApp(root: HTMLElement, deps: AppDeps = {}): { store: Store } {
  const execute = deps.execute ?? defaultExecutor;
  const isolate = deps.isolate ?? defaultIsolator;
  const copy = deps.copy ?? defaultCopy;
  const store = new Store();

  // ---- shell ----------------------------------------------------------
  const textarea = el("textarea", {
    id: "artifact",
    class: "paste",
    rows: "14",
    spellcheck: "false",
    placeholder:
      "Paste a WooCommerce System Status Report, a PHP fatal / debug.log excerpt, or both.",
    "aria-describedby": "paste-help",
  });

  const formatSelect = el(
    "select",
    { id: "format", class: "select" },
    el("option", { value: "auto", text: "Auto-detect" }),
    el("option", { value: "ssr", text: "WooCommerce System Status Report" }),
    el("option", { value: "log", text: "PHP fatal / debug log" }),
  );

  const analyseButton = el("button", { id: "analyse", class: "button button-primary", type: "submit", text: "Analyze" });
  const status = el("p", { id: "status", class: "status", role: "status", "aria-live": "polite" });
  const results = el("div", { id: "results" });

  const PLAYGROUND_NOTE =
    "An isolated WordPress built from the reported environment. Your own site is never touched.";
  const PROBE_NOTE =
    "Showing an isolation probe: a subset of the reported components, not the reported environment. Your own site is never touched.";

  const playgroundNote = el("p", { id: "playground-note", class: "hint", text: PLAYGROUND_NOTE });
  const playgroundPanel = el(
    "section",
    { id: "playground-panel", class: "card playground-panel", hidden: true },
    el("h2", { text: "WordPress Playground" }),
    playgroundNote,
  );

  /**
   * Created fresh per run so a second reproduction never reuses the iframe of
   * a previous instance.
   */
  function freshPlaygroundFrame(): HTMLIFrameElement {
    const existing = playgroundPanel.querySelector("iframe");
    if (existing) existing.remove();
    const frame = el("iframe", {
      id: "playground",
      class: "playground-frame",
      title: "WordPress Playground reproduction",
    });
    playgroundPanel.append(frame);
    return frame;
  }

  const form = el(
    "form",
    { id: "analyse-form", class: "card" },
    el("label", { class: "label", for: "artifact", text: "Support artifact" }),
    el("p", {
      id: "paste-help",
      class: "hint",
      text: "WooCommerce → Status → Get system report, and/or the PHP fatal from wp-content/debug.log.",
    }),
    textarea,
    el(
      "div",
      { class: "controls" },
      el("label", { class: "label-inline", for: "format", text: "Format" }),
      formatSelect,
      analyseButton,
    ),
    status,
  );

  root.append(
    el(
      "header",
      { class: "masthead" },
      el("h1", { text: "WordPress Support Reproduction Engine" }),
      el("p", {
        class: "lede",
        text: "Turn a support artifact into a structured environment, evidence-backed findings, and a reproducible WordPress Playground instance.",
      }),
      el(
        "ol",
        { class: "workflow", "aria-label": "Workflow" },
        el("li", { text: "Paste artifact" }),
        el("li", { text: "Analyze" }),
        el("li", { text: "Review findings" }),
        el("li", { text: "Review reproducibility" }),
        el("li", { text: "Reproduce in Playground" }),
        el("li", { text: "Review verification" }),
      ),
      el("p", {
        class: "privacy",
        text:
          "Privacy: parsing, diagnosis and planning run entirely in this page — your artifact is not sent to any server of ours, and there is no backend. Launching a reproduction does download WordPress core and plugins from wordpress.org, and runs the site inside an iframe served by playground.wordpress.net. Your pasted text is never uploaded.",
      }),
    ),
    form,
    results,
    playgroundPanel,
  );

  // ---- behaviour -------------------------------------------------------
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    store.set({ kind: "parsing" });
    try {
      // Synchronous, but the parsing/planning stages are still distinct states
      // so the UI can report which step failed.
      const analysis = analyze(textarea.value, formatSelect.value as InputFormat);
      store.set({ kind: "planning" });
      store.set({ kind: "analysed", analysis });
    } catch (error) {
      const message =
        error instanceof AnalysisError
          ? error.message
          : `Could not analyse this artifact: ${String((error as Error).message)}`;
      store.set({ kind: "analysis_failed", error: message });
    }
  });

  function showEvidence(line: number): void {
    const target = root.querySelector<HTMLElement>(`#src-line-${String(line)}`);
    if (!target) return;
    for (const previous of root.querySelectorAll(".source-line.highlight")) {
      previous.classList.remove("highlight");
    }
    target.classList.add("highlight");
    target.scrollIntoView({ block: "center" });
  }

  async function reproduce(state: Extract<AppState, { kind: "analysed" }>): Promise<void> {
    playgroundPanel.hidden = false;
    playgroundNote.textContent = PLAYGROUND_NOTE;
    const playgroundFrame = freshPlaygroundFrame();
    store.set({ kind: "reproducing", analysis: state.analysis, stage: "booting", progress: [] });

    try {
      const verification = await execute(state.analysis.plan, state.analysis.verificationPlan, {
        iframe: playgroundFrame,
        onProgress: (message) => {
          const current = store.get();
          if (current.kind !== "reproducing") return;
          // Progress strings come from the executor; the stage is derived from
          // them rather than guessed on a timer.
          const stage =
            message === "ready"
              ? "verifying_environment"
              : message.startsWith("installed ")
                ? "executing_triggers"
                : message.startsWith("target ")
                  ? "executing_triggers"
                  : current.stage;
          store.set({ ...current, stage, progress: [...current.progress, message] });
        },
      });

      const current = store.get();
      const progress = current.kind === "reproducing" ? current.progress : [];
      store.set({ kind: "reproduced", analysis: state.analysis, verification, progress });
    } catch (error) {
      // Infrastructure failure: the run could not complete. This is not a
      // statement about reproducibility.
      const current = store.get();
      const progress = current.kind === "reproducing" ? current.progress : [];
      store.set({
        kind: "reproduction_failed",
        analysis: state.analysis,
        error: String((error as Error).message),
        progress,
      });
    }
  }

  /**
   * Bisects a boot that failed. Only reachable from a verification whose boot
   * failed, and it never rewrites the plan: each probe boots a subset, and the
   * plan the user saw is left as it is.
   */
  async function runIsolation(
    analysis: Analysis,
    verification: Verification,
    progress: string[],
  ): Promise<void> {
    const blueprint = analysis.plan.blueprint as { plugins?: Array<{ source: string }> };
    const components = (blueprint.plugins ?? []).map((p) => p.source);
    store.set({ kind: "isolating", analysis, verification, progress, isolationProgress: [] });

    // The boot that just failed is evidence the search would otherwise pay a
    // whole boot to re-establish.
    const observedFailure = {
      components,
      bootSucceeded: false,
      installedComponents: verification.environment.installedComponents,
      ...(verification.failureReproduction.targets[0]?.reason !== undefined
        ? { error: verification.failureReproduction.targets[0].reason }
        : {}),
    };

    try {
      const isolation = await isolate(analysis.plan, components, {
        observedFailure,
        newFrame: () => {
          playgroundPanel.hidden = false;
          // The frame now shows a subset, so the panel must stop calling it
          // the reported environment.
          playgroundNote.textContent = PROBE_NOTE;
          return freshPlaygroundFrame();
        },
        onProgress: (message) => {
          const current = store.get();
          if (current.kind !== "isolating") return;
          store.set({ ...current, isolationProgress: [...current.isolationProgress, message] });
        },
      });
      store.set({ kind: "isolated", analysis, verification, progress, isolation });
    } catch (error) {
      store.set({
        kind: "isolation_failed",
        analysis,
        verification,
        progress,
        error: String((error as Error).message),
      });
    }
  }

  // ---- rendering -------------------------------------------------------
  /** The states that carry a completed verification. */
  const verificationOf = (state: AppState): Verification | undefined =>
    state.kind === "reproduced" ||
    state.kind === "isolating" ||
    state.kind === "isolated" ||
    state.kind === "isolation_failed"
      ? state.verification
      : undefined;

  /**
   * The isolation offer, shown only when the boot actually failed and the plan
   * requested at least one component — otherwise there is nothing to bisect.
   */
  function isolationSection(state: AppState): Node | false {
    const verification = verificationOf(state);
    if (verification === undefined || verification.environment.bootSucceeded) return false;
    if (
      state.kind !== "reproduced" &&
      state.kind !== "isolating" &&
      state.kind !== "isolated" &&
      state.kind !== "isolation_failed"
    ) {
      return false;
    }

    const analysis = state.analysis;
    const blueprint = analysis.plan.blueprint as { plugins?: Array<{ source: string }> };
    const components = (blueprint.plugins ?? []).map((p) => p.source);
    if (components.length === 0) return false;

    return el(
      "section",
      { class: "card" },
      renderIsolationPanel({
        components,
        busy: state.kind === "isolating",
        onIsolate: () => {
          void runIsolation(analysis, verification, state.progress);
        },
        ...(state.kind === "isolating" ? { progress: state.isolationProgress } : {}),
        ...(state.kind === "isolated" ? { result: state.isolation } : {}),
        ...(state.kind === "isolation_failed" ? { error: state.error } : {}),
      }),
    );
  }

  store.subscribe((state) => {
    analyseButton.disabled = state.kind === "parsing" || state.kind === "planning";

    const statusText: Record<AppState["kind"], string> = {
      idle: "",
      parsing: "Parsing artifact…",
      planning: "Planning reproduction…",
      analysis_failed: "",
      analysed: "Analysis complete.",
      reproducing: "Reproducing…",
      reproduced: "Reproduction run complete.",
      reproduction_failed: "",
      isolating: "Isolating the failing component…",
      isolated: "Isolation complete.",
      isolation_failed: "",
    };
    status.textContent = statusText[state.kind];
    status.className = "status";

    if (state.kind === "analysis_failed") {
      status.textContent = state.error;
      status.className = "status status-error";
      clear(results);
      return;
    }

    if (state.kind === "idle" || state.kind === "parsing" || state.kind === "planning") {
      if (state.kind === "idle") clear(results);
      return;
    }

    const analysis = state.analysis;
    clear(results);

    const reproduceButton = el("button", {
      id: "reproduce",
      class: "button button-primary",
      type: "button",
      text: "Reproduce in WordPress Playground",
    });
    reproduceButton.disabled = state.kind === "reproducing" || state.kind === "isolating";
    reproduceButton.addEventListener("click", () => {
      void reproduce({ kind: "analysed", analysis });
    });

    const verification = verificationOf(state);
    const blocks: Array<Node | false> = [
      renderEnvironment(analysis, showEvidence),
      renderFindings(analysis, showEvidence),
      renderReproducibility(analysis),
      renderBlueprint(analysis, (text) => {
        void copy(text);
      }),
      el(
        "section",
        { class: "card" },
        el("h2", { text: "Reproduce" }),
        el("p", {
          class: "hint",
          text: "Builds the environment above in an isolated WordPress Playground instance and executes each target's trigger.",
        }),
        el("div", { class: "actions" }, reproduceButton),
        state.kind === "reproducing" ? renderProgress(state.stage, state.progress) : false,
        state.kind === "reproduction_failed"
          ? el(
              "div",
              { class: "panel panel-fail", role: "alert" },
              el("h3", { text: "Infrastructure failure" }),
              el("p", { class: "prose", text: state.error }),
              el("p", {
                class: "hint",
                text: "The reproduction run could not complete. This is not a statement about whether the reported failure is reproducible.",
              }),
            )
          : false,
      ),
      verification !== undefined ? renderVerification(verification) : false,
      isolationSection(state),
      renderSource(analysis.source),
    ];
    for (const block of blocks) {
      if (block !== false) results.append(block);
    }
  });

  return { store };
}
