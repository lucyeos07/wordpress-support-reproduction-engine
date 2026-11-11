# Boot-failure isolation

Turning `Environment failed` from a dead end into an answer.

Date: 2026-10-21. Added after the MVP was feature-complete, because the manual
step it replaces came up every single time an environment refused to boot.

---

## 1. The problem it solves

Playground installs a Blueprint's components all-or-nothing. One component that
cannot be downloaded, or that fatals while WordPress activates it, aborts the
whole boot — so the Verification is forced to report *every* requested component
as failed and none as responsible:

```
Boot failed
Installed components (0)
Failed components (6)
  woocommerce@8.5.2 (boot failed)
  wordpress-seo@21.7 (boot failed)
  ...
```

That is accurate and it is useless. The support engineer's next move is always
the same: drop half the plugins, boot again, repeat. This automates exactly that,
and nothing else.

## 2. What it does

```
precondition : the full set must actually fail  (supplied by the failed
               Verification, or booted once to establish it)
control      : boot with no components           -> if this fails, the
               WordPress/PHP environment is at fault, not any component
narrow       : binary search the failing set     -> if both halves boot alone,
               it is a conflict, not a culprit
confirm      : boot everything except the candidate
```

`src/execute/isolate.ts` holds the search and nothing surface-specific. The
caller injects a probe — `probeBoot` on the CLI, `probeBootInBrowser` in the
page — and both read what installed back out of WordPress using the execution
core's own `readSiteState` / `reconcileComponents`, so "installed" means the
same thing here as it does in a Verification.

## 3. What it refuses to do

- **It does not name a culprit it has not confirmed.** Narrowing to one
  component is a hypothesis. The claim is only made after *everything except
  that component* has booted, and the result carries that boot's component list
  as evidence.
- **It does not resolve a conflict into a culprit.** When each half boots alone
  and only the union fails, it reports `combination` with both groups. Picking
  one of them would be a guess.
- **It does not mistake an environment failure for a component failure.** If a
  Blueprint with zero components already fails, it says so and stops rather than
  bisecting a list that cannot explain anything.
- **It does not edit the plan.** Removing a component is an experiment, not a
  substitution (CLAUDE.md). The `ReproPlan` and the Blueprint shown to the user
  are untouched, and a UI test asserts the plan is byte-identical afterwards.
- **It does not run past its budget.** Each boot downloads WordPress and the
  subset's plugins, so the search is bounded. Exhausting the budget is reported
  as `inconclusive` with the attempts so far — never as a best guess.
- **It separates its own failure from a verdict.** If the bisection cannot run,
  that is reported as an infrastructure failure which "says nothing about which
  component is responsible".

## 4. Cost

Worst case is `2 * log2(n) + 3` boots: the full set, the control, up to two per
halving, and the confirmation. Booting the half about to be discarded is
deliberate — it is the only thing that distinguishes "the other half contains a
bad component" from "the two halves conflict", and that cannot be inferred.

Supplying the already-observed failure (the UI does; it has one) saves a boot.

## 5. Tests

- `tests/boot-isolation.test.ts` — 13 tests over the search itself with an
  injected probe, so the whole algorithm is verified offline: confirmation
  before naming, conflicts, environment-level failure, multiple culprits,
  budget bounds, attempt recording, and quoting the most specific failure text
  rather than the widest.
- `tests/ui/isolation.test.ts` — 8 tests over the UI: offered only after a
  failed boot, asks for exactly the plan's components, hands over the observed
  failure, reports culprit/conflict/infrastructure-failure distinctly, and never
  rewrites the plan.

## 6. Measured run — demo B, real Playground

`npm run spike:isolate` on 2026-10-21, against
`fixtures/demos/demo-b-plugin-fatal.txt`:

```
attempts: 7 of a 10 boot budget, in 428.7s

  FAILED  woocommerce@8.5.2, wordpress-seo@21.7, contact-form-7@5.8.6,
          wordfence@7.11.4, akismet@5.3, classic-editor@1.6.3
          Error when executing the blueprint step #5: PHP.run() failed with exit code 255.
  BOOTED  (none)
  BOOTED  woocommerce@8.5.2, wordpress-seo@21.7, contact-form-7@5.8.6
  FAILED  wordfence@7.11.4, akismet@5.3, classic-editor@1.6.3
  FAILED  wordfence@7.11.4, akismet@5.3
  FAILED  wordfence@7.11.4
          Error when executing the blueprint step #2: PHP.run() failed with exit code 255.
  BOOTED  woocommerce@8.5.2, wordpress-seo@21.7, contact-form-7@5.8.6,
          akismet@5.3, classic-editor@1.6.3

outcome: "component"
wordfence@7.11.4 aborts the boot. The other 5 component(s) installed without it.
```

Seven boots, just over seven minutes, and the answer matches the one previously
established by hand during the packaging pass: Wordfence 7.11.4 throws
`WP_MySQL_On_SQLite_Exception` from `wfDB.php` during activation, because
Playground runs on SQLite.

Two details worth noting in that trace:

- The last failing boot contains **only** the culprit, and that is the failure
  text the result quotes. The original six-component failure named blueprint
  step #5; the single-component boot names step #2. Quoting the widest failure
  would have pointed a reader at the wrong step.
- The confirming boot installed five components, which is what licenses the
  claim. Without it the run would have narrowed to a candidate and stopped at a
  hypothesis.

`isolate-spike` runs this in CI and asserts the component named, so the search
failing is a red build rather than a line nobody reads. A control boot that
fails there is reported as an infrastructure failure, not as a regression —
the same distinction `npm run demo` makes.

## 7. Known limitations

1. **It costs real boots.** Seven for six components, around seven minutes on
   the CLI and slower in a browser, because every boot downloads WordPress and
   the subset's plugins. This is a deliberate trade: the alternative is
   inference, which is what the project exists not to do.
2. **A conflict is reported, not resolved.** `combination` names the two groups
   and stops; finding the minimal failing pair would need a second search
   (delta debugging over pairs), which is not implemented.
3. **More than one culprit returns `inconclusive`.** When the environment still
   fails without the confirmed candidate, the result says another component is
   also responsible rather than iterating — bounded honestly, not completely.
4. **Only Blueprint plugin components are bisected.** Themes, must-use plugins
   and drop-ins are omissions, not Blueprint entries, so they are never part of
   the search.
5. **Browser verification is Chromium-only**, like every other browser result in
   this project.
