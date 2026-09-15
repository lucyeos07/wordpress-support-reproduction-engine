/**
 * WooCommerce System Status Report parser (docs/SPEC.md §2, §4).
 *
 * Deterministic: the same input always yields the same Environment. No network
 * access, no clock, no randomness. Absent fields become `missing` — never a
 * default. See docs/parser-woo-ssr.md.
 */
import type {
  Environment,
  Plugin,
  PluginKind,
  TemplateOverride,
} from "../../types/environment.js";
import type { Evidence, Field } from "../../types/evidence.js";
import type { ParserWarning } from "../../types/warning.js";
import { known, missing, inferred } from "../../ir/field.js";
import { resolvePlugin } from "../../catalog/resolve.js";
import {
  tokenize,
  findSection,
  findRow,
  findRowAny,
  type Row,
  type Section,
  type Tokenized,
} from "./tokenize.js";

export interface SsrParseInput {
  /** Identifies the source artifact in every Evidence record it produces. */
  artifactId: string;
  text: string;
}

/**
 * WooCommerce renders booleans as ✔ / ❌ and "no value" as an en dash. The
 * report generator substitutes HTML entities for the dashicons, so both the
 * glyph and the entity appear in the wild.
 */
const YES = /^(?:✔|&#10004;|✓)/;
const EMPTY_VALUE = /^(?:–|—|-|&#8211;|❌|&#10060;)?$/;

function cleanValue(raw: string): string {
  return raw
    .replace(/^(?:✔|&#10004;|✓|❌|&#10060;)\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function evidenceFor(artifactId: string, section: Section, line: number, excerpt: string): Evidence {
  return {
    artifactId,
    adapter: "woo-ssr",
    locator: { section: section.name, line },
    excerpt,
  };
}

/** A row's value as a Field, or `missing` when the row is absent or empty. */
function fieldFrom(artifactId: string, section: Section | undefined, row: Row | undefined): Field<string> {
  if (!section || !row) return missing<string>();
  const value = cleanValue(row.value);
  if (EMPTY_VALUE.test(value)) return missing<string>();
  return known(value, evidenceFor(artifactId, section, row.line, row.raw));
}

function booleanFieldFrom(
  artifactId: string,
  section: Section | undefined,
  row: Row | undefined,
): Field<boolean> {
  if (!section || !row) return missing<boolean>();
  const value = row.value.trim();
  if (value === "") return missing<boolean>();
  return known(YES.test(value), evidenceFor(artifactId, section, row.line, row.raw));
}

/**
 * Matched against the whole row, not the tokenizer's label/value split,
 * because plugin names may themselves contain a colon — the WordPress.org
 * plugin "Akismet Anti-spam: Spam Protection" is the common example. The first
 * group is greedy so it binds to the LAST ": by ", keeping such names intact.
 * The author group tolerates being empty, which happens for must-use plugins
 * that declare no author.
 */
const PLUGIN_LINE = /^(.*):\s*by\s*(.*?)\s*[–—-]\s*(.+)$/;
const PLUGIN_WITHOUT_AUTHOR = /^[–—-]?\s*([0-9][^\s(]*)/;

/** `### Active Plugins (6) ###` → 6 */
const SECTION_COUNT = /\((\d+)\)\s*$/;

/** Strips WooCommerce's "(update to version X is available)" suffix. */
function cleanVersion(raw: string): string | undefined {
  const stripped = raw.replace(/\s*\(.*?\)\s*$/, "").trim();
  return stripped === "" ? undefined : stripped;
}

interface ParseContext {
  artifactId: string;
  warnings: ParserWarning[];
}

function warn(ctx: ParseContext, warning: ParserWarning): void {
  ctx.warnings.push(warning);
}

/**
 * Compares a section header's declared count against the rows actually parsed.
 * A mismatch means the report and our reading of it disagree, which is a
 * quality signal about the parse rather than a statement about the site.
 */
function checkDeclaredCount(ctx: ParseContext, section: Section, parsed: number): void {
  const match = SECTION_COUNT.exec(section.name);
  if (!match) return;
  const declared = Number(match[1]);
  if (declared === parsed) return;
  warn(ctx, {
    code: "plugin_count_mismatch",
    section: section.name,
    detail: `section header declares ${String(declared)} entries but ${String(parsed)} row(s) parsed`,
  });
}

function parsePluginRows(
  ctx: ParseContext,
  section: Section | undefined,
  kind: PluginKind,
): Plugin[] {
  if (!section) return [];

  const plugins = section.rows.map((row) => {
    const evidence = evidenceFor(ctx.artifactId, section, row.line, row.raw);

    let name = row.label.trim();
    let author: string | undefined;
    let version: string | undefined;

    const wholeLine = cleanValue(row.raw);
    const withAuthor = PLUGIN_LINE.exec(wholeLine);
    if (withAuthor) {
      name = (withAuthor[1] ?? "").trim();
      author = (withAuthor[2] ?? "").trim() || undefined;
      version = cleanVersion(withAuthor[3] ?? "");
    } else {
      const versionOnly = PLUGIN_WITHOUT_AUTHOR.exec(cleanValue(row.value));
      if (versionOnly) {
        version = cleanVersion(versionOnly[1] ?? "");
      } else {
        warn(ctx, {
          code: "malformed_plugin_row",
          section: section.name,
          evidence,
          detail: `row does not match "Name: by Author – Version" and carries no leading version`,
        });
      }
    }

    const resolution = resolvePlugin(name, author);

    return {
      name,
      kind,
      source: resolution.source,
      evidence,
      ...(kind === "active" || kind === "inactive" ? { active: kind === "active" } : {}),
      ...(resolution.slug !== undefined ? { slug: resolution.slug } : {}),
      ...(author !== undefined ? { author } : {}),
      ...(version !== undefined ? { version } : {}),
    } satisfies Plugin;
  });

  checkDeclaredCount(ctx, section, plugins.length);
  return plugins;
}

/**
 * Drop-in rows are `file.php: Description` — the left side is the drop-in file
 * and the right side is WordPress's description of it. They carry no author or
 * version, so they deliberately do not go through the plugin row regex. The
 * description is not modelled; it is preserved verbatim in the evidence
 * excerpt.
 */
function parseDropinRows(ctx: ParseContext, section: Section | undefined): Plugin[] {
  if (!section) return [];

  const dropins = section.rows.map((row) => ({
    name: row.label.trim(),
    kind: "dropin" as const,
    source: "unknown" as const,
    evidence: evidenceFor(ctx.artifactId, section, row.line, row.raw),
  }));

  checkDeclaredCount(ctx, section, dropins.length);
  return dropins;
}

const OVERRIDE_RE =
  /^(\S+\.php)(?:\s+version\s+(\S+)\s+is out of date\.\s*The core version is\s+(\S+))?/i;

/**
 * Returns a Field so that an absent Templates section (`missing`) stays
 * distinct from a section that explicitly reports no overrides (`known` with
 * an empty array).
 */
function parseTemplateOverrides(
  ctx: ParseContext,
  section: Section | undefined,
): Field<TemplateOverride[]> {
  if (!section) return missing<TemplateOverride[]>();

  const row = findRow(section, "Overrides");
  if (!row) {
    warn(ctx, {
      code: "section_incomplete",
      section: section.name,
      detail: 'Templates section present but no "Overrides" row was found',
    });
    return missing<TemplateOverride[]>();
  }

  const rowEvidence = evidenceFor(ctx.artifactId, section, row.line, row.raw);
  const firstValue = cleanValue(row.value);
  const explicitlyNone = EMPTY_VALUE.test(firstValue);

  if (explicitlyNone && row.continuations.length === 0) {
    if (firstValue === "") {
      // A blank value with nothing following it is not the same as "–".
      warn(ctx, {
        code: "missing_continuation",
        section: section.name,
        evidence: rowEvidence,
        detail: '"Overrides" row has an empty value and no continuation lines',
      });
      return missing<TemplateOverride[]>();
    }
    return known([], rowEvidence);
  }

  const candidates: Array<{ text: string; line: number; raw: string }> = [];
  if (!explicitlyNone) {
    candidates.push({ text: firstValue, line: row.line, raw: row.raw });
  }
  for (const cont of row.continuations) {
    candidates.push({ text: cont.text, line: cont.line, raw: cont.text });
  }

  const overrides: TemplateOverride[] = [];
  for (const candidate of candidates) {
    const evidence = evidenceFor(ctx.artifactId, section, candidate.line, candidate.raw);
    const match = OVERRIDE_RE.exec(candidate.text);
    if (!match) {
      warn(ctx, {
        code: "malformed_override_row",
        section: section.name,
        evidence,
        detail: "override entry does not begin with a .php path",
      });
      continue;
    }
    const version = match[2];
    const coreVersion = match[3];
    overrides.push({
      file: match[1] ?? "",
      outdated: version !== undefined,
      evidence,
      ...(version !== undefined ? { version } : {}),
      ...(coreVersion !== undefined ? { coreVersion } : {}),
    });
  }

  return known(overrides, rowEvidence);
}

/**
 * Flags a recognised section whose labels are all unfamiliar. Without this, a
 * report in another admin language parses as a valid English report that
 * happens to be missing nearly everything.
 */
function checkSectionLabels(
  ctx: ParseContext,
  section: Section | undefined,
  expected: string[],
): void {
  if (!section || section.rows.length === 0) return;
  const present = new Set(section.rows.map((r) => r.label.toLowerCase()));
  const recognised = expected.some((label) => present.has(label.toLowerCase()));
  if (recognised) return;
  warn(ctx, {
    code: "section_labels_unrecognised",
    section: section.name,
    detail: `none of the expected labels (${expected.join(", ")}) were found in this section`,
  });
}

export function parseSystemStatusReport(input: SsrParseInput): Environment {
  const { artifactId } = input;
  const ctx: ParseContext = { artifactId, warnings: [] };
  const tokenized = tokenize(input.text);

  const wpEnv = findSection(tokenized, /^WordPress Environment/i);
  const serverEnv = findSection(tokenized, /^Server Environment/i);
  const dbSection = findSection(tokenized, /^Database/i);
  const themeSection = findSection(tokenized, /^Theme/i);
  const templatesSection = findSection(tokenized, /^Templates/i);
  const activeSection = findSection(tokenized, /^Active Plugins/i);
  const inactiveSection = findSection(tokenized, /^Inactive Plugins/i);
  const mustUseSection = findSection(tokenized, /^Must Use Plugins/i);
  const dropinSection = findSection(tokenized, /^Dropin Plugins/i);

  detectUnrecognisedReport(ctx, tokenized, [
    wpEnv,
    serverEnv,
    dbSection,
    themeSection,
    templatesSection,
    activeSection,
    inactiveSection,
    mustUseSection,
    dropinSection,
  ]);

  checkSectionLabels(ctx, wpEnv, ["WP Version", "WC Version", "WP Memory Limit"]);
  checkSectionLabels(ctx, serverEnv, ["PHP Version", "Server Info", "MySQL Version"]);
  checkSectionLabels(ctx, themeSection, ["Name", "Version"]);

  // "PHP Memory Limit" is the PHP-level value; "WP Memory Limit" is what most
  // reports carry. Prefer the PHP one when both are present.
  const phpMemoryRow = findRow(serverEnv, "PHP Memory Limit");
  const memoryLimit = phpMemoryRow
    ? fieldFrom(artifactId, serverEnv, phpMemoryRow)
    : fieldFrom(artifactId, wpEnv, findRow(wpEnv, "WP Memory Limit"));

  // MySQL version is reported under Server Environment; some exports place it
  // in the Database section instead.
  const mysqlRow = findRow(serverEnv, "MySQL Version");
  const dbVersion = mysqlRow
    ? fieldFrom(artifactId, serverEnv, mysqlRow)
    : fieldFrom(artifactId, dbSection, findRow(dbSection, "MySQL Version"));

  const childThemeRow = findRowAny(themeSection, ["Child theme", "Child Theme"]);

  return {
    provenance: {
      artifacts: [{ artifactId, adapter: "woo-ssr" }],
      warnings: ctx.warnings,
    },

    // A System Status Report carries no error signatures; a debug log supplies
    // them (docs/SPEC.md §2.2).
    signatures: [],

    wordPress: {
      version: fieldFrom(artifactId, wpEnv, findRow(wpEnv, "WP Version")),
    },

    server: {
      phpVersion: fieldFrom(artifactId, serverEnv, findRow(serverEnv, "PHP Version")),
      memoryLimit,
      webServer: fieldFrom(artifactId, serverEnv, findRow(serverEnv, "Server Info")),
    },

    database: { engine: deriveEngine(dbVersion), version: dbVersion },

    theme: {
      name: fieldFrom(artifactId, themeSection, findRow(themeSection, "Name")),
      version: fieldFrom(artifactId, themeSection, findRow(themeSection, "Version")),
      isChildTheme: booleanFieldFrom(artifactId, themeSection, childThemeRow),
      parentName: fieldFrom(
        artifactId,
        themeSection,
        findRowAny(themeSection, ["Parent theme name", "Parent Theme Name"]),
      ),
      parentVersion: fieldFrom(
        artifactId,
        themeSection,
        findRowAny(themeSection, ["Parent theme version", "Parent Theme Version"]),
      ),
    },

    plugins: [
      ...parsePluginRows(ctx, activeSection, "active"),
      ...parsePluginRows(ctx, inactiveSection, "inactive"),
      ...parsePluginRows(ctx, mustUseSection, "must-use"),
      ...parseDropinRows(ctx, dropinSection),
    ],

    wooCommerce: {
      version: fieldFrom(artifactId, wpEnv, findRow(wpEnv, "WC Version")),
      databaseVersion: fieldFrom(artifactId, dbSection, findRow(dbSection, "WC Database Version")),
      templateOverrides: parseTemplateOverrides(ctx, templatesSection),
    },
  };
}

/**
 * The input has `### ... ###` headings, so it is shaped like a report, but not
 * one heading was recognised. The usual cause is a report generated in a
 * non-English admin language. Reporting this is the difference between "this
 * site has almost nothing configured" and "this tool could not read the file".
 */
function detectUnrecognisedReport(
  ctx: ParseContext,
  tokenized: Tokenized,
  recognised: Array<Section | undefined>,
): void {
  if (tokenized.sections.length === 0) return;
  if (recognised.some((s) => s !== undefined)) return;
  warn(ctx, {
    code: "no_recognised_sections",
    detail:
      `input contains ${String(tokenized.sections.length)} section heading(s) but none were recognised ` +
      `(found: ${tokenized.sections.map((s) => s.name).join(", ")}); ` +
      `labels are matched in English, so this may be a localised report`,
  });
}

/**
 * WooCommerce labels the row "MySQL Version" whatever the engine is, so the
 * engine is derived rather than read, and is marked `inferred` with its basis.
 */
function deriveEngine(version: Field<string>): Field<string> {
  if (version.status === "missing" || version.value === undefined) return missing<string>();
  const evidence = version.evidence ?? [];

  if (/mariadb/i.test(version.value)) {
    return inferred(
      "MariaDB",
      evidence,
      'not stated by the report; derived from the reported "MySQL Version" value ' +
        `"${version.value}", which contains "MariaDB"`,
    );
  }
  return inferred(
    "MySQL",
    evidence,
    'not stated by the report; derived from the value being reported under the ' +
      '"MySQL Version" label with no MariaDB marker in the value',
  );
}
