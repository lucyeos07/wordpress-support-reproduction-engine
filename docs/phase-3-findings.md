# Phase 3 findings

Deterministic diagnostic rules. No reproduction planner, Blueprint generator,
Playground integration or UI was built.

Date: 2026-09-12. 4 rules, 19 fixtures, 207 tests, typecheck clean, CI green.

---

## 1. A blocking dependency, resolved

Rules 1 and 2 read `Signature`. **Nothing populated it.** Phase 1 was scoped to
"the WooCommerce System Status parser and nothing beyond it", so the debug-log
adapter that `docs/SPEC.md` §2.1 lists as the second MVP input had never been
built. `Environment.signature` existed as a type and was always `undefined`.

Without it, the two ownership rules could only have been tested against
hand-constructed Environments — which would have proved the rules ran, not that
they ran on anything real, and the phase instruction requires a positive
*fixture* per rule.

So Phase 3 also built the minimal debug-log adapter:
`src/parsers/debug-log/parse.ts`, six log fixtures, 27 tests. This is scope
beyond "diagnostic rules", and it is flagged rather than buried. It was the
smallest thing that made rules 1 and 2 honest.

---

## 2. Rules implemented

| Rule | Severity | Confidence | Positive case | Negative cases |
| --- | --- | --- | --- | --- |
| `FATAL_PLUGIN_OWNER` | critical | high / low | plugin-fatal | theme-fatal, core-fatal, no-signature |
| `FATAL_THEME_OWNER` | critical | medium | theme-fatal | plugin-fatal, theme named but no fatal |
| `PHP_BELOW_PLUGIN_REQUIREMENT` | high | high | php-below-requirement | php-satisfies-requirement, unrecorded version |
| `OUTDATED_TEMPLATE_OVERRIDE` | medium | high | outdated-templates | current override, no overrides, no Templates section |

Full documentation in `docs/rules.md`.

---

## 3. Rules deferred, and why

### Inactive plugin identified as a required dependency — **not implemented**

The IR has no way to represent a declared dependency. A System Status Report
does not list plugin dependencies; WordPress's `Requires Plugins` header is not
in the report, and nothing else in `Environment` states that plugin A needs
plugin B.

The only route would have been to infer it — for example, seeing
`Call to undefined function WC()` in a signature and concluding WooCommerce is a
required dependency that is inactive. That is an inference from a symptom, not
an explicit identification by the evidence, and the phase instruction asks for
the latter. Building a function-name-to-plugin mapping would have meant
inventing exactly the kind of table the instruction warns against.

**To implement it safely, the IR needs a representation of declared
dependencies, and the parser needs a source that states them.** Neither exists
yet.

### WooCommerce version mismatch, memory-limit, WP/plugin compatibility — not attempted

`docs/SPEC.md` §5.3 lists these as candidates. Each needs authoritative
thresholds that the current corpus cannot supply without guessing. Memory-limit
in particular is tempting and dangerous: WooCommerce *recommends* 256 MB, but a
site running 128 MB is not thereby broken, and emitting a `critical` finding
from a recommendation would be the same error described below.

---

## 4. The most important thing found this phase

**WooCommerce's "Server Recommendations" page states "PHP version 8.3 or greater".**

Read quickly, that is a ready-made compatibility rule: flag every site below PHP
8.3. It would have fired on most of the fixture corpus and looked productive.

It is wrong. Those are *recommendations*, not minimums. WooCommerce 9.1.2 runs
perfectly on PHP 7.4 — its own `readme.txt` says
`Requires PHP: 7.4`. A rule built on the recommendation would have reported a
high-severity incompatibility for a site that has none, with an authoritative
citation attached to make it look credible.

The rule instead uses each version's own `Requires PHP` header, fetched from
that version's `readme.txt` in the WordPress.org repository and recorded with
its exact URL. The requirements are keyed by **exact plugin version**, because
they change between releases:

| WooCommerce | Requires PHP |
| --- | --- |
| 6.4.1 | 7.0 |
| 7.2.3 | 7.2 |
| 7.9.0 | 7.3 |
| 8.2.1 | 7.4 |
| 9.1.2 | 7.4 |

A version not in the table yields `not_applicable` with a stated reason. It is
never extrapolated from a neighbour.

The general recommendations page is still cited, for context — but the thing the
rule actually tests against is the plugin's own declaration.

---

## 5. Example transformations

### Environment → Finding

```
PHP Version: 7.3.33        (fixture 13, line 14)
WC Version: 9.1.2          (fixture 13, line 6)
```

