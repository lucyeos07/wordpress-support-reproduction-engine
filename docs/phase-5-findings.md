# Phase 5 findings — executing ReproPlans

Executes a `ReproPlan` in a real Playground instance and produces a
`Verification` (docs/SPEC.md §9). No production UI.

Date: 2026-09-15. 398 tests, typecheck clean.

> **Scope note.** The Phase 5 brief was truncated after section 1 (environment
> reconstruction); the sections on trigger execution, failure reproduction,
> surfaces, tests and deliverables did not arrive. What is built here follows
> §9/§9.1 of the committed SPEC and the verification plan accepted in Phase 4,
> which already specified the seven-step debug.log strategy. The CLI surface is
> implemented and CI-verified; **the browser execution surface is not built** —
> see §7. Anything inferred is called out.

---

## 1. The three things, kept apart

`Verification` never collapses these into one boolean:

| | Question | Where it lands |
| --- | --- | --- |
| 1 | Did the environment boot, and what actually installed? | `environment` — one shared result |
| 2 | Was **this target's** trigger actually executed? | `TargetVerification.attempted` |
| 3 | Did the reported failure appear **because of it**? | `TargetVerification.observed` |

`observed` requires both that the trigger ran and that what it produced matches
what was reported. It is never inferred from a successful boot, a matching
environment, or another target's outcome.

The `Verification` type was migrated to the committed §9 shape:
`failureReproduction.targets: TargetVerification[]`, matched by
`signatureIndex`.

---

## 2. Environment reconstruction

After boot, the runner asks WordPress itself — `get_plugins()` for what is on
disk with each plugin's own version header, and `get_option('active_plugins')`
for what actually activated. Phase 0 established that a zero exit code proves
nothing, so nothing is taken from the Blueprint or the CLI status.

Each requested reference is then reconciled:

- absent from WordPress → `failedComponents`, `"(not installed)"`
- present at a different version → `failedComponents`,
  `"(installed X instead)"` — Phase 4.5 verified pinning is exact, so a
  mismatch is a real divergence, not expected fuzziness
- present → `installedComponents`, annotated `(active)` or
  `(installed, not active)`

**Boot failure is attributed, not swallowed.** Phase 4.5 found that one
unavailable plugin version aborts the entire boot. When that happens
`bootSucceeded` is false, every requested component is recorded as failed with
`(boot failed)`, and every target gets `attempted: false` with the boot error as
its reason. Nothing is reported as installed.

---

## 3. Trigger execution

| Trigger | How it is executed |
| --- | --- |
| `boot` | The boot itself is the trigger, so the baseline is empty and the log written during boot is the evidence |
| `plugin_activation` | Deactivate, snapshot, then `activate_plugin()` |
| `admin_page_load` | Snapshot, then request the path |

For every trigger other than `boot`, the baseline is the log **as it stood
after boot**, so boot noise is excluded by construction.

**The activation caveat is recorded on the result, not hidden.** The Blueprint
activates plugins at boot, so an activation fatal would already have happened
before the trigger could run. The runner therefore deactivates first and
re-activates. That is not identical to a first-ever activation — activation
hooks may have already run once — and every affected `TargetVerification`
carries that sentence in its `reason`.

A target the planner marked `attempted: false` is never executed. Substituting
some other trigger to fill the slot would be fabrication.

---

## 4. Failure reproduction

The evidence layer (`src/execute/log-evidence.ts`) is pure and has no runtime
dependency:

1. `splitEntries` — a debug.log entry is a timestamped line plus its
   continuation lines, so a stack trace stays attached to its fatal.
2. `newEntries(before, after)` — whole-entry multiset diff. Comparing entries
   rather than line counts or byte offsets means a rotated or truncated log
   cannot yield "everything is new", and a repeated identical fatal still
   counts as new the second time.
3. `extractError` — the two fixed patterns from Phase 0. `deterministic: true`
   only when a pattern matched; a fatal matching neither yields no class and no
   message, `deterministic: false`, and the raw entry as evidence.
4. `compareSignature` — compares only fields the report actually stated and the
   extraction actually produced. Paths compare by their `wp-content/...` tail,
   because the reported site is `/var/www/html/...` and Playground is
   `/wordpress/...`.

**An empty expectation never matches.** A match requires at least one compared
field and no disagreement, so a signature with nothing comparable produces
`observed: false` rather than a free pass.

---

## 5. What the live runs actually produced

### A real plan, executed (`npm run spike:execute`)

Environment: Classic Editor 1.6.3, PHP 8.2.15, WP 6.8.2. Plan: tier B, one
target, `plugin_activation classic-editor`. Boot-to-result: **13.9 s**.

