# Phase 4 findings

Deterministic reproducibility planning. No production UI, no Playground
execution — that is Phase 5.

Date: 2026-09-15. 12 plan cases, 372 tests, typecheck clean, CI green
(run `34953715302`, 1m13s).

---

## 1. Planner architecture

`src/repro/`, which imports nothing from `src/rules/`:

| Module | Responsibility |
| --- | --- |
| `capabilities.json` | Every Playground capability fact the planner is allowed to use, each recording how it was verified |
| `relevance.ts` | §6.1 usability, implication and relevance |
| `components.ts` | Per-component install/omit decision, driven by `Plugin.kind` and `source` |
| `triggers.ts` | §8.1 trigger derivation, per signature |
| `blueprint.ts` | Blueprint v2 generation and PHP version resolution |
| `plan.ts` | Orchestration, per-target tiers, plan verdict |
| `verification-plan.ts` | What Phase 5 should check, separate from what it will find |

`planReproduction(environment)` returns `{ plan, verificationPlan }`.
`ReproPlan.verification` stays `undefined`: producing a plan proves nothing.

### Firewall enforcement

Two layers, both in `tests/repro-firewall.test.ts`:

1. **No import edge** — no file under `src/repro/` may import `rules/`,
   `types/finding`, `types/diagnosis` or `types/rule`.
2. **No identifier** — with comments stripped, no file may contain `Finding`,
   `diagnose(`, `severity`, `confidence`, `reproducibilityImpact` or
   `citations`. This catches reading a diagnostic conclusion through a
   structural type or `any`, which an import check alone would miss.

A third check asserts the serialised plan contains none of those keys.

### Capabilities are data, not assumptions

`capabilities.json` is the planner's only source of capability facts, and each
entry records `verifiedOn`. Before writing any generation code the published
Blueprint schema was re-fetched and compared against the Phase 0 vendored copy:
**byte-identical**, same SHA-256 prefix `60df08a9ffb7fd4e`. The CLI's PHP
choices were re-read from its own `--help`.

---

## 2. Tier decisions

Per target, in this order:

| Condition | Tier | Status |
| --- | --- | --- |
| Signature not usable per §6.1 | E | insufficient_evidence |
| No executable trigger (theme owner, unresolved plugin owner, plugin not installed) | D | blocked |
| A component **this signature implicates** cannot be installed | D | partial |
| A material substitution applies | B | reproducible |
| Otherwise | A | reproducible |

The plan verdict reports the **most reproducible** target and says so in a
`target_summary` reason. Per-target verdicts are never overwritten.

### Tier A is unreachable in practice, and that is the honest answer

Playground always runs WordPress on SQLite. Every reported WooCommerce site
runs MySQL or MariaDB. That substitution is material and unavoidable, so every
target that is otherwise perfectly reproducible lands at **B, not A**.

Tier A as defined — "without material environmental substitution" — is
therefore only reachable for a report that states no database at all. This is
not a bug in the taxonomy; it is what faithful accounting produces. Flagged in
case A was expected to be the common good case.

### Tier C did not fire, and no fixture was invented to make it

`C — Environment-bound` is implemented but unreached. The infrastructure
Playground cannot reproduce — web server, memory limit, database engine — has
**unknown** relevance under §6.1, because signatures implicate plugin and theme
paths and never infrastructure. Unknown relevance is surfaced and constrains the
tier; it does not establish that a limitation is relevant, which is what C
requires. Rather than manufacture a fixture to light it up, it is reported as
unreached.

### The bug the multiple-signatures fixture caught

The first implementation computed relevant omissions **globally** and applied
them to every target. With three signatures — plugin, theme, core — the
un-installable theme downgraded the WooCommerce plugin target to D as well.

That is precisely what the brief forbids: *"A limitation affecting one target
must not automatically downgrade an unrelated target."* Fixed by gating each
target on what **its own** signature implicates. The `omissions` list still
carries the §6.1 global relevance label; only the tiering is per-target.

After the fix: `#0 plugin → B`, `#1 theme → D`, `#2 core → B`, plan verdict `B`.

---

## 3. Trigger decisions

Per signature, first match wins:

1. A file or frame path naming a **direct** wp-admin page →
   `admin_page_load`. `/wp-admin/edit.php` qualifies;
   `/wp-admin/includes/plugin.php` does not, because it is an include and not a
   requestable page.
2. Owner is a plugin **with a catalog-resolved slug that this plan installs** →
   `plugin_activation`.
3. Owner is a plugin without a resolved slug → `attempted: false`,
   "there is no slug to install or activate. A slug is never guessed."
4. Owner is a theme → `attempted: false`, no reported theme is installable.
5. Core-owned or path-only → `boot`, which is always executable.

Nothing outside `boot | plugin_activation | admin_page_load` is ever emitted; a
test asserts it across every case. No checkout, webhook or payment-callback
trigger exists, so none is claimed.

---

## 4. Blueprint decisions

**v2**, one representation for both surfaces. Phase 0 verified that a v2
Blueprint installs and activates a repository plugin on the CLI and in the
browser, confirmed by introspecting the booted site rather than by exit code.
No property is emitted that is not in the published schema; every generated
Blueprint is validated against the vendored schema in the test suite.

Plugin references pin the reported version as `slug@version`. **This form is
documented in the schema but was never executed in Phase 0**, which installed
plain slugs only. `capabilities.json` records `versionPinnedVerified: false`;
Phase 5 execution is what will confirm it resolves. Pinning was chosen anyway
because the point is to reconstruct the reported site, not a current one.

