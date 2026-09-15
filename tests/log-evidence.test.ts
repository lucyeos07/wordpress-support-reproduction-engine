import { describe, it, expect } from "vitest";
import {
  splitEntries,
  newEntries,
  extractError,
  firstFatal,
  compareSignature,
} from "../src/execute/log-evidence.js";

/**
 * Verbatim debug.log text captured from a real Playground run in Phase 0, not
 * invented for this test. See docs/phase-0-findings.md §5.
 */
const REAL_FATAL = `[12-Sep-2026 10:08:45 UTC] PHP Fatal error:  Uncaught Error: Call to undefined function phase0_missing_function() in /wordpress/wp-content/plugins/phase0-fatal/phase0-fatal.php:6
Stack trace:
#0 /wordpress/wp-includes/class-wp-hook.php(324): {closure}(false)
#1 /wordpress/wp-includes/class-wp-hook.php(348): WP_Hook->apply_filters('', Array)
#2 /wordpress/wp-includes/plugin.php(517): WP_Hook->do_action(Array)
#3 /wordpress/wp-admin/includes/plugin.php(703): do_action('activate_phase0...', false)
#4 /internal/eval.php(4): activate_plugin('phase0-fatal/ph...')
#5 {main}
  thrown in /wordpress/wp-content/plugins/phase0-fatal/phase0-fatal.php on line 6`;

const BOOT_NOISE = `[12-Sep-2026 10:00:01 UTC] PHP Notice:  Function _load_textdomain_just_in_time was called incorrectly.`;

const MEMORY_FATAL = `[12-Sep-2026 10:09:34 UTC] PHP Fatal error:  Allowed memory size of 268435456 bytes exhausted (tried to allocate 20480 bytes) in /wordpress/wp-content/plugins/woocommerce/includes/class-wc-product-csv-exporter.php on line 208`;

describe("splitEntries", () => {
  it("keeps a stack trace attached to its fatal", () => {
    const entries = splitEntries(REAL_FATAL);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("Stack trace:");
    expect(entries[0]).toContain("thrown in");
  });

  it("separates entries by their timestamp", () => {
    expect(splitEntries(`${BOOT_NOISE}\n${REAL_FATAL}`)).toHaveLength(2);
  });

  it("returns nothing for an empty log", () => {
    expect(splitEntries("")).toEqual([]);
    expect(splitEntries("\n\n")).toEqual([]);
  });
});

describe("newEntries — boot noise is never reproduction", () => {
  it("returns only what the trigger added", () => {
    const before = BOOT_NOISE;
    const after = `${BOOT_NOISE}\n${REAL_FATAL}`;
    const added = newEntries(before, after);
    expect(added).toHaveLength(1);
    expect(added[0]).toContain("phase0_missing_function");
  });

  it("returns nothing when the trigger wrote nothing", () => {
    expect(newEntries(BOOT_NOISE, BOOT_NOISE)).toEqual([]);
  });

  it("never returns a pre-existing fatal", () => {
    // The fatal was already there before the trigger ran. Reporting it would
    // be exactly the false positive docs/SPEC.md §9.1 forbids.
    const before = `${BOOT_NOISE}\n${REAL_FATAL}`;
    expect(newEntries(before, before)).toEqual([]);
  });

  it("counts a repeated identical fatal as new the second time", () => {
    const before = REAL_FATAL;
    const after = `${REAL_FATAL}\n${REAL_FATAL}`;
    expect(newEntries(before, after)).toHaveLength(1);
  });

  it("does not treat a truncated log as all-new", () => {
    // If the log shrank, the surviving entries are still not new.
    const before = `${BOOT_NOISE}\n${REAL_FATAL}`;
    expect(newEntries(before, REAL_FATAL)).toEqual([]);
  });
});

