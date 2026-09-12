# Diagnostic rules

Phase 3. Implements the deterministic diagnostic layer from `docs/SPEC.md` §5
and the insufficient-evidence path from §10.

```ts
import { diagnose } from "./src/rules/engine.js";

const { findings, evaluations, informationRequest } = diagnose(environment);
```

The engine reads **only** the parsed `Environment` (and the `Signature` inside
it). It never re-parses raw artifact text, never calls the network, never
consults a model, and has no clock or randomness. Rules run in rule-id order and
matches keep source order, so the same `Environment` always produces
byte-identical output.

---

## How a rule is defined

Rules are declarative. Everything a reviewer needs to audit one — severity,
confidence, required fields, remediation, citations, reproducibility impact —
is data in `src/rules/definitions.json`. Only the matching predicate is code, in
`src/rules/matchers.ts`, named by the definition's `matcher` id.

Predicates stayed in code because expressing version comparison and ownership
checks as data would mean inventing a small language for four rules. A test
asserts the set of declared matcher ids and the set of implemented matchers are
identical, so the two halves cannot drift apart.

---

## The two hard gates

Enforced centrally in `engine.ts`, not left to each rule:

1. **No evidence, no Finding.** A match with an empty evidence array is
   discarded.
2. **No citation, no Finding.** A match whose rule and instance citations are
   both empty is discarded.

A rule cannot opt out. Tests assert both across every case, and additionally
that every evidence excerpt appears verbatim at the line it cites in the
original artifact.

---

## Confidence semantics

Severity and confidence are independent axes. Confidence is **never** computed
from severity, and a matcher may only **lower** the rule's declared confidence,
never raise it.

| Confidence | Meaning |
| --- | --- |
| `high` | The artifact states the fact directly, or an identifier was resolved through the bundled catalog. Reading it wrong would require the report itself to be wrong. |
| `medium` | The fact is directly stated, but the entity it is attributed to is identified by convention rather than by a mediated lookup. |
| `low` | The attribution rests on an unmediated string — typically a directory name that is not in the catalog and therefore may not be the plugin it appears to be. |

`FATAL_PLUGIN_OWNER` is declared `high` but is emitted at `low` whenever the
plugin directory is not in the catalog. The severity stays `critical` either
way: the site is still broken, we are simply less sure which plugin broke it.

---

## Rules

### `FATAL_PLUGIN_OWNER` — Fatal error originates in a plugin

