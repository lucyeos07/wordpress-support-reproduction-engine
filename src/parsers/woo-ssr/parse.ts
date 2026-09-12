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
  TemplateOverride,
} from "../../types/environment.js";
import type { Evidence, Field } from "../../types/evidence.js";
import { known, missing, inferred } from "../../ir/field.js";
import { resolvePlugin } from "../../catalog/resolve.js";
import { tokenize, findSection, findRow, findRowAny, type Row, type Section } from "./tokenize.js";

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
 */
const PLUGIN_LINE = /^(.*):\s*by\s+(.*?)\s+[–—-]\s+(.+)$/;
const PLUGIN_WITHOUT_AUTHOR = /^[–—-]?\s*([0-9][^\s(]*)/;

/** Strips WooCommerce's "(update to version X is available)" suffix. */
function cleanVersion(raw: string): string | undefined {
  const stripped = raw.replace(/\s*\(.*?\)\s*$/, "").trim();
  return stripped === "" ? undefined : stripped;
}

function parsePluginRows(
  artifactId: string,
  section: Section | undefined,
  active: boolean,
): Plugin[] {
  if (!section) return [];

  return section.rows.map((row) => {
    const evidence = evidenceFor(artifactId, section, row.line, row.raw);

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
      if (versionOnly) version = cleanVersion(versionOnly[1] ?? "");
    }

    const resolution = resolvePlugin(name, author);

    return {
      name,
      source: resolution.source,
      active,
      evidence,
      ...(resolution.slug !== undefined ? { slug: resolution.slug } : {}),
      ...(author !== undefined ? { author } : {}),
      ...(version !== undefined ? { version } : {}),
    } satisfies Plugin;
  });
}

const OVERRIDE_RE =
  /^(\S+\.php)(?:\s+version\s+(\S+)\s+is out of date\.\s*The core version is\s+(\S+))?/i;

function parseTemplateOverrides(artifactId: string, section: Section | undefined): TemplateOverride[] {
  if (!section) return [];
  const row = findRow(section, "Overrides");
  if (!row) return [];

  const candidates: Array<{ text: string; line: number; raw: string }> = [];
  const firstValue = cleanValue(row.value);
  if (!EMPTY_VALUE.test(firstValue)) {
    candidates.push({ text: firstValue, line: row.line, raw: row.raw });
  }
  for (const cont of row.continuations) {
    candidates.push({ text: cont.text, line: cont.line, raw: cont.text });
  }

  const overrides: TemplateOverride[] = [];
  for (const candidate of candidates) {
    const match = OVERRIDE_RE.exec(candidate.text);
    if (!match) continue;
    const version = match[2];
    const coreVersion = match[3];
    overrides.push({
      file: match[1] ?? "",
      outdated: version !== undefined,
      evidence: evidenceFor(artifactId, section, candidate.line, candidate.raw),
      ...(version !== undefined ? { version } : {}),
      ...(coreVersion !== undefined ? { coreVersion } : {}),
    });
  }
  return overrides;
}

export function parseSystemStatusReport(input: SsrParseInput): Environment {
  const { artifactId } = input;
  const tokenized = tokenize(input.text);

  const wpEnv = findSection(tokenized, /^WordPress Environment/i);
  const serverEnv = findSection(tokenized, /^Server Environment/i);
  const dbSection = findSection(tokenized, /^Database/i);
  const themeSection = findSection(tokenized, /^Theme/i);
  const templatesSection = findSection(tokenized, /^Templates/i);
  const activeSection = findSection(tokenized, /^Active Plugins/i);
  const inactiveSection = findSection(tokenized, /^Inactive Plugins/i);

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

  const engine = deriveEngine(dbVersion);

  const themeName = fieldFrom(artifactId, themeSection, findRow(themeSection, "Name"));
  const themeVersion = fieldFrom(artifactId, themeSection, findRow(themeSection, "Version"));
  const childThemeRow = findRowAny(themeSection, ["Child theme", "Child Theme"]);

  return {
    provenance: { artifacts: [{ artifactId, adapter: "woo-ssr" }] },

    wordPress: {
      version: fieldFrom(artifactId, wpEnv, findRow(wpEnv, "WP Version")),
    },

    server: {
      phpVersion: fieldFrom(artifactId, serverEnv, findRow(serverEnv, "PHP Version")),
      memoryLimit,
      webServer: fieldFrom(artifactId, serverEnv, findRow(serverEnv, "Server Info")),
    },

    database: { engine, version: dbVersion },

    theme: {
      name: themeName,
      version: themeVersion,
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
      ...parsePluginRows(artifactId, activeSection, true),
      ...parsePluginRows(artifactId, inactiveSection, false),
    ],

    wooCommerce: {
      version: fieldFrom(artifactId, wpEnv, findRow(wpEnv, "WC Version")),
      databaseVersion: fieldFrom(artifactId, dbSection, findRow(dbSection, "WC Database Version")),
      templateOverrides: parseTemplateOverrides(artifactId, templatesSection),
    },
  };
}

/**
 * WooCommerce labels the row "MySQL Version" whatever the engine is, so the
 * engine is derived rather than read, and is marked `inferred` with its basis.
 */
function deriveEngine(version: Field<string>): Field<string> {
  if (version.status === "missing" || version.value === undefined) return missing<string>();
  const evidence = version.evidence ?? [];

  if (/mariadb/i.test(version.value)) {
    return inferred("MariaDB", evidence, 'reported MySQL Version value contains "MariaDB"');
  }
  return inferred(
    "MySQL",
    evidence,
    'reported under the "MySQL Version" label with no MariaDB marker in the value',
  );
}
