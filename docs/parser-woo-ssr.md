# WooCommerce System Status Report parser

Phase 1. Implements the System Status adapter from `docs/SPEC.md` §2.2 and
produces the canonical `Environment` IR from §4.

```ts
import { parseSystemStatusReport } from "./src/parsers/woo-ssr/parse.js";

const environment = parseSystemStatusReport({
  artifactId: "ticket-4417-ssr",
  text: rawReportText,
});
```

The parser is a pure function. No network, no filesystem, no clock, no
randomness: the same input always produces the same `Environment`. This is
asserted by a test that parses every fixture twice and compares.

---

## Accepted input

The plain-text **"Copy for support"** export from
**WooCommerce → Status → Get system report**. The format is confirmed against
WooCommerce's own report generator:

- sections are emitted as `### Section Name ###`
- rows are emitted as `Label: Value`
- a row holding several values is expanded across following lines, which carry
  no label of their own

Tolerated variations, each covered by a fixture:

| Variation | Handling |
| --- | --- |
| Wrapped in a Markdown code fence (`` ` ``) | Leading/trailing fence lines stripped; line numbers still refer to the original input |
| CRLF line endings | Normalised |
| Irregular whitespace around the colon | Trimmed; internal runs collapsed |
| Rows in any order within a section | Lookup is by label, not position |
| Unknown labels and entire unknown sections | Ignored without error |
| Missing sections | Corresponding fields become `missing` |
| Label casing differences across WooCommerce versions (`Child theme` vs `Child Theme`) | Matched case-insensitively |
| Plugin names containing a colon (`Akismet Anti-spam: Spam Protection`) | Split on the last `: by `, so the name stays intact |
| `(update to version X is available)` suffixes | Stripped from the version |
| `✔` / `❌` / HTML entity equivalents | Stripped from values; read as booleans where the field is boolean |

The HTML table rendering of the status page is **not** accepted. Only the
plain-text export is parsed.

---

## Normalised output

| `Environment` path | Source row | Notes |
| --- | --- | --- |
| `wordPress.version` | `WP Version` | |
| `wooCommerce.version` | `WC Version` | |
| `wooCommerce.databaseVersion` | `WC Database Version` | May legitimately differ from `wooCommerce.version` |
| `wooCommerce.templateOverrides` | `Overrides` | See below |
| `server.phpVersion` | `PHP Version` | |
| `server.memoryLimit` | `PHP Memory Limit`, else `WP Memory Limit` | Verbatim string (`"512 MB"`), never converted to bytes |
| `server.webServer` | `Server Info` | Verbatim (`"nginx/1.18.0"`) |
| `database.version` | `MySQL Version` | Verbatim, including composite strings like `5.5.5-10.6.16-MariaDB` |
| `database.engine` | derived | Always `inferred`, never `known` — see below |
| `theme.name` / `theme.version` | Theme `Name` / `Version` | |
| `theme.isChildTheme` | `Child theme` | Boolean |
| `theme.parentName` / `theme.parentVersion` | `Parent theme name` / `Parent theme version` | `missing` when not a child theme |
| `plugins[]` | Active/Inactive Plugins sections | `active: true` / `active: false` respectively |
| `provenance.artifacts` | — | Records the `artifactId` and `"woo-ssr"` adapter |

Versions and sizes are preserved **verbatim**. The parser does not normalise
`512 MB` to bytes, does not coerce `21.7` to `21.7.0`, and does not reorder
plugins. Interpretation belongs to later phases; changing the value here would
destroy the correspondence with the evidence excerpt.

### Database engine

WooCommerce labels the row `MySQL Version` whatever the engine actually is. The
engine is therefore **derived, not read**, and is always marked `inferred` with
its `inferenceBasis` recorded:

- value contains `MariaDB` → `MariaDB`
- otherwise → `MySQL`, basis *"reported under the 'MySQL Version' label with no
  MariaDB marker in the value"*

It is never `known`, because the report never states it directly.

### Template overrides

Each entry under `Overrides` becomes a `TemplateOverride`. `outdated` is true
**only** when the report itself says so:

```
woocommerce/cart/cart.php version 3.8.0 is out of date. The core version is 7.9.0
```

yields `{ file, version: "3.8.0", coreVersion: "7.9.0", outdated: true }`. A bare
path yields `outdated: false` with no `version`. The parser never compares
versions itself to decide staleness — that is a diagnostic judgment, and Phase 1
does not make diagnostic judgments.

---

## Missing-value behaviour

Every scalar is a `Field<T>` with exactly one of three states (`docs/SPEC.md`
§4.2):

- **`known`** — read directly from a row. Carries evidence.
- **`inferred`** — derived by a documented deterministic rule. Carries the
  evidence for its inputs plus an `inferenceBasis`. Currently only
  `database.engine`.
- **`missing`** — absent. Carries **no** `value` field at all.

A value is `missing` when the section is absent, the row is absent, or the value
is one of WooCommerce's placeholders for "nothing" (`–`, `—`, `-`, `&#8211;`,
`❌`). This matters: `Overrides: –` means *no overrides*, and is parsed as an
empty list rather than as an override named `–`.