```json
{
  "environment": {
    "bootSucceeded": true,
    "installedComponents": ["classic-editor@1.6.3 (active)"],
    "failedComponents": []
  },
  "failureReproduction": {
    "targets": [{
      "signatureIndex": 0,
      "attempted": true,
      "trigger": { "kind": "plugin_activation", "slug": "classic-editor" },
      "observed": false,
      "logs": [],
      "reason": "the trigger ran and wrote no new debug.log entries"
    }]
  }
}
```

This is the correct and useful answer: **environment reconstructed, trigger
executed, failure not observed.** The reported fatal was synthetic — Classic
Editor contains no such function — so nothing should have reproduced, and the
system says so rather than inferring success from a healthy boot.

It also demonstrates the separation working: a green `environment` block sitting
next to `observed: false`.

### A controlled proof that a real fatal *is* detected

Because every log fixture in this project is synthetic, no fixture plan can
produce a genuine reproduction. So the spike installs a plugin that really
fatals on activation and runs the identical pipeline:

```
new entries: 1
extracted  : { "errorClass": "Error",
               "message": "Call to undefined function phase5_function_that_does_not_exist()",
               "file": "/wordpress/wp-content/plugins/phase5-fatal/phase5-fatal.php",
               "line": 6,
               "extraction": { "source": "debug.log", "deterministic": true, "pattern": "…" } }
comparison : { "matches": true, "matchedOn": ["errorClass","message","file"], "mismatchedOn": [] }
OBSERVED   : true
```

Three controls in the same run:

- **Path normalisation works across roots.** The expectation used
  `/var/www/html/wp-content/plugins/phase5-fatal/…`; the runtime produced
  `/wordpress/wp-content/plugins/phase5-fatal/…`; they matched on the tail.
- **Negative control.** The same extracted fatal compared against a different
  reported signature returned `matches: false`, mismatching on all three fields.
- **Boot noise control.** Diffing the pre-trigger log against itself returned
  **0 entries**, so a pre-existing error can never be reported as a
  reproduction.

---

## 6. Tests

| Suite | Tests |
| --- | --- |
| `repro-planner.test.ts` | 150 |
| `rules.test.ts` | 92 |
| `woo-ssr-parser.test.ts` | 82 |
| `debug-log-parser.test.ts` | 33 |
| `log-evidence.test.ts` | **23 (new)** |
| `blueprint-schema.test.ts` | 9 |
| `repro-firewall.test.ts` | 9 |
| **Total** | **398** |

The evidence-layer tests run against **verbatim debug.log text captured from a
real Playground run in Phase 0**, not invented strings. They cover the false
positives that matter: a pre-existing fatal is never new; a truncated log is not
all-new; an unparseable fatal is marked non-deterministic rather than guessed; a
classless fatal gets no invented class; an empty expectation never matches.

Live execution is deliberately **not** in the vitest suite — it needs network
and ~14 s per boot, which would make the unit suite slow and flaky. It runs as a
CI job (`execute-spike`) alongside the existing `cli-spike`.

---

## 7. Limitations

1. **The browser execution surface is not built.** `src/execute/cli-runner.ts`
   is CLI-only. SPEC §12 forbids assuming one surface from the other, so browser
   execution is unverified and must not be claimed. The pure evidence layer is
   surface-independent and would be reused as-is.
2. **Activation is re-activation.** Deactivate-then-activate is not a
   first-ever activation. Recorded in every affected `reason`, but it means a
   fatal that only fires on true first activation may not reproduce.
3. **No fixture produces a genuine live reproduction**, because every log
   fixture is synthetic. `observed: true` is proven by the controlled §5 case,
   not by a fixture plan. A real customer artifact would be needed for a true
   end-to-end positive.
4. **First fatal only.** `firstFatal` takes the first extractable fatal among
   new entries; a trigger producing several is not fully modelled.
5. **Line numbers are extracted but not compared.** Reported and reproduced
   line numbers legitimately differ across plugin versions, so comparing them
   would produce false negatives. They are recorded, not matched on.
6. **The Phase 4.5 pre-flight recommendation is not implemented.** Boot failure
   is caught and attributed (option 2), which is what §1 of the brief requires;
   the `HEAD` pre-flight (option 1) remains a recommendation.
7. **`ReproPlan.verification` is still not populated by the planner.** The
   runner returns a `Verification` separately. Wiring it back onto the plan is a
   deliberate non-decision until the UI phase shows what shape is wanted.

---

## 8. CI

A new `execute-spike` job boots Playground, executes a trigger, and diffs
debug.log on `ubuntu-latest`, alongside `check`, `cli-spike` and
`v2-plugins-probe`.
