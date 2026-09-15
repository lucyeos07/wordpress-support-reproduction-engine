/**
 * Decides, for each reported component, whether Playground can install it.
 *
 * Every decision is driven by `Plugin.kind` and `Plugin.source` plus the
 * documented capabilities. Nothing is guessed: a component that cannot be
 * installed becomes an explicit omission carrying the reason, never a silent
 * drop and never a substituted near-equivalent (docs/SPEC.md §8.2).
 */
import type { Plugin } from "../types/environment.js";
import capabilities from "./capabilities.json" with { type: "json" };

export interface InstallDecision {
  plugin: Plugin;
  /** WordPress.org reference, `slug` or `slug@version`. */
  reference: string;
  active: boolean;
}

export interface OmitDecision {
  plugin: Plugin;
  component: string;
  why: string;
}

export type ComponentDecision =
  | ({ decision: "install" } & InstallDecision)
  | ({ decision: "omit" } & OmitDecision);

/** A stable human-readable label for a component in omissions and reasons. */
export function componentLabel(plugin: Plugin): string {
  const version = plugin.version !== undefined ? ` ${plugin.version}` : "";
  switch (plugin.kind) {
    case "dropin":
      return `drop-in ${plugin.name}`;
    case "must-use":
      return `must-use plugin ${plugin.name}${version}`;
    default:
      return `plugin ${plugin.name}${version}`;
  }
}

export function decideComponent(plugin: Plugin): ComponentDecision {
  const component = componentLabel(plugin);

  // A drop-in is a single file in wp-content, not a repository plugin. The
  // report gives its filename and WordPress's description, never its contents.
  if (plugin.kind === "dropin") {
    return {
      decision: "omit",
      plugin,
      component,
      why: `${capabilities.dropins.note} It is therefore not installed, and never converted into an ordinary plugin.`,
    };
  }

  // Installing a must-use plugin as an ordinary plugin would change when and
  // whether it loads, so the reported environment would not be reconstructed.
  if (plugin.kind === "must-use") {
    return {
      decision: "omit",
      plugin,
      component,
      why: `${capabilities.mustUsePlugins.note} It is therefore not installed as an ordinary WordPress.org plugin.`,
    };
  }

  if (plugin.source === "premium") {
    return {
      decision: "omit",
      plugin,
      component,
      why: "known premium plugin: it is not in the WordPress.org repository, so there is no supported way to install it here. It is recorded as omitted rather than reported as installed.",
    };
  }

  if (plugin.slug === undefined) {
    return {
      decision: "omit",
      plugin,
      component,
      why: "slug could not be resolved through the bundled catalog, and a slug is never guessed from a display name. Without a resolved slug there is no installable source.",
    };
  }

  // The reported version is pinned when known, so the reconstruction matches
  // what the site actually ran rather than whatever is current.
  const reference = plugin.version !== undefined ? `${plugin.slug}@${plugin.version}` : plugin.slug;

  return {
    decision: "install",
    plugin,
    reference,
    active: plugin.kind === "active",
  };
}

export function decideComponents(plugins: Plugin[]): ComponentDecision[] {
  return plugins.map(decideComponent);
}
