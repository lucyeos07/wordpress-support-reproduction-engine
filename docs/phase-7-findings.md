# Phase 7 findings — portfolio hardening

Making the existing product reliable, understandable and demonstrable. No new
subsystem, no backend, no redesign of the parser, rule engine, planner or
execution architecture.

Date: 2026-09-16. 453 tests, typecheck clean, CI green.

---

## 1. Correctness fix: auto mode created misleading provenance

**The defect.** `auto` ran the System Status adapter over **empty text** when the
paste was log-only, purely so the code had an `Environment` to attach a
signature to. That recorded a `woo-ssr` provenance artifact for a report nobody
supplied — the IR claimed to have read something that did not exist.

**The fix.**

- `emptyEnvironment()` (`src/ir/empty-environment.ts`) gives an Environment with
  **no artifacts**, every field `missing`. An adapter that did not run now
  contributes no provenance.
- `detectFormat()` returns `ssr | log | both | unrecognised` from deterministic
  structural evidence only: a `### Section ###` heading is the report's own
  format, a `PHP Fatal error:` line is PHP's. Format is never guessed from
  prose, length or field names — `"PHP Version: 8.1.27"` on its own is
  `unrecognised`.
- `Analysis.detected` and `Analysis.format` are now distinct: what the input
  **is**, versus which adapters actually **ran**.
- An explicit format choice is honoured, **but not against the evidence**.
  Selecting "System Status Report" for a log now fails with an explanation,
  because running the adapter anyway produces an empty result that looks like a
  successful parse — a silent failure.

16 regression tests in `tests/ui/analyze.test.ts`, including the direct
assertion that a log-only paste yields `adapters == ["debug-log"]` and never
`woo-ssr`.

---

## 2. Error and uncertainty states

Every state in the brief is represented and distinguishable:

| State | Presentation |
| --- | --- |
| Empty input | "Paste a WooCommerce System Status Report or a PHP fatal / debug log." |
| Unrecognised input | Names both formats and what was looked for; results cleared |
| Explicit format contradicted by evidence | Refused, with the reason |
| Partially parsed | `missing` badges per field, plus warnings and the information request |
| Parser warnings | Amber block, explicitly "not diagnoses" |
| Insufficient evidence | "Missing information", explicitly "not a finding" |
| Playground boot failure | "Environment failed" + `(boot failed)` per component |
| Component installation failure | Listed under "Failed components" |
| Unsupported trigger | "No supported trigger" pill + the planner's reason |
| Trigger not attempted | Its own outcome, distinct from the two below |
| Attempted, not observed | "Trigger attempted, failure not observed" |
| Failure reproduced | "Failure reproduced" |
| Infrastructure failure | `role="alert"`, explicitly *not* a statement about reproducibility |

The three the product exists to keep apart — **the bug was not reproduced**,
**the environment could not be created**, and **there was not enough evidence to
try** — are separate outcomes in `src/ui/outcome.ts`, with a failed boot
outranking everything. Tests assert the phrase "not reproducible" never appears
in any outcome. Verification semantics were not changed.

A provenance legend (`known / inferred / missing / warning`) now appears above
the Environment, and a six-step workflow strip in the masthead makes the primary
path obvious. No animation, no decoration.

---

## 3. Demo corpus

Four demos in `fixtures/demos/`, each exercising a different part of the
architecture. **All artifacts are marked synthetic**; they follow verified real
formats but describe invented sites. No production history is implied.

| Demo | Demonstrates | Key assertion |
| --- | --- | --- |
| A | Deterministic Finding from a report alone | `PHP_BELOW_PLUGIN_REQUIREMENT`, high/high, cites the version's own `readme.txt` |
| B | Catalog-resolved plugin ownership → executable trigger | owner slug `woocommerce`, trigger `plugin_activation`, Blueprint pins `woocommerce@8.5.2` |
| C | Real Playground run reaching `observed = true` | deterministic extraction from `debug.log`, outcome `reproduced` |
| D | Honest limitations | premium + unresolved + theme omitted, two independent targets, no slug guessed |

### Why Demo C uses an injected plugin

**No plugin in the WordPress.org repository was found that fatals on activation
under any PHP version Playground offers.** Three real candidates were tested and
rejected:

- **A modern plugin on PHP 5.2** — Playground offers 5.2, but its own SQLite
  integration is not 5.2-compatible: `PHP Parse error … in sqlite-database-integration.php`.
  The environment fails to boot before any plugin loads.
- **Contact Form 7 4.9 on PHP 8.x** — uses `create_function()`, removed in PHP
  8, but only inside `wpcf7_autop()` at render time. Activation never reaches it.
- **WooCommerce 6.4.1 on PHP 8.4 and 8.5** — produces only deprecations
  (`Using ${var} in strings`); that syntax is removed in PHP 9, which Playground
  does not offer.

