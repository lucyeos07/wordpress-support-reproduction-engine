/** Minimal DOM helpers and presentation mappings. No framework. */
import type { Field } from "../types/evidence.js";

type Attrs = Record<string, string | boolean | number | undefined>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Renders a Field's three-state provenance. Uncertainty is shown, never
 * hidden: a missing value says so rather than rendering as blank.
 */
export function fieldValue(field: Field<string> | Field<boolean>): {
  text: string;
  status: "known" | "inferred" | "missing";
} {
  if (field.status === "missing") return { text: "Not reported", status: "missing" };
  const value = field.value;
  const text = typeof value === "boolean" ? (value ? "Yes" : "No") : String(value ?? "");
  return { text, status: field.status === "inferred" ? "inferred" : "known" };
}

export function badge(status: "known" | "inferred" | "missing" | "warning"): HTMLElement {
  const labels = {
    known: "known",
    inferred: "inferred",
    missing: "missing",
    warning: "warning",
  } as const;
  return el("span", { class: `badge badge-${status}`, text: labels[status] });
}

export const SEVERITY_LABEL: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const TIER_LABEL: Record<string, string> = {
  A: "A — Reproducible",
  B: "B — Reproducible with substitution",
  C: "C — Environment-bound",
  D: "D — Dependency-bound",
  E: "E — Insufficient evidence",
};

export const RELEVANCE_LABEL: Record<string, string> = {
  relevant: "Relevant",
  irrelevant: "Irrelevant",
  unknown: "Unknown",
};

export function triggerLabel(trigger?: {
  kind: string;
  slug?: string;
  path?: string;
}): string {
  if (!trigger) return "No supported trigger";
  switch (trigger.kind) {
    case "boot":
      return "Boot";
    case "plugin_activation":
      return `Activate plugin: ${trigger.slug ?? ""}`;
    case "admin_page_load":
      return `Load admin page: ${trigger.path ?? ""}`;
    default:
      return trigger.kind;
  }
}
