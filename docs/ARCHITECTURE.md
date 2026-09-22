# Architecture

> **The invariant everything else serves:**
> **Reproduction reconstructs the reported environment, not the diagnosis.**

A wrong diagnosis must not be able to steer the reproduction toward confirming
itself. That single rule is why the diagnostic layer and the reproduction layer
are separate module trees with an enforced boundary between them, rather than
one pipeline that shares state.

---

## Layer map

```
src/
  parsers/
    woo-ssr/      System Status Report → Environment
    debug-log/    PHP fatal → ErrorSignature (ownership attributed HERE)
  ir/             Field constructors, empty environment, signature attachment
  catalog/        Bundled plugin catalog + (name, author) and directory resolution
  types/          Environment, Signature, Finding, ReproPlan, Verification, warnings
  rules/          Declarative rule definitions + matchers + engine        ─┐
  repro/          Capabilities, relevance, components, triggers,          │ firewall
                  blueprint, planner, verification plan                  ─┘
  execute/        log-evidence (pure) + core + cli-runner + browser-runner
  ui/             analyze, state, outcome, dom, render, app
app/              index.html, main.ts, styles.css
```

---

## 0. Inputs

Two kinds of support artifact, pasted as text. Nothing is uploaded and no file is
read from disk by the application.

| Input | What it is | Recognised by |
| --- | --- | --- |
| **WooCommerce System Status Report** | The plain-text "Copy for support" export from WooCommerce → Status | a `### Section ###` heading |
| **PHP fatal / `debug.log`** | One or more fatals written to `wp-content/debug.log` | a `PHP Fatal error:`, `PHP Parse error:` or `PHP Recoverable fatal error:` line |

A single paste may hold **either, both, or neither** — a support ticket routinely
contains a report and a fatal together, which is why `auto` runs both adapters.

Detection (`ui/analyze.ts`) is structural and deterministic: it uses each
format's own syntax, never prose, length or field names. `PHP Version: 8.1.27`
alone is `unrecognised`, and an unrecognised paste is refused with an explanation
rather than parsed into an empty result. An explicit format choice is honoured
**but not against the evidence**: choosing "System Status Report" for a log fails,
because running that adapter anyway would produce an empty parse that looks like
a successful one.

Only an adapter that actually ran contributes provenance; the other side starts
from `emptyEnvironment()`, which carries no artifacts and no values.

A paste containing several fatals is split into one block per fatal, each padded
with leading newlines so that every evidence line number still refers to the line
in the text the user actually pasted. Each block becomes its own
`ErrorSignature`, and therefore its own potential reproduction target.

## 1. Parser layer

Two adapters, one canonical output (SPEC §2.2).

**`parsers/woo-ssr`** parses the plain-text "Copy for support" export. Format
confirmed against WooCommerce's own report generator: `### Section ###`
headings, `Label: Value` rows, and continuation lines for multi-value rows.
Tolerates code fences, CRLF, irregular whitespace, reordered rows, unknown
fields and unknown sections. Detail in [`parser-woo-ssr.md`](parser-woo-ssr.md).

**`parsers/debug-log`** parses a PHP fatal into an `ErrorSignature`. It also
**attributes ownership** — plugin, theme, core or unknown — because ownership is
a parsing question, not a diagnostic one. A plugin directory becomes a slug only
when the bundled catalog mediates it; an unmediated directory yields `low`
confidence and no slug, so a name is never guessed into an identity.

Neither adapter touches the network. Slug resolution is catalog-only, by design
(SPEC §3).

## 2. Environment IR

`Environment` is the canonical representation. Every scalar is a `Field<T>` with
exactly three states:

- `known` — read from the artifact, carrying evidence
- `inferred` — derived by a documented deterministic rule, carrying the basis
- `missing` — absent, carrying **no value at all**

There is no fourth state and no defaults table. `Field` has no constructor that
accepts a fallback.

Also carried: `provenance.artifacts` (which adapters actually ran),
`provenance.warnings` (how well the artifact could be read — quality signals,
never diagnoses), `plugins[]` with a `kind` of `active | inactive | must-use |
dropin`, and `signatures[]`.

**Every important parsed value carries `Evidence`**: the artifact id, the
adapter, a 1-based line number relative to the original input, and the verbatim
excerpt. A property test asserts, across every fixture, that the line at
`locator.line` equals the excerpt. That is what makes the UI able to link a
finding back to the customer's own text.

## 3. Signature model

`ErrorSignature` holds `errorClass`, `message`, `file`, `line`, `frames`, an
`owner` with a confidence, and its own evidence. An Environment carries **zero
or more**, in extraction order; each usable one is an independent reproduction
target.

"Usable" is defined by the spec (§6.1) and implemented literally: a parsed file
path, a frame with a file path, or an identified owner. Anything else cannot
drive a target.

## 4. Diagnostic rule engine

Rules are **data** (`rules/definitions.json`): id, title, severity, confidence,
required fields, remediation, citations, reproducibility impact. Only the
matching predicate is code (`rules/matchers.ts`), named by the definition. A
test asserts the two sets correspond exactly.

Two gates are enforced centrally in the engine, not per rule:

1. a match with **no evidence** is discarded;
2. a match with **no citation** is discarded.

Severity and confidence are independent axes. A matcher may only *lower* the
declared confidence — for example a plugin-owned fatal drops from `high` to
`low` when the directory is not in the catalog, while severity stays
`critical`: the site is equally broken, we are just less sure what broke it.