So Demo C writes a plugin that genuinely fatals into the instance and runs it
through the **real shared verification core**. It is a controlled case by
necessity, labelled as such, not a stub.

---

## 4. End-to-end regression

`npm run demo` runs all four through the full pipeline and exits non-zero on any
mismatch. It runs in CI as `demo-e2e`. Both required proofs are present, in the
same run:

- **`observed = true`** — Demo C: boot succeeded, trigger attempted, observed
  true, error class `Error` extracted deterministically from `debug.log`,
  outcome `reproduced`.
- **`observed = false`, not conflated** — Demo B executed: boot succeeded,
  `classic-editor@1.6.3 (active)` read back out of WordPress, trigger attempted,
  observed false, and the outcome asserted to be `attempted_not_observed` rather
  than `environment_failed`.

Demo B's execution swaps WooCommerce (20 MB) for Classic Editor (19 KB) so the
CI job stays quick while still exercising the real executor.

---

## 5. Evidence interaction

Five new tests (`tests/ui/app.test.ts`) covering the brief's list: a chip
highlights exactly the line it cites; the highlight moves rather than
accumulating; several chips citing one line behave; a 400-line padded artifact
still renders every line and the cited line resolves past the padding; and
neither the textarea nor the rendered source is mutated by clicking.

---

## 6. Blueprint, Playground and privacy

The Blueprint stays read-only — a test asserts no `textarea` and no
`contenteditable` inside it — with view and copy, and states that it represents
the reported environment. Substitutions are listed beside it, so a substituted
environment is never presented as an exact match.

No `goTo()` or other speculative navigation was reintroduced: Phase 6.1 proved
Playground navigates to the site itself after boot. The content-based regression
guard (`ui-e2e-spike`) remains.

Privacy wording was re-checked against the implementation and SPEC §3. It
distinguishes the two cases: the artifact never leaves the page and there is no
backend (asserted by a test that no `fetch`/`XHR`/`sendBeacon` occurs during
analysis), while launching a reproduction genuinely loads WordPress core and
plugins from `wordpress.org` through an iframe served by
`playground.wordpress.net`.

---

## 7. Documentation and hygiene

- **`README.md`** — problem, pipeline, why it is built this way, Mermaid
  architecture diagram, run instructions, a worked example ending in the honest
  "trigger attempted, failure not observed", a full limitations section, privacy
  and testing.
- **`docs/ARCHITECTURE.md`** — every layer, with the invariant stated at the
  top: *reproduction reconstructs the reported environment, not the diagnosis*.

Cleanup: removed two genuinely unused exports (`catalogSize`, `isPresent`) and
the temporary probe scripts; added `test-results/` and `playwright-report/` to
`.gitignore`. The final packaging pass additionally moved the two test-scenario
modules out of `src/` into `tests/cases/`, removed the duplicate spike
stylesheet, and replaced three hard-coded absolute paths in spike drivers. **Nothing historical was deleted** — every findings document and
spike remains, including the Phase 6 defect report that Phase 6.1 withdrew,
because the record of a wrong conclusion and its correction is evidence.

~~`spike/browser/app-styles.css` is a copy of `app/styles.css` kept so the bisect
harness can load it; it will drift if the stylesheet changes.~~ **Resolved in the
final packaging pass:** the bisect harness now imports `app/styles.css`
directly, so the duplicate was deleted and the step tests the real stylesheet.

---

## 8. Final state

**453 tests**, typecheck clean under strict TypeScript
(`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`).

| Suite | Tests |
| --- | --- |
| `repro-planner` | 150 |
| `rules` | 92 |
| `woo-ssr-parser` | 82 |
| `ui/app` | 40 |
| `debug-log-parser` | 33 |
| `log-evidence` | 23 |
| `ui/analyze` | 16 |
| `blueprint-schema` | 9 |
| `repro-firewall` | 8 |

CI on `ubuntu-latest`: `check`, `cli-spike`, `execute-spike`,
`browser-parity-spike`, `ui-e2e-spike`, `demo-e2e`, `v2-plugins-probe`.

---

## 9. Remaining known limitations

Unchanged from earlier phases and documented in the README:

1. Tier A is unreachable while Playground substitutes SQLite; tier C is
   unreached by any fixture.
2. "Relevant omission" is structurally almost unreachable — the components we
   cannot install are exactly those whose slugs we do not know.
3. Themes cannot be implicated, installed or reproduced.
4. 31-entry catalog, 4 diagnostic rules, 11 recorded version requirements.
5. Plugin activation is really re-activation.
6. One signature per fatal; `firstFatal` takes the first extractable one.
7. Browser results verified in Chromium only; the embedding page must not be
   cross-origin isolated.
8. English-language plain-text System Status exports only.
9. No persistence, no report export, and long artifacts render every source line
   eagerly.
10. `observed = true` is proven by a controlled injected plugin, for the reason
    in §3.