describe("extractError", () => {
  it("extracts class, message, file and line from a real fatal", () => {
    const extracted = extractError(REAL_FATAL);
    expect(extracted?.errorClass).toBe("Error");
    expect(extracted?.message).toBe("Call to undefined function phase0_missing_function()");
    expect(extracted?.file).toBe("/wordpress/wp-content/plugins/phase0-fatal/phase0-fatal.php");
    expect(extracted?.line).toBe(6);
  });

  it("records the extraction as deterministic, with the pattern", () => {
    const extracted = extractError(REAL_FATAL);
    expect(extracted?.extraction.source).toBe("debug.log");
    expect(extracted?.extraction.deterministic).toBe(true);
    expect(extracted?.extraction.pattern).toContain("Uncaught");
  });

  it("handles a classless fatal without inventing a class", () => {
    const extracted = extractError(MEMORY_FATAL);
    expect(extracted?.errorClass).toBeUndefined();
    expect(extracted?.message).toContain("Allowed memory size");
    expect(extracted?.line).toBe(208);
    expect(extracted?.extraction.deterministic).toBe(true);
  });

  it("marks an unparseable fatal as non-deterministic rather than guessing", () => {
    const odd = "[12-Sep-2026 10:00:00 UTC] PHP Fatal error:  something unstructured";
    const extracted = extractError(odd);
    expect(extracted).toBeDefined();
    expect(extracted?.errorClass).toBeUndefined();
    expect(extracted?.message).toBeUndefined();
    expect(extracted?.extraction.deterministic).toBe(false);
    expect(extracted?.entry).toBe(odd);
  });

  it("ignores entries that are not fatals", () => {
    expect(extractError(BOOT_NOISE)).toBeUndefined();
  });

  it("firstFatal skips notices and returns the first real fatal", () => {
    const found = firstFatal([BOOT_NOISE, REAL_FATAL, MEMORY_FATAL]);
    expect(found?.message).toContain("phase0_missing_function");
  });

  it("firstFatal returns undefined when nothing qualifies", () => {
    expect(firstFatal([BOOT_NOISE])).toBeUndefined();
    expect(firstFatal([])).toBeUndefined();
  });
});

describe("compareSignature", () => {
  const extracted = extractError(REAL_FATAL)!;

  it("matches on class, message and file", () => {
    const result = compareSignature(extracted, {
      errorClass: "Error",
      message: "Call to undefined function phase0_missing_function()",
      file: "/wordpress/wp-content/plugins/phase0-fatal/phase0-fatal.php",
    });
    expect(result.matches).toBe(true);
    expect(result.matchedOn).toEqual(["errorClass", "message", "file"]);
  });

  it("matches across differing absolute path roots", () => {
    // The reported site is /var/www/html/...; Playground is /wordpress/...
    const result = compareSignature(extracted, {
      errorClass: "Error",
      file: "/var/www/html/wp-content/plugins/phase0-fatal/phase0-fatal.php",
    });
    expect(result.matches).toBe(true);
    expect(result.matchedOn).toContain("file");
  });

  it("does not match a different error", () => {
    const result = compareSignature(extracted, {
      errorClass: "TypeError",
      message: "something else entirely",
    });
    expect(result.matches).toBe(false);
    expect(result.mismatchedOn).toEqual(["errorClass", "message"]);
  });

  it("does not match a fatal in a different plugin", () => {
    const result = compareSignature(extracted, {
      file: "/var/www/html/wp-content/plugins/woocommerce/includes/wc-cart-functions.php",
    });
    expect(result.matches).toBe(false);
    expect(result.mismatchedOn).toContain("file");
  });

  it("never reports a match when there is nothing to compare", () => {
    // An empty expectation must not produce a positive result.
    expect(compareSignature(extracted, {}).matches).toBe(false);
    expect(compareSignature(extracted, {}).matchedOn).toEqual([]);
  });

  it("ignores fields the report did not state", () => {
    // The report gave no line number; having one must not cause a mismatch.
    const result = compareSignature(extracted, { errorClass: "Error" });
    expect(result.matches).toBe(true);
    expect(result.mismatchedOn).toEqual([]);
  });

  it("ignores fields the extraction could not provide", () => {
    const classless = extractError(MEMORY_FATAL)!;
    const result = compareSignature(classless, {
      errorClass: "Error",
      message: "Allowed memory size of 268435456 bytes exhausted (tried to allocate 20480 bytes)",
    });
    // errorClass is absent from the extraction, so only message is compared.
    expect(result.matchedOn).toEqual(["message"]);
    expect(result.matches).toBe(true);
  });

  it("tolerates whitespace differences in the message", () => {
    const result = compareSignature(extracted, {
      message: "Call to undefined function   phase0_missing_function()",
    });
    expect(result.matches).toBe(true);
  });
});
