# Phase 6 findings — browser-first product UI

A usable local browser application over the existing deterministic pipeline. No
backend, no chatbot, no new dependencies beyond `jsdom` for tests.

Date: 2026-09-16. 433 tests, typecheck clean.

> **One known defect, unresolved:** the embedded Playground panel renders blank
> after a run, even though the runtime demonstrably boots, installs and
> verifies. Details and everything ruled out are in §8. Nothing else in the
> pipeline is affected.

---

## 1. UI architecture

Vanilla TypeScript and DOM — no framework, matching the project's existing
strict-TS/Vite setup rather than starting a rewrite.

| Module | Role |
| --- | --- |
| `src/ui/analyze.ts` | Composition only: calls the Phase 1–4 modules in order |
| `src/ui/state.ts` | The state machine and its store |
| `src/ui/outcome.ts` | Verification display semantics (§9.1) |
| `src/ui/dom.ts` | `el()` helper and presentation mappings |
| `src/ui/render.ts` | Pure render functions returning DOM |
| `src/ui/app.ts` | Wiring; holds no business logic |
| `app/` | `index.html`, `main.ts`, `styles.css` |

Vite now has two configs: `vite.config.ts` serves the product (`root: "app"`),
`vite.spike.config.ts` serves the Phase 0/4.5/5 spike pages unchanged.

**No business logic was duplicated.** The UI imports `parseSystemStatusReport`,
`parseDebugLog`, `attachSignature`, `diagnose`, `planReproduction` and
`executePlanInBrowser` as they are.

---

## 2. State flow

```
idle → parsing → planning → analysed
                     ↘ analysis_failed
analysed → reproducing(booting → verifying_environment → executing_triggers → finalising)
             ↘ reproduced
             ↘ reproduction_failed   (infrastructure)
```

Every stage is named, so the UI can always say what it is doing. Stages advance
from the executor's own progress messages, never from a timer, so the UI cannot
claim progress that did not happen.

---

## 3. Browser Playground integration

The primary action calls the **existing** `executePlanInBrowser`. The executor
is injected into `mountApp`, so tests run without a real Playground while
production lazily imports the very same module — there is no second
implementation.

One additive change to the Phase 5 module, for a concrete UI need: an optional
`onInstance` callback that hands the live client to the caller. The UI needs it
to navigate the reproduced site into view; execution semantics are untouched and
the verification path never uses it.

---

## 4. Privacy behaviour

The stated privacy text is deliberately not "nothing leaves your machine",
because that would be false:

> Parsing, diagnosis and planning run entirely in this page — your artifact is
> not sent to any server of ours, and there is no backend. Launching a
> reproduction does download WordPress core and plugins from wordpress.org, and
> runs the site inside an iframe served by playground.wordpress.net. Your
> pasted text is never uploaded.

Two tests enforce this: one asserts no `fetch`, `XMLHttpRequest` or
`sendBeacon` during analysis, and one asserts no form carries an `action` or
`method` that could post the artifact anywhere.

---

## 5. Error and loading states

| State | Shown as |
| --- | --- |
| Unusable paste | Inline error naming what was expected; results cleared |
| Parsing / planning | Status line; Analyze disabled |
| Parser warnings | Amber block, explicitly "not diagnoses" |
| Missing information | Listed from the Tier E request, explicitly "not a finding" |
| Booting → verifying → triggers → finalising | Ordered stage list with `aria-current` and a live progress log |
| Infrastructure failure | `role="alert"` panel stating it is **not** a statement about reproducibility |

Nothing fails silently: every state either renders results or an explanation.

### The conflation this UI refuses to make

`src/ui/outcome.ts` maps a verification to exactly four mutually exclusive
outcomes, and a failed boot outranks everything:

- **Environment failed** — the environment did not boot, so nothing was
  attempted; this says nothing about the bug
- **Trigger not attempted** — booted, but no supported trigger existed
- **Trigger attempted, failure not observed**
- **Failure reproduced**

