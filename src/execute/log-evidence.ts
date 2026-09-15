/**
 * Turning raw debug.log text into evidence. Pure functions, no runtime.
 *
 * Phase 0 established that no Playground surface exposes structured PHP error
 * data: `originalErrorClassName` is the JS wrapper name, HTTP status is 200 on
 * a CLI fatal, and the only plain-text record with a full stack trace is
 * /wordpress/wp-content/debug.log. Everything here therefore works on raw text
 * and records how the values were obtained.
 */
import type { LogExtraction } from "../types/verification.js";

/**
 * debug.log entries begin with a bracketed timestamp. Continuation lines
 * (stack frames, "thrown in …") belong to the entry above them.
 */
const ENTRY_START = /^\[\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2} [^\]]*\]/;

/** `PHP Fatal error:  Uncaught SomeClass: message in /file.php:12` */
export const UNCAUGHT_PATTERN =
  /PHP (?:Fatal error|Parse error|Recoverable fatal error):\s+Uncaught\s+([A-Za-z_\\][A-Za-z0-9_\\]*)\s*:\s*([\s\S]*?)\s+in\s+(\S+):(\d+)/;

/** Fatals with no class, e.g. memory exhaustion. */
export const CLASSLESS_PATTERN =
  /PHP (?:Fatal error|Parse error|Recoverable fatal error):\s+([\s\S]*?)\s+in\s+(\S+)\s+on line\s+(\d+)/;

/**
 * Splits a log into whole entries. An entry is a timestamped line plus every
 * following untimestamped line, so a stack trace stays attached to its fatal.
 */
export function splitEntries(log: string): string[] {
  const lines = log.replace(/\r\n?/g, "\n").split("\n");
  const entries: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (ENTRY_START.test(line)) {
      if (current.length > 0) entries.push(current.join("\n"));
      current = [line];
    } else if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) entries.push(current.join("\n"));

  return entries.map((e) => e.trimEnd()).filter((e) => e.trim() !== "");
}

/**
 * Entries present in `after` but not in `before`.
 *
 * Compares whole entries rather than line counts or byte offsets, so a log
 * that was rotated or truncated between snapshots cannot silently yield
 * "everything is new". Pre-existing boot errors are never returned, which is
 * what keeps them from being mistaken for reproduction (Phase 0 §5).
 */
export function newEntries(before: string, after: string): string[] {
  const seen = new Map<string, number>();
  for (const entry of splitEntries(before)) {
    seen.set(entry, (seen.get(entry) ?? 0) + 1);
  }

  const added: string[] = [];
  for (const entry of splitEntries(after)) {
    const remaining = seen.get(entry) ?? 0;
    // A repeated identical fatal is genuinely new the second time, so consume
    // one occurrence rather than matching by presence.
    if (remaining > 0) {
      seen.set(entry, remaining - 1);
      continue;
    }
    added.push(entry);
  }
  return added;
}

export interface ExtractedError {
  errorClass?: string;
  message?: string;
  file?: string;
  line?: number;
  extraction: LogExtraction;
  /** The entry the values came from. */
  entry: string;
}

/**
 * Extracts a PHP error from a single log entry with a fixed pattern.
 *
 * `deterministic` is true only when a pattern matched. An entry that is a fatal
 * but matches neither pattern yields no class or message rather than a guess —
 * the raw entry is still returned as evidence.
 */
export function extractError(entry: string): ExtractedError | undefined {
  const uncaught = UNCAUGHT_PATTERN.exec(entry);
  if (uncaught) {
    return {
      ...(uncaught[1] !== undefined ? { errorClass: uncaught[1] } : {}),
      ...(uncaught[2] !== undefined ? { message: uncaught[2] } : {}),
      ...(uncaught[3] !== undefined ? { file: uncaught[3] } : {}),
      line: Number(uncaught[4]),
      extraction: {
        source: "debug.log",
        deterministic: true,
        pattern: UNCAUGHT_PATTERN.source,
      },
      entry,
    };
  }

  const classless = CLASSLESS_PATTERN.exec(entry);
  if (classless) {
    return {
      // No class exists for this kind of fatal; leaving it undefined is the
      // honest result, not a defect.
      ...(classless[1] !== undefined ? { message: classless[1] } : {}),
      ...(classless[2] !== undefined ? { file: classless[2] } : {}),
      line: Number(classless[3]),
      extraction: {
        source: "debug.log",
        deterministic: true,
        pattern: CLASSLESS_PATTERN.source,
      },
      entry,
    };
  }

  if (/PHP (?:Fatal error|Parse error|Recoverable fatal error):/.test(entry)) {
    return {
      extraction: { source: "debug.log", deterministic: false },
      entry,
    };
  }

  return undefined;
}

/** The first extractable fatal among newly written entries. */
export function firstFatal(entries: string[]): ExtractedError | undefined {
  for (const entry of entries) {
    const extracted = extractError(entry);
    if (extracted) return extracted;
  }
  return undefined;
}

export interface ExpectedSignature {
  errorClass?: string;
  message?: string;
  file?: string;
  line?: number;
}

export interface SignatureComparison {
  matches: boolean;
  /** Which fields were compared and agreed. */
  matchedOn: string[];
  /** Fields that were compared and disagreed. */
  mismatchedOn: string[];
}

/**
 * Compares an extracted error against the reported signature.
 *
 * Only fields the report actually stated are compared: a reported signature
 * with no line number must not fail to match because the reproduction has one.
 * Paths are compared by suffix, because the reported site's absolute paths
 * (/var/www/html/...) differ from Playground's (/wordpress/...) while the
 * plugin-relative tail is the same.
 *
 * A match requires at least one compared field and no disagreement. If nothing
 * can be compared, this is not a match — an empty expectation must never
 * produce a positive result.
 */
export function compareSignature(
  extracted: ExtractedError,
  expected: ExpectedSignature,
): SignatureComparison {
  const matchedOn: string[] = [];
  const mismatchedOn: string[] = [];

  if (expected.errorClass !== undefined && extracted.errorClass !== undefined) {
    (expected.errorClass === extracted.errorClass ? matchedOn : mismatchedOn).push("errorClass");
  }

  if (expected.message !== undefined && extracted.message !== undefined) {
    const normalise = (s: string): string => s.replace(/\s+/g, " ").trim();
    (normalise(expected.message) === normalise(extracted.message) ? matchedOn : mismatchedOn).push(
      "message",
    );
  }

  if (expected.file !== undefined && extracted.file !== undefined) {
    const tail = (p: string): string => {
      const marker = /wp-content\/(?:plugins|themes|mu-plugins)\/.*$/.exec(p);
      return marker ? marker[0] : p.split("/").slice(-2).join("/");
    };
    (tail(expected.file) === tail(extracted.file) ? matchedOn : mismatchedOn).push("file");
  }

  return {
    matches: matchedOn.length > 0 && mismatchedOn.length === 0,
    matchedOn,
    mismatchedOn,
  };
}
