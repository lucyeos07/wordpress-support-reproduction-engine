/**
 * Named reproduction-planning cases: a System Status Report plus zero or more
 * debug logs. Shared by the expectation generator and the tests.
 *
 * Logs are attached in listed order, so a case with two logs produces two
 * signatures and therefore two independent targets.
 */
export interface PlanCase {
  name: string;
  ssr: string;
  logs?: string[];
  intent: string;
}

export const PLAN_CASES: PlanCase[] = [
  {
    name: "plugin-fatal-reproducible",
    ssr: "01-storefront-baseline.txt",
    logs: ["log-01-plugin-fatal.txt"],
    intent:
      "fully reproducible plugin fatal: the owning plugin resolves, installs, and its activation is executable",
  },
  {
    name: "theme-fatal",
    ssr: "01-storefront-baseline.txt",
    logs: ["log-02-theme-fatal.txt"],
    intent: "theme fatal: no reported theme is installable, so the target is dependency-bound",
  },
  {
    name: "unresolved-plugin",
    ssr: "05-unknown-and-premium-plugins.txt",
    logs: ["log-04-unmediated-plugin.txt"],
    intent:
      "unresolved plugin: the owning directory is not in the catalog, so no slug is guessed and no activation can be executed",
  },
  {
    name: "premium-omission",
    ssr: "05-unknown-and-premium-plugins.txt",
    logs: ["log-01-plugin-fatal.txt"],
    intent: "premium plugins are recorded as omissions, never reported as installed",
  },
  {
    name: "inactive-irrelevant",
    ssr: "01-storefront-baseline.txt",
    logs: ["log-01-plugin-fatal.txt"],
    intent:
      "inactive plugins not implicated by any usable signature are installed but marked irrelevant to runtime reproduction",
  },
  {
    name: "must-use-and-dropins",
    ssr: "09-must-use-and-dropins.txt",
    logs: ["log-01-plugin-fatal.txt"],
    intent:
      "must-use plugins and drop-ins are omitted with their reasons, never converted into ordinary plugins",
  },
  {
    name: "external-dependency",
    ssr: "05-unknown-and-premium-plugins.txt",
    intent:
      "environment full of premium and unresolved components with no signature: everything unobtainable is surfaced",
  },
  {
    name: "insufficient-evidence",
    ssr: "04-missing-sections.txt",
    intent: "no PHP version, no theme, no signatures: nothing to reproduce",
  },
  {
    name: "unusable-signature",
    ssr: "01-storefront-baseline.txt",
    logs: ["log-07-unstructured-fatal.txt"],
    intent:
      "a fatal with no file, no frames and no identified owner is not usable for planning (docs/SPEC.md §6.1)",
  },
  {
    name: "multiple-signatures",
    ssr: "01-storefront-baseline.txt",
    logs: ["log-01-plugin-fatal.txt", "log-02-theme-fatal.txt", "log-03-core-fatal.txt"],
    intent:
      "three independent targets with different outcomes; no primary is chosen and none downgrades another",
  },
  {
    name: "php-version-unavailable",
    ssr: "13-php-below-woo-requirement.txt",
    logs: ["log-01-plugin-fatal.txt"],
    intent:
      "reported PHP 7.3 is not offered by Playground, so a material substitution is required and recorded",
  },
  {
    name: "admin-page-trigger",
    ssr: "01-storefront-baseline.txt",
    logs: ["log-08-admin-page-fatal.txt"],
    intent: "a stack frame naming a wp-admin page yields an admin page load trigger",
  },
];