Tests assert the phrase "not reproducible" never appears in any outcome, and
that a boot failure never renders as "failure not observed" — even when a
target is marked `observed: true`.

---

## 6. Accessibility

Labelled controls (`label[for]`, `aria-describedby`), `role="status"` with
`aria-live="polite"` for the status line and progress, `role="alert"` for
infrastructure failure, `aria-current="step"` on the active stage, real
`<button>` elements for evidence chips with descriptive `aria-label`s, a titled
Playground iframe, visible `:focus-visible` outlines, light/dark palettes with
non-colour status labels, a responsive single-column fallback under 720px, and
no animation anywhere.

---

## 7. Test coverage

**433 tests total**, 35 new UI tests in `tests/ui/app.test.ts` (jsdom):

successful parse · parser warning display · missing-information display ·
inferred-vs-known labelling · finding display with severity, confidence,
evidence, citation and remediation · evidence linking back to the pasted
artifact · multiple independent reproduction targets · unsupported trigger ·
reproducibility verdict, substitutions and omissions · Blueprint view/copy and
non-editability · Playground launch calling the existing executor with the
on-page iframe · environment reconstruction display · failure-reproduction
result · infrastructure failure · boot failure never phrased as "not
reproducible" · explicit progress stages · analysis still visible after launch ·
no network during analysis · no postable form · accessibility.

Deterministic business logic stayed in its existing modules and its existing
tests; the UI tests assert presentation and wiring only.

An end-to-end check against a **real** Playground (`spike/ui/reproduce.ts`)
confirms the full flow: analysis → launch → progress stages → boot succeeded →
`classic-editor@1.6.3 (active)` → "Trigger attempted, failure not observed",
in ~17 s, with the analysis still on screen.

---

## 8. Known defect: the Playground panel renders blank

After a run the embedded panel shows an empty frame, although the same run
reports `bootSucceeded: true`, installs `classic-editor@1.6.3` and returns a
correct verification. **The pipeline is unaffected; this is a presentation
defect.**

What was established:

- The outer iframe navigates correctly to
  `https://playground.wordpress.net/scope:…/`, which serves Playground's own
  wrapper page. The wrapper's nested `#wp` frame stays empty.
- `goTo("/")` **is** called and resolves — verified with instrumentation.
- An isolated page (`spike/browser/goto.html`) doing nothing but
  `startPlaygroundWeb` → `isReady()` → `goTo("/")` renders WordPress correctly
  in the same headless Chromium (`docs/screenshots/10-goto-isolation.png`).
- Replaying the executor's exact PHP calls — `get_plugins()`, reading
  debug.log, `deactivate_plugins()`, `activate_plugin()` — before `goTo` on
  that isolated page **still renders correctly**
  (`10-goto-execute.png`). So the trigger sequence is not the cause.
- Removing the pre-navigation `request("/")` does not change the isolated
  result (`10-goto-skiprequest.png`).
- Ruled out in the app: the iframe is connected, 1022×700, unhidden, and is the
  element passed to the executor.

Two fixes were tried and did **not** work: navigating at ready-time instead of
after verification, and creating the iframe fresh at launch instead of keeping
it hidden from page load. Both were kept because they are defensible on their
own (the second also avoids reusing a stale instance across runs), but neither
resolves the blank panel, and saying otherwise would be false.

The remaining untested difference is something about the app page's DOM or
lifecycle versus the minimal spike page. The next step is to bisect by
progressively stripping the app page down to the spike page until the blank
frame appears or disappears.

---

## 9. Other known UX limitations

1. The `auto` format runs the System Status adapter even on a log-only paste,
   which adds a `woo-ssr` provenance entry for a report that was not supplied.
2. Multiple signatures are produced by splitting the paste on fatal lines and
   calling the single-signature adapter once per block, padded so evidence line
   numbers stay correct. The adapter itself was not changed.
3. No persistence: reloading the page loses the analysis.
4. No export of findings or verification as a report artifact.
5. Long artifacts render every source line eagerly; a very large paste will be
   heavy.
6. Only one reproduction run at a time; re-running replaces the instance.