| | |
| --- | --- |
| **Detects** | A reported fatal whose throwing file is under `wp-content/plugins/`. |
| **Requires** | `signature.owner.type`, `signature.evidence` |
| **Evidence** | The verbatim `PHP Fatal error:` line from the debug log. |
| **Severity** | `critical` |
| **Confidence** | `high` when the directory resolves through the catalog; `low` when it does not |
| **Citation** | [Debugging in WordPress – Advanced Administration Handbook](https://developer.wordpress.org/advanced-administration/debug/debug-wordpress/) |

Ownership is **read**, never derived here. The debug-log adapter attributes it
(`docs/SPEC.md` §4.5); the rule only checks `owner.type === "plugin"`. This
matters because a diagnostic rule guessing ownership is exactly the failure the
reproduction firewall exists to prevent.

The rule emits nothing when the signature has no evidence, so an uncited
signature can never become a cited Finding.

### `FATAL_THEME_OWNER` — Fatal error originates in a theme

| | |
| --- | --- |
| **Detects** | A reported fatal whose throwing file is under `wp-content/themes/`. |
| **Requires** | `signature.owner.type`, `signature.evidence` |
| **Evidence** | The verbatim `PHP Fatal error:` line. |
| **Severity** | `critical` |
| **Confidence** | `medium` |
| **Citation** | [Debugging – Theme Handbook](https://developer.wordpress.org/themes/advanced-topics/debugging/) |

Capped at `medium` because theme directories are not mediated by the plugin
catalog. The theme is identified by path only and never receives a slug.

### `PHP_BELOW_PLUGIN_REQUIREMENT` — PHP below the plugin's declared minimum

| | |
| --- | --- |
| **Detects** | Reported PHP version lower than the installed WooCommerce version's own `Requires PHP` header. |
| **Requires** | `server.phpVersion`, `wooCommerce.version` |
| **Evidence** | The parsed `PHP Version:` row and the parsed `WC Version:` row. |
| **Severity** | `high` |
| **Confidence** | `high` |
| **Citation** | [WooCommerce Server Recommendations](https://woocommerce.com/document/server-requirements/), plus the exact version's `readme.txt` |

The requirement comes from `src/rules/requirements.json`, keyed by **exact
plugin version**. Each entry records the `Requires PHP` header read from that
version's own `readme.txt` in the WordPress.org repository — the plugin's own
declaration of its minimum.

**Keyed exactly on purpose.** Requirements change between releases: WooCommerce
6.4.1 declares PHP 7.0, 7.9.0 declares 7.3, 8.2.1 declares 7.4. Applying one
version's requirement to another would be inventing a requirement. A version
absent from the table makes the rule `not_applicable` with a stated reason — it
never guesses.

> **WooCommerce's "Server Recommendations" page states PHP 8.3 or greater.
> Those are recommendations, not minimums, and are deliberately not used to
> claim an incompatibility.** Running PHP 8.1 is below the recommendation but
> perfectly compatible. The general page is cited for context; the version's
> `readme.txt` is what the rule actually tests against.

Version comparison is numeric per dot-segment, so `7.4.3` satisfies `>= 7.2` and
`7.3.33` does not satisfy `>= 7.4`. String comparison would get both wrong.

### `OUTDATED_TEMPLATE_OVERRIDE` — WooCommerce template override is out of date

| | |
| --- | --- |
| **Detects** | A template override the **report itself** marks as out of date. |
| **Requires** | `wooCommerce.templateOverrides` |
| **Evidence** | The verbatim override line, e.g. `woocommerce/cart/cart.php version 3.8.0 is out of date. The core version is 7.9.0` |
| **Severity** | `medium` |
| **Confidence** | `high` |
| **Citations** | [Template structure & Overriding templates via a theme](https://developer.woocommerce.com/docs/theming/theme-development/template-structure), [Fixing Outdated WooCommerce Templates](https://developer.woocommerce.com/docs/theming/theme-development/fixing-outdated-woocommerce-templates) |

Emits one Finding per outdated override. Confidence is `high` because the
assertion is the report's own, not ours: the parser sets `outdated` only where
WooCommerce printed "is out of date", and **no version comparison happens
anywhere in this rule**. An override the report lists without that phrase
produces nothing.

---

## Insufficient evidence is not a Finding

When a rule's `requires` fields are absent it does not evaluate and does not
emit anything. It records `outcome: "insufficient_evidence"` with the fields it
needed.

Those unmet requirements are then unioned across all declining rules, filtered
against what the Environment already has, deduplicated and sorted into
`informationRequest.missingFields` — the procedure in `docs/SPEC.md` §10. For a
report with no Server Environment section and no log:

```json
{
  "missingFields": [
    "server.phpVersion",
    "signature.evidence",
    "signature.owner.type",
    "wooCommerce.templateOverrides"
  ],
  "requestedBy": [
    { "ruleId": "FATAL_PLUGIN_OWNER", "missing": ["signature.owner.type", "signature.evidence"] }
  ]
}
```

`not_applicable` is a separate outcome, for a rule that *could* evaluate but has
no sourced basis to judge — currently only a WooCommerce version missing from
the requirements corpus. That is not something the reporter can supply, so it is
deliberately kept out of the information request.

Parser warnings never become Findings. They describe how well the artifact was
read; a Finding describes the site. A test asserts the separation.

---

## Limitations

1. **Four rules.** `docs/SPEC.md` §5.3 anticipates five to eight. The rules not
   built and why are in `docs/phase-3-findings.md`; none was omitted for effort.
2. **The requirements corpus covers 11 WooCommerce versions**, the ones the
   fixture corpus uses. Any other version yields `not_applicable`. Growing it
   means fetching that version's `readme.txt` and recording it with its
   citation — by hand, never at runtime.
3. **Only WooCommerce has recorded requirements.** The rule is written against
   any slug but the corpus holds one plugin.
4. **One signature per Environment.** A log containing several distinct fatals
   yields only the first. Real support logs often contain many.
5. **Ownership stops at the throwing file.** A fatal thrown inside WooCommerce
   but *caused* by another plugin's hook is attributed to WooCommerce. The stack
   frames are parsed and retained, but no rule reads them yet.
6. **No cross-artifact correlation.** Nothing checks that the plugin named in a
   signature also appears in the System Status Report, or that it was active.
