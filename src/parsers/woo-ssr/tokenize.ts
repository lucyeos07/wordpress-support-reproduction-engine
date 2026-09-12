/**
 * Splits a WooCommerce System Status Report ("Copy for support" plain text)
 * into sections and labelled rows, preserving 1-based line numbers and the
 * verbatim text of every line so evidence can point back at the input.
 *
 * Format, confirmed against WooCommerce's report generator:
 *   - sections are emitted as `### Section Name ###`
 *   - rows are emitted as `Label: Value`
 *   - a row with several values is expanded onto following lines, which carry
 *     no label; those are captured as continuations of the preceding row.
 */

const SECTION_RE = /^###\s*(.+?)\s*###$/;
const LABEL_RE = /^([^:]{1,120}?):[ \t]*(.*)$/;

export interface Row {
  label: string;
  /** First-line value. Continuations are kept separately, not concatenated. */
  value: string;
  /** 1-based line number of the labelled line. */
  line: number;
  /** Verbatim labelled line, unmodified. */
  raw: string;
  /** Verbatim unlabelled lines that followed, with their line numbers. */
  continuations: Array<{ text: string; line: number }>;
}

export interface Section {
  name: string;
  line: number;
  rows: Row[];
}

export interface Tokenized {
  sections: Section[];
}

/**
 * Reports are usually pasted wrapped in a Markdown code fence. Leading and
 * trailing fence lines are dropped; backticks inside the body are left alone.
 */
function stripCodeFence(lines: string[]): { lines: string[]; offset: number } {
  const out = [...lines];
  let offset = 0;
  while (out.length > 0 && /^`{1,3}\s*$/.test(out[0] ?? "")) {
    out.shift();
    offset += 1;
  }
  // Files normally end with a newline, so the closing fence is not the last
  // array element — trailing blanks have to go too, or the fence survives and
  // is read as a continuation line.
  const isFence = (l: string): boolean => /^`{1,3}\s*$/.test(l);
  const isBlank = (l: string): boolean => l.trim() === "";
  while (out.length > 0) {
    const last = out[out.length - 1] ?? "";
    if (!isFence(last) && !isBlank(last)) break;
    out.pop();
  }
  return { lines: out, offset };
}

export function tokenize(text: string): Tokenized {
  const normalised = text.replace(/\r\n?/g, "\n");
  const allLines = normalised.split("\n");

  // Line numbers must refer to the original input, so carry the number of
  // lines the fence strip removed instead of renumbering.
  const { lines: fenced, offset } = stripCodeFence(allLines);

  const sections: Section[] = [];
  let current: Section | undefined;
  let lastRow: Row | undefined;

  fenced.forEach((rawLine, index) => {
    const lineNumber = index + offset + 1;
    const trimmed = rawLine.trim();

    const sectionMatch = SECTION_RE.exec(trimmed);
    if (sectionMatch) {
      current = { name: sectionMatch[1] ?? "", line: lineNumber, rows: [] };
      sections.push(current);
      lastRow = undefined;
      return;
    }

    if (trimmed === "") {
      // A blank line ends a multi-value row but does not end the section.
      lastRow = undefined;
      return;
    }

    if (!current) return; // preamble before the first section

    const labelMatch = LABEL_RE.exec(trimmed);
    if (labelMatch) {
      const row: Row = {
        label: (labelMatch[1] ?? "").trim(),
        value: (labelMatch[2] ?? "").trim(),
        line: lineNumber,
        raw: rawLine,
        continuations: [],
      };
      current.rows.push(row);
      lastRow = row;
      return;
    }

    if (lastRow) {
      lastRow.continuations.push({ text: rawLine.trim(), line: lineNumber });
    }
  });

  return { sections };
}

/** Case-insensitive section lookup by exact name or by prefix. */
export function findSection(t: Tokenized, matcher: RegExp): Section | undefined {
  return t.sections.find((s) => matcher.test(s.name));
}

/** Case-insensitive row lookup within a section. */
export function findRow(section: Section | undefined, label: string): Row | undefined {
  if (!section) return undefined;
  const wanted = label.toLowerCase();
  return section.rows.find((r) => r.label.toLowerCase() === wanted);
}

/** First matching row for any of the given labels, in preference order. */
export function findRowAny(section: Section | undefined, labels: string[]): Row | undefined {
  for (const label of labels) {
    const row = findRow(section, label);
    if (row) return row;
  }
  return undefined;
}
