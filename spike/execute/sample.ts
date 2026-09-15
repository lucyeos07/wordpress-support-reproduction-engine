/**
 * The artifacts both execution spikes use.
 *
 * Shared so the CLI and browser surfaces provably execute the SAME plan —
 * parity between them is only meaningful if the input is identical.
 * Classic Editor keeps the boot download to 19 KB rather than WooCommerce's
 * 20 MB.
 */
import { parseSystemStatusReport } from "../../src/parsers/woo-ssr/parse.js";
import { parseDebugLog } from "../../src/parsers/debug-log/parse.js";
import { attachSignature } from "../../src/ir/attach-signature.js";
import { planReproduction, type PlanResult } from "../../src/repro/plan.js";

export const SAMPLE_SSR = `### WordPress Environment ###

WC Version: 8.5.2
WP Version: 6.8.2
WP Memory Limit: 256 MB

### Server Environment ###

Server Info: nginx/1.18.0
PHP Version: 8.2.15
MySQL Version: 8.0.35

### Active Plugins (1) ###

Classic Editor: by WordPress Contributors – 1.6.3

### Templates ###

Overrides: –
`;

/** A reported fatal inside the plugin the plan installs. */
export const SAMPLE_LOG = `[11-Sep-2026 08:14:22 UTC] PHP Fatal error:  Uncaught Error: Call to undefined function classic_editor_missing() in /var/www/html/wp-content/plugins/classic-editor/classic-editor.php:212
Stack trace:
#0 {main}
  thrown in /var/www/html/wp-content/plugins/classic-editor/classic-editor.php on line 212
`;

export function buildSamplePlan(): PlanResult {
  let environment = parseSystemStatusReport({ artifactId: "spike-ssr", text: SAMPLE_SSR });
  environment = attachSignature(
    environment,
    "spike-log",
    parseDebugLog({ artifactId: "spike-log", text: SAMPLE_LOG }),
  );
  return planReproduction(environment);
}
