/**
 * Named diagnosis cases: a System Status Report, optionally combined with a
 * debug log. Shared by the expectation generator and the tests so both always
 * describe the same scenarios.
 *
 * Each rule has at least one positive and one negative case, and the negatives
 * are chosen so that unrelated environment data cannot quietly satisfy a rule.
 */
export interface DiagnosisCase {
  name: string;
  ssr: string;
  log?: string;
  /** Why this case exists. */
  intent: string;
}

export const DIAGNOSIS_CASES: DiagnosisCase[] = [
  {
    name: "plugin-fatal",
    ssr: "01-storefront-baseline.txt",
    log: "log-01-plugin-fatal.txt",
    intent: "positive for FATAL_PLUGIN_OWNER; owner mediated by the catalog, so high confidence",
  },
  {
    name: "plugin-fatal-unmediated",
    ssr: "05-unknown-and-premium-plugins.txt",
    log: "log-04-unmediated-plugin.txt",
    intent:
      "positive for FATAL_PLUGIN_OWNER with an uncatalogued directory; confidence must drop to low and no slug may appear",
  },
  {
    name: "theme-fatal",
    ssr: "01-storefront-baseline.txt",
    log: "log-02-theme-fatal.txt",
    intent: "positive for FATAL_THEME_OWNER; negative for FATAL_PLUGIN_OWNER",
  },
  {
    name: "core-fatal",
    ssr: "01-storefront-baseline.txt",
    log: "log-03-core-fatal.txt",
    intent: "negative for both ownership rules; core ownership must stay core",
  },
  {
    name: "memory-exhaustion",
    ssr: "01-storefront-baseline.txt",
    log: "log-05-memory-exhaustion.txt",
    intent: "classless fatal inside a plugin path; positive for FATAL_PLUGIN_OWNER with no error class",
  },
  {
    name: "unreadable-log",
    ssr: "01-storefront-baseline.txt",
    log: "log-06-not-a-log.txt",
    intent: "log carries no fatal; no signature, so both ownership rules must report insufficient evidence",
  },
  {
    name: "php-below-requirement",
    ssr: "13-php-below-woo-requirement.txt",
    intent: "positive for PHP_BELOW_PLUGIN_REQUIREMENT; PHP 7.3.33 against WooCommerce 9.1.2's declared 7.4",
  },
  {
    name: "php-satisfies-requirement",
    ssr: "01-storefront-baseline.txt",
    intent: "negative for PHP_BELOW_PLUGIN_REQUIREMENT; PHP 8.1.27 comfortably exceeds the requirement",
  },
  {
    name: "php-no-requirement-data",
    ssr: "06-unknown-fields-reordered.txt",
    intent:
      "WooCommerce version present but PHP fine; confirms the rule evaluates rather than guessing",
  },
  {
    name: "outdated-templates",
    ssr: "02-child-theme-outdated-overrides.txt",
    intent: "positive for OUTDATED_TEMPLATE_OVERRIDE; three of four overrides are marked out of date",
  },
  {
    name: "current-template-override",
    ssr: "07-update-suffixes-no-inactive.txt",
    intent:
      "negative for OUTDATED_TEMPLATE_OVERRIDE; an override exists but the report does not call it outdated",
  },
  {
    name: "no-overrides-reported",
    ssr: "01-storefront-baseline.txt",
    intent: "negative for OUTDATED_TEMPLATE_OVERRIDE; the report states there are none",
  },
  {
    name: "insufficient-evidence",
    ssr: "04-missing-sections.txt",
    intent:
      "no PHP version and no signature; every rule must decline and the information request must name the gaps",
  },
];