```json
{
  "ruleId": "PHP_BELOW_PLUGIN_REQUIREMENT",
  "title": "PHP version is below the plugin's declared minimum: WooCommerce 9.1.2 requires PHP >= 7.4",
  "severity": "high",
  "confidence": "high",
  "evidence": [
    { "excerpt": "PHP Version: 7.3.33", "locator": { "section": "Server Environment", "line": 14 } },
    { "excerpt": "WC Version: 9.1.2",   "locator": { "section": "WordPress Environment", "line": 6 } }
  ],
  "cause": "… \n\nReported PHP version: 7.3.33\nRequired PHP version: >= 7.4\nInstalled WooCommerce version: 9.1.2",
  "citations": [
    { "title": "WooCommerce Server Recommendations", "url": "https://woocommerce.com/document/server-requirements/" },
    { "title": "WooCommerce 9.1.2 readme.txt — \"Requires PHP\" header",
      "url": "https://plugins.svn.wordpress.org/woocommerce/tags/9.1.2/readme.txt" }
  ],
  "reproducibilityImpact": "Reproducible in Playground when the reported PHP version is one Playground offers…"
}
```

### Signature → Finding, and the same rule declining

```
[11-Sep-2026 08:14:22 UTC] PHP Fatal error:  Uncaught Error: Call to undefined method
WC_Cart::get_totals_for_display() in /var/www/html/wp-content/plugins/woocommerce/includes/wc-cart-functions.php:412
```

→ `FATAL_PLUGIN_OWNER`, `critical`, **confidence `high`**, title carries the
slug `woocommerce`, because the directory resolved through the catalog.

```
… in /var/www/html/wp-content/plugins/warehouse-sync-bridge/src/bootstrap.php:57
```

→ same rule, same `critical` severity, but **confidence `low`** and **no slug**.
The directory is not in the catalog, so it may not be the plugin it appears to
be. Severity does not move: the site is equally broken; we are less sure what
broke it.

### Nothing → information request

Fixture 04 has no Server Environment section and no log:

```json
{
  "missingFields": ["server.phpVersion", "signature.evidence", "signature.owner.type", "wooCommerce.templateOverrides"],
  "requestedBy": [{ "ruleId": "PHP_BELOW_PLUGIN_REQUIREMENT", "missing": ["server.phpVersion"] }, …]
}
```

Zero Findings. Four rules declining, each naming what it would have needed.

---

## 6. Weaknesses found in the Environment IR

1. **`ErrorSignature` had no evidence field.** `docs/SPEC.md` §4.5 lists
   `errorClass`, `message`, `file`, `line`, `frames`, `owner` — and no evidence.
   But §4.3 requires every important parsed value to be traceable, and a Finding
   derived from a signature cannot cite anything without it. Added
   `evidence?: Evidence[]` as an optional field; the specified fields are
   untouched. **This is a genuine gap in the spec's interface, not just in the
   implementation.**

2. **Naming discrepancy.** The Phase 3 instruction says a Finding must contain
   `reproImpact`. `docs/SPEC.md` §5.1 defines the field as
   `reproducibilityImpact`. The spec is an authored constraint I was told not to
   modify, so the spec's name was kept. **If `reproImpact` was intended, the
   spec needs the change, not the code.**

3. **No representation of declared dependencies**, which is what blocks the
   dependency rule entirely (§3).

4. **One signature per Environment.** `Environment.signature` is singular. Real
   debug logs routinely contain several distinct fatals, and support tickets
   often turn on which came first. The IR cannot currently hold more than one.

5. **Merging two adapters is unspecified.** §2.2 says both adapters produce the
   same canonical IR, but nothing says how to combine an SSR-derived Environment
   with a log-derived one when both populate the same field. Phase 3 needed only
   "SSR environment + log signature", so `attachSignature` does exactly that and
   nothing more, rather than inventing a conflict-resolution policy with no case
   to justify it.

6. **No link from a signature back to the plugin list.** A signature resolving
   to slug `woocommerce` and a `Plugin` entry with slug `woocommerce` are not
   connected. Nothing currently checks that the plugin blamed by a fatal is even
   installed, let alone active. Phase 4 will want that.

---

## 7. A deviation to flag

The instruction said to "continue using YAML or the existing rule representation
from the specification". There was no existing representation — `docs/SPEC.md`
defines the `Finding` shape but no rule format — and no YAML anywhere in the
project.

Rules are therefore declarative **JSON** (`src/rules/definitions.json`), matching
the existing pattern used by the plugin catalog. This avoids adding a YAML
parser and a build step for a browser-first product where the rule corpus has to
load in the browser too. Converting to YAML later is a loader change, not a
restructuring. **Flagged for review in case YAML was a firm requirement.**

---

## 8. Test count

| Suite | Tests |
| --- | --- |
| `rules.test.ts` | 92 |
| `woo-ssr-parser.test.ts` | 82 |
| `debug-log-parser.test.ts` | 27 |
| `blueprint-schema.test.ts` | 6 |
| **Total** | **207** |

Invariants asserted across every case: every Finding carries evidence; every
evidence excerpt appears verbatim at the line it cites in the original artifact;
every Finding carries at least one citation whose host is on an authoritative
allowlist and whose `retrievedAt` is a real ISO date; diagnosis is deterministic;
no Finding is emitted by a rule that reported insufficient evidence; parser
warnings never become Findings.
