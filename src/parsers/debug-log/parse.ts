/**
 * PHP fatal / WordPress debug.log excerpt adapter (docs/SPEC.md §2.1).
 *
 * Produces the `ErrorSignature` half of the canonical IR. Deterministic, with
 * no network access. Ownership is attributed here, in the adapter — never by a
 * diagnostic rule (Phase 3 instruction; docs/SPEC.md §4.5).
 *
 * Phase 0 established the exact shape this parser consumes by triggering real
 * fatals inside Playground; see docs/phase-0-findings.md §5.
 */
import type { ErrorSignature, StackFrame, OwnerType, Confidence } from "../../types/signature.js";
import type { Evidence } from "../../types/evidence.js";
import type { ParserWarning } from "../../types/warning.js";
import { resolveByDirectory } from "../../catalog/resolve.js";

export interface DebugLogParseInput {
  artifactId: string;
  text: string;
}

export interface DebugLogParseResult {
  signature?: ErrorSignature;
  warnings: ParserWarning[];
}

/** `[12-Sep-2026 10:08:45 UTC] PHP Fatal error:  Uncaught Error: msg in /path.php:6` */
const FATAL_LINE =
  /PHP (?:Fatal error|Parse error|Recoverable fatal error):\s+(?<body>.*)$/i;

/** `Uncaught SomeException: message in /path/file.php:123` */
const UNCAUGHT = /^Uncaught\s+([A-Za-z_\\][A-Za-z0-9_\\]*)\s*:\s*([\s\S]*?)\s+in\s+(\S+):(\d+)\s*$/;

/** Fatals with no class, e.g. `Allowed memory size of N bytes exhausted ... in /f.php on line 3` */
const CLASSLESS = /^([\s\S]*?)\s+in\s+(\S+)\s+on line\s+(\d+)\s*$/;

/** `#0 /wordpress/wp-includes/class-wp-hook.php(324): {closure}(false)` */
const FRAME = /^#\d+\s+(?:(\S+)\((\d+)\):\s*)?(.*)$/;

const PLUGIN_PATH = /wp-content\/plugins\/([^/]+)\//i;
const THEME_PATH = /wp-content\/themes\/([^/]+)\//i;
const CORE_PATH = /\/(wp-includes|wp-admin)\//i;

function evidenceFor(artifactId: string, line: number, excerpt: string): Evidence {
  return {
    artifactId,
    adapter: "debug-log",
    locator: { line },
    excerpt,
  };
}

/**
 * Attributes a path to its owner. Returns `unknown` rather than guessing.
 *
 * A plugin directory name is only turned into a slug when the bundled catalog
 * mediates it. An unmediated directory yields `low` confidence and no slug,
 * because the directory is not guaranteed to equal the repository slug.
 */
export function attributeOwner(path: string): {
  type: OwnerType;
  slug?: string;
  confidence: Confidence;
} {
  const plugin = PLUGIN_PATH.exec(path);
  if (plugin) {
    const dir = plugin[1] ?? "";
    const mediated = resolveByDirectory(dir);
    if (mediated?.slug !== undefined) {
      return { type: "plugin", slug: mediated.slug, confidence: "high" };
    }
    return { type: "plugin", confidence: "low" };
  }

  const theme = THEME_PATH.exec(path);
  if (theme) {
    // Theme directories are not mediated by the plugin catalog, so the theme
    // is identified but never given a slug.
    return { type: "theme", confidence: "medium" };
  }

  if (CORE_PATH.test(path)) return { type: "core", confidence: "high" };

  return { type: "unknown", confidence: "low" };
}

export function parseDebugLog(input: DebugLogParseInput): DebugLogParseResult {
  const warnings: ParserWarning[] = [];
  const lines = input.text.replace(/\r\n?/g, "\n").split("\n");

  let fatalIndex = -1;
  let body = "";
  for (let i = 0; i < lines.length; i += 1) {
    const match = FATAL_LINE.exec(lines[i] ?? "");
    if (match) {
      fatalIndex = i;
      body = (match.groups?.["body"] ?? "").trim();
      break;
    }
  }

  if (fatalIndex === -1) {
    if (input.text.trim() !== "") {
      warnings.push({
        code: "no_recognised_sections",
        detail:
          "input contains no recognisable PHP fatal/parse error line " +
          '(expected a line containing "PHP Fatal error:")',
      });
    }
    return { warnings };
  }

  const fatalLine = lines[fatalIndex] ?? "";
  const signatureEvidence = evidenceFor(input.artifactId, fatalIndex + 1, fatalLine);

  let errorClass: string | undefined;
  let message: string | undefined;
  let file: string | undefined;
  let line: number | undefined;

  const uncaught = UNCAUGHT.exec(body);
  if (uncaught) {
    errorClass = uncaught[1];
    message = uncaught[2];
    file = uncaught[3];
    line = Number(uncaught[4]);
  } else {
    const classless = CLASSLESS.exec(body);
    if (classless) {
      // No error class is available. Leaving errorClass undefined is correct:
      // a memory-exhaustion or parse error genuinely has no class.
      message = classless[1];
      file = classless[2];
      line = Number(classless[3]);
    } else {
      warnings.push({
        code: "malformed_plugin_row",
        evidence: signatureEvidence,
        detail: "fatal error line did not match a recognised PHP error shape",
      });
      message = body === "" ? undefined : body;
    }
  }

  const frames: StackFrame[] = [];
  for (let i = fatalIndex + 1; i < lines.length; i += 1) {
    const raw = (lines[i] ?? "").trim();
    if (raw === "") continue;
    if (/^thrown in\s/i.test(raw)) break;
    const frameMatch = FRAME.exec(raw);
    if (!frameMatch) continue;
    const frameFile = frameMatch[1];
    const frameLine = frameMatch[2];
    const fn = frameMatch[3]?.trim();
    frames.push({
      raw,
      ...(frameFile !== undefined ? { file: frameFile } : {}),
      ...(frameLine !== undefined ? { line: Number(frameLine) } : {}),
      ...(fn !== undefined && fn !== "" ? { function: fn } : {}),
    });
  }

  // Ownership is attributed from the throwing file when there is one, falling
  // back to the first stack frame that names a file.
  const attributionPath = file ?? frames.find((f) => f.file !== undefined)?.file;
  const owner = attributionPath ? attributeOwner(attributionPath) : { type: "unknown" as const, confidence: "low" as const };

  const signature: ErrorSignature = {
    owner,
    evidence: [signatureEvidence],
    ...(errorClass !== undefined ? { errorClass } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(file !== undefined ? { file } : {}),
    ...(line !== undefined && !Number.isNaN(line) ? { line } : {}),
    ...(frames.length > 0 ? { frames } : {}),
  };

  return { signature, warnings };
}