Version requirements come from `rules/requirements.json`, keyed by **exact**
plugin version, each carrying the URL of the version's own `readme.txt`. A
version absent from the table makes the rule `not_applicable` rather than
extrapolating. WooCommerce's published *recommendations* are deliberately not
used to claim an incompatibility.

When required fields are missing, a rule does not evaluate and does not emit. Its
unmet requirements are unioned, deduplicated and returned as an
`InformationRequest` (SPEC §10) — **not** a Finding.

## 5. Reproducibility planner

```text
Environment + ErrorSignatures
   → relevance   which reported components this signature implicates
   → targets     one per usable signature, independent of each other
   → triggers    the executable action, or none
   → ReproPlan   tier, reasons, substitutions, omissions
   → Blueprint   Playground v2, versions pinned
```

`repro/plan.ts` reads the `Environment`, its signatures, and
`repro/capabilities.json` — a data file where every Playground capability
records how it was verified. It reads nothing else.

Per target it derives a trigger (§8.1 mapping), assesses a tier, and records
reasons. Per plan it records substitutions and omissions. Tier assignment is
**not** worst-tier-wins: a target is constrained only by components **its own**
signature implicates, so a blocked theme target does not downgrade an unrelated
plugin target. The plan verdict summarises the most reproducible target without
overwriting the others.

Components are handled by `kind`: a must-use plugin is never installed as an
ordinary plugin, and a drop-in is never converted into one.

## 6. Blueprint generator

Emits Blueprint **v2**, validated against the published schema in tests. Only
properties present in that schema are used. Plugin references pin the reported
version as `slug@version`, which Phase 4.5 verified installs exactly on both
surfaces.

Every difference Playground forces — SQLite for MySQL, a coarser PHP version,
debug logging enabled to capture evidence — is recorded as an explicit
substitution. Nothing is silently defaulted.

## 7. Execution

```
execute/log-evidence.ts   pure: split entries, diff, extract, compare
execute/core.ts           surface-agnostic orchestration
execute/cli-runner.ts     boots via runCLI
execute/browser-runner.ts boots via startPlaygroundWeb
```

**The CLI and browser runners share one core**, so the two surfaces cannot drift
in semantics. Sharing code is not the same as assuming they behave alike: parity
is *measured* — the same plan executed on both surfaces gives 0 divergences
across 9 compared fields.

Installed state is read out of WordPress (`get_plugins()`,
`get_option('active_plugins')`), never taken from the Blueprint, because a zero
exit code proves nothing.

Reproduction is established only by **diffing `debug.log` around the trigger**:
snapshot, execute, snapshot, diff whole entries, extract with a fixed pattern,
compare against the reported signature. Entries present before the trigger ran
are never evidence — which is what stops a boot-time error being sold as a
reproduction.

## 8. Verification model

```ts
Verification {
  environment: { bootSucceeded, installedComponents, failedComponents }   // once
  failureReproduction: { targets: TargetVerification[] }                  // per target
}
```

`observed` is true only when the trigger actually ran **and** what it produced
matches what was reported. It is never inferred from a successful boot, a
matching environment, or another target's outcome.

No Playground surface exposes structured PHP error data — `originalErrorClassName`
is the JS wrapper name, and HTTP status is 200 on a CLI fatal. So `errorClass`
and `message` are always extraction results, and each target records the
extraction source and whether it was deterministic.

## 9. UI

Vanilla TypeScript and DOM. `ui/analyze.ts` composes the pipeline — the only
logic of its own is the deterministic format detection and multi-fatal splitting
described in §0, never parsing, diagnosis or planning. `ui/state.ts` is an
explicit state machine; `ui/render.ts` is presentation only and adds labels, never
conclusions; `ui/outcome.ts` holds the four mutually exclusive verification
outcomes, with a failed boot outranking every other.

The browser executor is injected into `mountApp`, so UI tests run without a real
Playground while production imports the same module. There is no second
implementation of anything.

## 10. The firewall

```text
                 Environment + ErrorSignatures
                   │                       │
                   ▼                       ▼
              Diagnostics              Reproduction
            Findings, severity,       relevance, targets,
            confidence, citations    triggers, Blueprint
                   │                       ▲
                   └──────── ✗ ────────────┘
                        never read by
```

`ReproPlan` may read the `Environment` and its `ErrorSignature`s. It may never
read a `Finding`, diagnostic rules, severity, confidence, remediation, or any
AI-generated conclusion (SPEC §7). Both layers hang off the same IR; neither is
downstream of the other.

Enforced three ways in `tests/repro-firewall.test.ts`:

1. **No import edge** — no file under `src/repro/` imports `rules/`,
   `types/finding`, `types/diagnosis` or `types/rule`.
2. **No identifier** — with comments stripped, no file may contain `Finding`,
   `diagnose(`, `severity`, `confidence`, `reproducibilityImpact` or
   `citations`. This catches reading a conclusion through a structural type or
   `any`, which an import check alone would miss.
3. **No leakage** — the serialised plan contains none of those keys.

## Determinism

Parsing, diagnosis and planning are pure: no network, no clock, no randomness,
no model. Rules run in id order; matches keep source order; plugins keep report
order; signatures keep extraction order. Every fixture is parsed, diagnosed and
planned twice in tests and compared.

Only execution touches the outside world, and only to download WordPress core
and plugins.