`constants` sets `WP_DEBUG` and `WP_DEBUG_LOG`, because Phase 0 established
debug.log as the only authoritative runtime evidence.

---

## 5. Substitutions

Every one is recorded; none is silent.

| Situation | Recorded as |
| --- | --- |
| Reported MySQL/MariaDB | → SQLite, always |
| Reported PHP patch level (8.1.27) | → `8.1`, Playground pins major.minor only |
| Reported PHP version not offered (7.3) | → `7.4`, the lowest supported version above it |
| No PHP or WordPress version reported | → Playground default, property omitted |
| Debug logging | reported setting → `WP_DEBUG`/`WP_DEBUG_LOG` enabled for evidence capture |

Patch-level PHP is recorded but **not material**: it does not downgrade a tier.
Everything else is material.

Enabling debug logging is instrumentation rather than a reported setting, and
it changes the configuration, so it is declared as a substitution rather than
quietly applied. A test asserts both the SQLite and WP_DEBUG substitutions
appear in every plan that needs them.

---

## 6. Omissions

| Component | Why |
| --- | --- |
| Drop-in | a single file in wp-content, not a repository plugin; the report gives its filename and description, never its contents |
| Must-use plugin | installing it as an ordinary plugin would change when and whether it loads |
| Premium plugin | not in the repository, so no supported installation exists |
| Unresolved plugin | no catalog match, and a slug is never guessed from a display name |
| Theme | nothing in the IR yields a slug or URL |
| Web server, memory limit | Playground cannot reproduce them |

### "Relevant omission" is structurally almost unreachable

This is the sharpest finding of the phase. §6.1 implication requires either
`owner.slug` matching the component, or a signature path lying within the
component's **known path** — and a plugin's known path exists only when its slug
is known.

But the components we cannot install are **exactly the ones whose slugs we do
not know**: premium plugins, unresolved plugins, must-use plugins, drop-ins,
themes. So an omitted component can essentially never be proven relevant, and
the D-by-relevant-omission branch rarely fires.

The `unresolved-plugin` case shows it concretely: the log names
`wp-content/plugins/warehouse-sync-bridge/`, the report lists
"Warehouse Sync Bridge", and relevance is still **unknown** — because matching
the directory to the display name would be exactly the guess §4.4 and §6.1
forbid. The target is still correctly blocked, but by trigger derivation rather
than by relevance.

The consequence: **relevance is doing less work than the taxonomy assumes**.
Widening the catalog to carry directories for premium plugins would recover
some of it.

Related: under a strict reading, a **theme can never be implicated at all**.
§6.1 allows a theme's path to be used only "when the theme path/slug is known",
and the IR carries a display name only. An earlier draft inferred the theme from
`owner.type === "theme"`; that was removed as an extra rule the SPEC does not
define. The outcome is unchanged, because theme targets are already blocked at
trigger derivation.

---

## 7. Known limitations

1. Tier A unreachable for any report naming a database; tier C unreached.
2. Relevant omissions structurally almost unreachable (§6).
3. Themes cannot be implicated, installed, or reproduced at all.
4. `slug@version` installation is unverified until Phase 5.
5. The admin-page trigger uses the **first** wp-admin page path found; a
   signature naming several is not modelled.
6. Playground's PHP list was read from the CLI. The browser surface was
   verified at 8.2 only in Phase 0, and §12 forbids assuming one surface from
   the other, so the other versions are unverified in the browser.
7. WordPress release availability is not checked — that would need a network
   lookup the privacy model forbids at plan time. An unavailable release will
   fail at execution, not at planning.
8. Multiple signatures produce multiple targets sharing **one** reconstructed
   environment. If two signatures needed contradictory environments, the plan
   cannot express that.
9. No deduplication of identical signatures: two identical fatals produce two
   identical targets.

---

## 8. Scope beyond "the planner"

The committed multi-signature model required migrating
`Environment.signature` → `signatures` through the SSR parser, the log adapter,
`attachSignature`, the rule matchers and the rule definitions' `requires`. The
fatal rules now emit one Finding per matching signature instead of considering
only one. Expected findings were regenerated; the diffs were reviewed rather
than accepted blind.

---

## 9. Tests

| Suite | Tests |
| --- | --- |
| `repro-planner.test.ts` | 150 |
| `rules.test.ts` | 92 |
| `woo-ssr-parser.test.ts` | 82 |
| `debug-log-parser.test.ts` | 33 |
| `repro-firewall.test.ts` | 9 |
| `blueprint-schema.test.ts` | 6 |
| **Total** | **372** |

12 plan cases covering the required scenarios: fully reproducible plugin fatal,
theme fatal, unresolved plugin, premium omission, inactive irrelevant plugin,
must-use plugins, drop-ins, insufficient evidence, external dependency,
multiple signatures, plus an unusable signature, an unavailable PHP version and
an admin-page trigger.

Asserted across every case: deterministic plans; no Finding dependency
(structural, identifier and serialisation checks); no slug outside the catalog;
no silent substitution; one target per signature in order; every unattempted
target states a reason; every omission states a reason and a relevance; the
Blueprint validates against the published schema; and the reported environment
is represented faithfully — pinned WordPress version, and every installed
plugin traceable to a reported plugin at its reported version.

---

## 10. CI

Green on `ubuntu-latest`: run `34953715302`, 1m13s, all three jobs passing
(`check`, `cli-spike`, `v2-plugins-probe`). No Linux-specific differences.
