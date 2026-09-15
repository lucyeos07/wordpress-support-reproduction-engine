# Phase 5 findings — browser execution surface

Executes an existing `ReproPlan` in a browser Playground instance and produces
the same per-target `Verification` as the CLI. No production UI.

Date: 2026-09-15. 398 tests, typecheck clean, CI green.

> **Scope note.** The brief was truncated after section 1 (browser environment
> execution). Trigger execution and failure reproduction follow the CLI
> implementation you accepted and SPEC §9/§9.1; anything inferred is flagged.

---

## 1. What was built

| File | Role |
| --- | --- |
| `src/execute/core.ts` | Surface-agnostic execution: site inspection, component reconciliation, trigger execution, log diffing, Verification assembly |
| `src/execute/cli-runner.ts` | Boots via `runCLI`, delegates to the core |
| `src/execute/browser-runner.ts` | Boots via `startPlaygroundWeb`, delegates to the core |

### One structural change, flagged

You said not to redesign the CLI execution architecture. I did **not** change
how CLI execution works, but I did move its orchestration into `core.ts` so the
browser runner calls the same code.

The alternative was duplicating ~150 lines of semantics — the three-way
separation, the debug.log diff, the `observed` rule — into a second file, where
they could silently drift apart. `executePlan`'s signature, options and
behaviour are unchanged, and the 398-test suite plus the `execute-spike` CI job
pass without modification.

**Sharing the code is not the same as assuming the surfaces behave alike.**
SPEC §12 forbids that assumption, which is why parity is measured (§4) rather
than asserted by construction.

---

## 2. The browser API used

Exactly what Phase 0 verified:

```ts
const client = await startPlaygroundWeb({
  iframe,
  remoteUrl: "https://playground.wordpress.net/remote.html",
  blueprint: plan.blueprint,
});
await client.isReady();          // readiness signal
await client.run({ code });      // PHP execution
await client.request({ url });   // admin page load trigger
```

`startPlaygroundWeb` resolving is not treated as proof the runtime is usable;
`isReady()` is awaited separately, as in Phase 0.

Two Phase 0 constraints still hold and are recorded in the module header:

- The embedding page **must not be cross-origin isolated**, or the
  `playground.wordpress.net` iframe is blocked and `startPlaygroundWeb` never
  resolves. This is why the spike is driven with Playwright rather than the
  embedded browser pane.
- The browser runner does **not** tear down the instance. The caller owns the
  iframe and will usually want the reproduced site left on screen — which is
  the point of the browser surface.

A Blueprint step failure throws from `startPlaygroundWeb`, so boot failure is
attributed exactly as on the CLI: `bootSucceeded: false`, every requested
component recorded `(boot failed)`, every target `attempted: false` with the
boot error as its reason.

---

## 3. Environment reconstruction in the browser

Identical approach to the CLI, and for the same reason: the Blueprint is a
request, not a result. After `isReady()`, the runner asks WordPress itself via
`client.run()` — `get_plugins()` for what is on disk with each plugin's own
version header, and `get_option('active_plugins')` for what actually activated.

Live result:

```json
"environment": {
  "bootSucceeded": true,
  "installedComponents": ["classic-editor@1.6.3 (active)"],
  "failedComponents": []
}
```

The pinned version was confirmed from the plugin's own header inside the
running site, not from the Blueprint.

---

## 4. Surface parity — measured, 0 divergences

`spike/execute/parity.ts` executes the **same** `ReproPlan` on both surfaces and
compares the results field by field. Both build the plan from
`spike/execute/sample.ts`, so the input is provably identical — parity is
meaningless otherwise.

| Compared | Result |
| --- | --- |
| `bootSucceeded` | == |
| `installedComponents` | == |
| `failedComponents` | == |
| target count | == |
| `target0.attempted` | == |
| `target0.observed` | == |
| `target0.trigger` | == |
| `target0.errorClass` | == |
| `target0.reason` | == |

**0 divergences of 9 checks.** Browser end-to-end: ~16.7 s, against ~14 s for
the CLI.

Both produced the same honest negative for the sample plan:

```json
{ "attempted": true,
  "trigger": { "kind": "plugin_activation", "slug": "classic-editor" },
  "observed": false,
  "logs": [],
  "reason": "the trigger ran and wrote no new debug.log entries" }
```

Environment reconstructed, trigger executed, failure not observed — because the
reported fatal is synthetic and Classic Editor contains no such function.

---

## 5. Controlled proof that a real fatal is observed **in the browser**

The parity run above only demonstrates `observed: false`. Since §12 forbids
carrying the CLI's positive result across, the browser spike also boots a
second instance, writes a plugin that genuinely fatals on activation, and runs
the identical snapshot → diff → extract → compare pipeline through
`client.run()`:

```json
{
  "newEntries": 1,
  "errorClass": "Error",
  "message": "Call to undefined function phase5_function_that_does_not_exist()",
  "file": "/wordpress/wp-content/plugins/phase5-fatal/phase5-fatal.php",
  "line": 6,
  "deterministic": true,
  "observed": true,
  "matchedOn": ["errorClass", "message", "file"],
  "negativeControlMatches": false,
  "bootNoiseDiff": 0
}
```

Three controls, all matching the CLI's:

- **Real fatal detected**, deterministically, with class, message, file, line.
- **Path normalisation across roots** — expectation `/var/www/html/...`,
  runtime `/wordpress/...`, matched on the `wp-content` tail.
- **Negative control** — the same fatal against a different reported signature
  returns `matches: false`.
- **Boot-noise control** — diffing the pre-trigger log against itself returns
  **0 entries**, so a pre-existing error can never be reported as a
  reproduction.

So `debug.log` behaves as the authoritative evidence source on the browser
surface exactly as Phase 0 found on the CLI.

---

## 6. Limitations

1. **Parity is measured for one plan**, not across the fixture corpus. It
   covers boot, install, activation trigger and a negative reproduction; it does
   not exercise `admin_page_load` or `boot` triggers, nor a boot failure, on the
   browser surface.
2. **The browser cannot run in the embedded pane.** Phase 0's forced
   cross-origin isolation still blocks it, so every browser result here comes
   from Playwright Chromium. Other browsers are unverified.
3. **Re-activation caveat carries over.** The Blueprint activates plugins at
   boot, so the activation trigger deactivates and re-activates. Not identical
   to a first-ever activation; recorded in each affected `reason`.
4. **No teardown** in the browser runner is deliberate, but it means a caller
   executing several plans must manage instances itself.
5. **Still no fixture produces a genuine live reproduction**, because every log
   fixture is synthetic. `observed: true` is proven by the controlled case on
   both surfaces, not by a fixture plan.
6. **Verification is still not written back into `ReproPlan`**, as instructed.
   Both runners return it separately.

---

## 7. CI

A new `browser-parity-spike` job installs Playwright Chromium, serves the spike
page with Vite, and runs the CLI/browser comparison on `ubuntu-latest`,
alongside `check`, `cli-spike`, `execute-spike` and `v2-plugins-probe`.
