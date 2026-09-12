# Phase 2 findings

Goal: make `Environment` a trustworthy representation of the reported site
rather than merely whatever the parser managed to extract. No diagnostic rules,
Findings, planner, Blueprint generation or UI were built.

Date: 2026-09-12. 12 fixtures, 85 tests, typecheck clean, CI green.

---

## 1. What the IR can now represent that it could not before

### Four component categories instead of one

`Plugin.kind` is `"active" | "inactive" | "must-use" | "dropin"`.

Previously everything was a plugin with an optional `active` boolean, which
could not express a must-use plugin or a drop-in at all. Both are always loaded
and cannot be deactivated from the admin, so `active: true` would imply a
control that does not exist and `active: false` would be false.

`active` is now set **only** for the Active and Inactive sections, the only
places the report states it. Must-use plugins and drop-ins leave it `undefined`.
This is a deliberate refusal to fill a field the source never spoke to.

Drop-in rows turned out not to be plugin rows at all. WooCommerce renders them
as `file.php: Description` — the left side is the drop-in file, the right is
WordPress's description — so they bypass the plugin row parser entirely. Running
the plugin regex over them would have produced a plugin named after a file with
a description mistaken for an author.

### "No overrides" separated from "no Templates section"

`wooCommerce.templateOverrides` became `Field<TemplateOverride[]>`:

- no Templates section → `missing`
- `Overrides: –` → `known` with `[]`, evidenced by that line
- Templates present but no `Overrides` row → `missing` + `section_incomplete`

Only the second is evidence that the site overrides nothing. Before this change
all three produced `[]`, which would have let a later rule conclude "this site
has no template overrides" from a report that never mentioned templates.

### How well the artifact could be read

`provenance.warnings: ParserWarning[]` travels with the Environment. Seven
codes, listed in `docs/parser-woo-ssr.md`. They are explicitly not `Finding`s:
no severity, no citation, no fix, and a test asserts they never grow those
fields.

---

## 2. The failure mode this phase was really about

Before Phase 2, a Spanish System Status Report parsed **successfully**. Every
section lookup missed, every field came back `missing`, and the result was
indistinguishable from a valid English report describing a site with almost
nothing configured.

That is the worst category of bug for this product: a confidently wrong answer
with no signal attached. A downstream rule would have seen "PHP version
missing, WooCommerce version missing, no plugins" and drawn conclusions from an
artifact nobody had actually read.

`no_recognised_sections` now fires, naming the headings that were found. The
report is still not parsed — the warning marks the input as unreadable rather
than recovering it — but the difference between *unreadable* and *empty* is now
representable, which is the point.

---

## 3. Two real bugs found by writing the fixtures

**Trailing code fence read as content.** Fixture 08 ends with a closing
backtick followed by a newline, so the fence was not the last array element
after splitting. Fence stripping only popped trailing fence lines, not trailing
blanks, so the backtick survived, became a continuation line of the `Overrides`
row, and produced a spurious `malformed_override_row`. Fence stripping now
consumes trailing blanks as well. This was only visible because the new warning
machinery surfaced it — under Phase 1 it silently produced a junk override
entry.

**`indexOf`-based line offset.** Phase 1 computed the fence offset by searching
for the first content line in the original array. A leading blank line after a
fence would have matched the wrong index and shifted every line number in the
file. Replaced with a counter of lines actually removed. No fixture triggered
it; it was found by review, and the evidence-integrity test would have caught it
had a fixture existed.

---

## 4. Catalog review against the corpus

Reviewed all 30 distinct `(name, author, kind)` pairs across the corpus.

The corpus demanded **no** new entries: everything that should resolve resolves,
and every deliberately-unknown plugin stays unknown. The substantive finding is
that **must-use plugins and drop-ins are generally not repository plugins** —
`WP Engine System`, `Platform Guardrails`, `advanced-cache.php` — and resolution
correctly abstains on all of them.

The catalog was extended from 20 to 31 entries with commonly-encountered
plugins, and constrained by tests: unique `(name, author)` keys, a
repository-shaped slug on every `wordpress.org` entry, no slug on any `premium`
entry, and both fields non-empty. `(name, author)` keying and the refusal to
match on name alone are unchanged, and there is still no network path.

---

## 5. IR changes considered and rejected

Per the instruction to change the canonical model only where fixtures prove it
cannot represent the source:

- **`Plugin.description` for drop-ins** — rejected. The description is WordPress
  boilerplate ("External object cache.") and the file name already carries the
  identity. It survives verbatim in the evidence excerpt.
- **Making `plugins` a `Field<Plugin[]>`** — rejected. No fixture distinguishes
  "no plugin sections" from "sections present but empty" in a way that changes
  meaning, and the section counts already surface disagreement.
- **Replacing `active` with `kind` entirely** — rejected. `active` is named in
  `docs/SPEC.md` §4.4 and is meaningful for the two sections that state it.
  `kind` was added alongside rather than replacing it.
- **Returning warnings separately from `Environment`** — rejected. Warnings
  placed in `provenance` travel with the data, so a consumer three phases later
  still knows the artifact was unreadable.

---

## 6. Remaining limitations

1. A partially localised report — English headings, translated labels — is only
   caught by `section_labels_unrecognised`, which may not fire if a single
   expected label survives translation.
2. Count mismatches are reported, never reconciled. Four rows under a `(6)`
   header yield four plugins and a warning.
3. A must-use plugin that matched the catalog would receive a WordPress.org
   slug. None currently do. A later Blueprint generator must not install such a
   plugin normally — mu-plugins load earlier and unconditionally. `kind` makes
   the distinction available; nothing enforces it yet.
4. Section detection remains English-name-based.
5. Only the plain-text export is accepted; the HTML status table is not.
6. Cross-field consistency (e.g. `databaseVersion` versus `version`) is not
   checked. That is a diagnostic judgment and belongs to Phase 3.

---

## 7. Invariants held

- **Determinism** — every fixture parsed twice and compared.
- **Evidence integrity** — for every evidence record in every fixture, warnings
  included, the line at `locator.line` equals the `excerpt`.
- **No fabrication** — `missing` never carries a value; `database.engine` is
  asserted never to be `known` in any fixture.
- **No network** — resolution reads only the bundled catalog.
