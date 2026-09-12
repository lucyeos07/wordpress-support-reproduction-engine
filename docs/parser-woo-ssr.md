# WooCommerce System Status Report parser

Implements the System Status adapter from `docs/SPEC.md` §2.2 and produces the
canonical `Environment` IR from §4. Phase 1 built it; Phase 2 hardened it.

```ts
import { parseSystemStatusReport } from "./src/parsers/woo-ssr/parse.js";

const environment = parseSystemStatusReport({
  artifactId: "ticket-4417-ssr",
  text: rawReportText,
});
```

The parser is a pure function. No network, no filesystem, no clock, no
randomness: the same input always produces the same `Environment`. A test parses
every fixture twice and compares.

---

## Accepted input

The plain-text **"Copy for support"** export from
**WooCommerce → Status → Get system report**. The format is confirmed against
WooCommerce's own report generator and status report view:

- sections are emitted as `### Section Name ###`
- rows are emitted as `Label: Value`
- a row holding several values is expanded across following lines, which carry
  no label of their own

Tolerated variations, each covered by a fixture:

| Variation | Handling |
| --- | --- |
| Wrapped in a Markdown code fence | Leading and trailing fence lines stripped, including a fence followed by a trailing newline; line numbers still refer to the original input |
| CRLF line endings | Normalised |
| Irregular whitespace around the colon | Trimmed; internal runs collapsed |
| Rows in any order within a section | Lookup is by label, not position |
| Unknown labels and entire unknown sections | Ignored without error |
| Missing sections | Corresponding fields become `missing` |
| Label casing differences across WooCommerce versions | Matched case-insensitively |
| Plugin names containing a colon (`Akismet Anti-spam: Spam Protection`) | Split on the last `: by `, so the name stays intact |
| Must-use plugin with no author (`by  – 1.7.2`) | Version captured, author left undefined |
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
| `wooCommerce.templateOverrides` | `Overrides` | `Field<TemplateOverride[]>` — see below |
| `server.phpVersion` | `PHP Version` | |
| `server.memoryLimit` | `PHP Memory Limit`, else `WP Memory Limit` | Verbatim string (`"512 MB"`), never converted to bytes |
| `server.webServer` | `Server Info` | Verbatim (`"nginx/1.18.0"`) |
| `database.version` | `MySQL Version` | Verbatim, including composite strings like `5.5.5-10.6.16-MariaDB` |
| `database.engine` | derived | Always `inferred`, never `known` |
| `theme.name` / `theme.version` | Theme `Name` / `Version` | |
| `theme.isChildTheme` | `Child theme` | Boolean |
| `theme.parentName` / `theme.parentVersion` | `Parent theme name` / `Parent theme version` | `missing` when not a child theme |
| `plugins[]` | four plugin sections | Each carries a `kind` — see below |
| `provenance.artifacts` | — | The `artifactId` and `"woo-ssr"` adapter |
| `provenance.warnings` | — | Parser quality signals — see below |

Versions and sizes are preserved **verbatim**. The parser does not normalise
`512 MB` to bytes, does not coerce `21.7` to `21.7.0`, and does not reorder
plugins. Interpretation belongs to later phases; changing the value here would
destroy the correspondence with the evidence excerpt.

### Plugin kinds

WooCommerce reports four distinct categories, and they are **not** collapsed
into one list of "plugins". Each entry carries `kind`:

| `kind` | Source section | Row shape | `active` |
| --- | --- | --- | --- |
| `active` | `Active Plugins (n)` | `Name: by Author – Version` | `true` |
| `inactive` | `Inactive Plugins (n)` | `Name: by Author – Version` | `false` |
| `must-use` | `Must Use Plugins (n)` | `Name: by Author – Version` | `undefined` |
| `dropin` | `Dropin Plugins (n)` | `file.php: Description` | `undefined` |

The distinction matters because must-use plugins and drop-ins are always loaded
and cannot be deactivated from the admin. Calling them "active" would imply
they could be switched off; calling them "inactive" would be false.

`active` is set **only** for the two sections where the report actually states
it. Must-use plugins and drop-ins leave it `undefined` rather than claiming a
value the source never gave. Consumers that want "everything loaded at runtime"
should select on `kind`, not on `active`.

Drop-in rows are `file.php: Description`, where the left side is the drop-in
file and the right is WordPress's description of it. They carry no author or
version, so they deliberately do not go through the plugin row parser. `name` is
the file (`object-cache.php`). The description is not modelled — it is preserved
verbatim in the evidence excerpt.

### Template overrides

`wooCommerce.templateOverrides` is a `Field<TemplateOverride[]>`, not a bare
array, so three different situations stay distinguishable:

| Report | Result |
| --- | --- |
| No `### Templates ###` section | `status: "missing"` |
| `Overrides: –` | `status: "known"`, `value: []`, evidenced by that line |
| `Overrides: <paths>` | `status: "known"`, `value: [...]` |
| Templates section with no `Overrides` row | `status: "missing"` + `section_incomplete` warning |