There is no fourth state. The parser has no defaults table, and there is no
constructor that accepts a fallback value. If a report omits the PHP version,
`server.phpVersion.status` is `"missing"` and `.value` is `undefined` —
it never becomes `"unknown"`, `"8.0"`, or `""`.

Absent list-valued fields become `[]`, which means *the report showed none*. A
report that omits the Templates section entirely and one that says
`Overrides: –` are not currently distinguishable at the list level; see
limitations.

---

## Evidence and provenance

Every `known` and `inferred` field carries `Evidence`:

```json
{
  "artifactId": "01-storefront-baseline",
  "adapter": "woo-ssr",
  "locator": { "section": "Server Environment", "line": 20 },
  "excerpt": "PHP Version: 8.1.27"
}
```

- `line` is **1-based and relative to the original input**, including any code
  fence that was stripped.
- `excerpt` is the verbatim source line. It is never normalised or summarised,
  so a later `Finding` can quote the customer's own text back.
- Each entry in `plugins[]` and `templateOverrides[]` carries its own evidence
  pointing at its specific row.

A test enforces this across every fixture: for each evidence record, the line at
`locator.line` in the source file must equal the `excerpt`. A citation that does
not point at what it claims fails the suite.

---

## Plugin slug resolution

Resolution goes through the bundled catalog at
`src/catalog/plugin-catalog.json` and nowhere else. **There is no network path
in this module and there must never be one** (`docs/SPEC.md` §3).

The catalog is keyed by **`(display name, author)`**, not by name alone, because
display names collide across authors and a name-only match would silently
install the wrong plugin. Matching is case- and whitespace-insensitive, and
tolerates trailing punctuation on the author.

| Case | Result |
| --- | --- |
| `(name, author)` in catalog as `wordpress.org` | `slug` set, `source: "wordpress.org"` |
| `(name, author)` in catalog as `premium` | no `slug`, `source: "premium"` |
| Not in catalog | no `slug`, `source: "unknown"` |
| Author absent from the row | no `slug`, `source: "unknown"` — never matched on name alone |

An unresolved plugin keeps its name, version, and author. It is not dropped: a
later phase needs it in order to record an explicit omission rather than
silently pretending the environment had one fewer plugin.

The catalog is a hand-curated seed (20 entries). It is deliberately small and is
extended by hand.

---

## Known limitations

1. **Must Use and Dropin plugins are not parsed.** Real reports contain
   `### Must Use Plugins ###` and `### Dropin Plugins ###`. These plugins *are*
   loaded at runtime, so omitting them understates the environment. Not in the
   Phase 1 field list; needs its own fixture before it is added.
2. **An absent Templates section and an explicit "no overrides" both produce
   `[]`.** The distinction is representable — the list could become a `Field` —
   but is not currently made.
3. **Localised reports are not handled.** Labels are matched in English. A
   report generated in another admin language will parse as mostly `missing`,
   silently. There is no fixture for this yet and no warning is emitted.
4. **A plugin row with no `: by ` and no leading version yields a name only.**
   Version and author become `undefined` rather than producing a wrong value.
5. **The catalog covers 20 plugins.** Realistic reports will resolve only
   partially. This is by design — an unresolved plugin is a correct answer, not
   a failure — but it means slug coverage is low until the catalog grows.
6. **No cross-field validation.** If a report declares `Active Plugins (6)` but
   lists five rows, the parser records five and says nothing. The test suite
   checks header counts against parsed counts for the fixtures, but the parser
   itself does not surface the discrepancy.
7. **Section detection is positional by name.** A future WooCommerce release
   that renames a section heading will cause those fields to become `missing`
   rather than raising an error.