Only the second case is evidence that the site overrides nothing. The first is
evidence of nothing at all. Collapsing both to `[]` would let a later phase
conclude "no template overrides" from a report that never mentioned templates.

`outdated` is true **only** when the report itself says so:

```
woocommerce/cart/cart.php version 3.8.0 is out of date. The core version is 7.9.0
```

yields `{ file, version: "3.8.0", coreVersion: "7.9.0", outdated: true }`. A bare
path yields `outdated: false` with no `version`. The parser never compares
versions itself to decide staleness — that is a diagnostic judgment, and this
parser makes none.

### Database engine

WooCommerce labels the row `MySQL Version` whatever the engine actually is. The
engine is therefore **derived, not read**, and is always marked `inferred` with
its `inferenceBasis` recorded. The basis states explicitly that the value was
not given by the report and names the version string it came from:

> not stated by the report; derived from the reported "MySQL Version" value
> "5.5.5-10.6.16-MariaDB", which contains "MariaDB"

It is never `known`. A test asserts that across every fixture.

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
`❌`).

There is no fourth state. The parser has no defaults table, and there is no
constructor that accepts a fallback value. If a report omits the PHP version,
`server.phpVersion.status` is `"missing"` and `.value` is `undefined` — it never
becomes `"unknown"`, `"8.0"`, or `""`.

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
- Each entry in `plugins[]` and each `TemplateOverride` carries its own evidence
  pointing at its specific row.

A test enforces this across every fixture, warnings included: for each evidence
record, the line at `locator.line` in the source must equal the `excerpt`. A
citation that does not point at what it claims fails the suite.

---

## Parser warnings

`provenance.warnings` carries `ParserWarning[]`. These are **quality signals
about the parse, not diagnostics about the site**. A `Finding` says something
about the reported environment; a `ParserWarning` says how well this tool
managed to read the artifact. They carry no severity, no citation and no fix,
specifically so the two cannot be mistaken for one another — and a test asserts
they never grow Finding-shaped fields.

| Code | Meaning |
| --- | --- |
| `no_recognised_sections` | Input has `### … ###` headings but none were recognised. Usually a localised report. |
| `section_labels_unrecognised` | A recognised section contained none of its expected labels. |
| `plugin_count_mismatch` | A section header declared `(n)` but a different number of rows parsed. |
| `malformed_plugin_row` | A row in a plugin section matched neither `Name: by Author – Version` nor a leading version. |
| `malformed_override_row` | An entry under `Overrides` does not begin with a `.php` path. |
| `missing_continuation` | An `Overrides` row had an empty value and no continuation lines. |
| `section_incomplete` | A recognised section was present but could not be read completely. |

### Localised reports

This is the case Phase 2 was most concerned with. A Spanish report has
translated section headings (`### Entorno de WordPress ###`), so every section
lookup fails and every field comes back `missing`. Without a warning that is
indistinguishable from a valid English report describing a site with almost
nothing configured — a silently wrong answer.

The parser now emits `no_recognised_sections`, listing the headings it did find.
It still does **not** parse the report: warnings mark the input as unreadable,
they do not recover it.

Parsing continues after a warning. A malformed row is skipped and recorded; the
rows either side of it are still parsed.

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

Drop-ins never go through resolution — a drop-in is a file in `wp-content`, not
a repository plugin. Must-use plugins do go through it, and in the fixture
corpus none of them match, which is the correct outcome: host platform
mu-plugins are not repository plugins.

The catalog holds 31 hand-curated entries and is extended by hand. Tests enforce
unique `(name, author)` keys, a repository-shaped slug on every `wordpress.org`
entry, and no slug on any `premium` entry.

---

## Known limitations

1. **Localised reports are detected, not parsed.** `no_recognised_sections`
   tells you the file could not be read. It does not read it. A partially
   translated report — English headings with translated labels — is only caught
   by `section_labels_unrecognised`, which fires per section and may not fire at
   all if one expected label happens to survive translation.
2. **The catalog covers 31 plugins.** Realistic reports will resolve only
   partially. This is by design — an unresolved plugin is a correct answer, not
   a failure — but slug coverage is low until the catalog grows.
3. **Count mismatches are reported, not reconciled.** If a header says `(6)` and
   four rows parse, you get four plugins and a warning. The parser does not
   attempt to recover the missing two or guess what they were.
4. **A must-use plugin that matches the catalog would receive a WordPress.org
   slug.** No fixture currently does. If one did, a later Blueprint generator
   must not install it as an ordinary plugin — mu-plugins load earlier and
   unconditionally, so the load order would differ from the reported site. The
   `kind` field exists so that phase can tell the difference; nothing enforces
   it yet.
5. **Section detection is by English name.** A future WooCommerce release that
   renames a heading degrades those fields to `missing`, with
   `no_recognised_sections` firing only if *every* heading changed.
6. **Drop-in descriptions are not modelled**, only preserved in evidence.
7. **No cross-field validation beyond section counts.** Nothing checks that
   `wooCommerce.databaseVersion` is consistent with `wooCommerce.version`, for
   example — that is a diagnostic judgment and belongs to Phase 3.
