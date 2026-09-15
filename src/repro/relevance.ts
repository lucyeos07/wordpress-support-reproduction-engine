/**
 * Usability, implication and relevance (docs/SPEC.md §6.1).
 *
 * These implement the SPEC definitions literally. No additional usability rule
 * is invented, and no diagnostic input reaches this module — see the firewall
 * test in tests/repro-firewall.test.ts.
 */
import type { ErrorSignature } from "../types/signature.js";
import type { Environment, Plugin } from "../types/environment.js";
import type { Relevance } from "../types/repro.js";

/**
 * §6.1: usable when the signature carries at least one of a parsed `file`
 * path, a non-empty `frames` collection containing a parsed file path, or an
 * identified `owner`.
 */
export function isUsableSignature(signature: ErrorSignature): boolean {
  if (signature.file !== undefined && signature.file.trim() !== "") return true;
  if ((signature.frames ?? []).some((f) => f.file !== undefined && f.file.trim() !== "")) {
    return true;
  }
  return signature.owner.type !== "unknown";
}

/** Every file path a signature names: the throwing file plus every frame file. */
export function signaturePaths(signature: ErrorSignature): string[] {
  const paths: string[] = [];
  if (signature.file !== undefined) paths.push(signature.file);
  for (const frame of signature.frames ?? []) {
    if (frame.file !== undefined) paths.push(frame.file);
  }
  return paths;
}

/**
 * A plugin's known path, per §6.1: its WordPress plugin directory, which is
 * only known when the slug is known. An unresolved plugin has no known path,
 * so it can never be implicated by path — which is why an unresolved slug
 * degrades relevance to `unknown` rather than silently matching on a name.
 */
export function knownPluginPath(plugin: Plugin): string | undefined {
  if (plugin.slug === undefined) return undefined;
  return `wp-content/plugins/${plugin.slug}/`;
}

/**
 * §6.1: implicated when the signature's `owner.slug` identifies the component,
 * or when a file path it names lies within the component's known path.
 * Deterministic path matching only — no semantic or function-name inference.
 */
export function isImplicatedBy(plugin: Plugin, signature: ErrorSignature): boolean {
  if (
    plugin.slug !== undefined &&
    signature.owner.slug !== undefined &&
    signature.owner.slug === plugin.slug
  ) {
    return true;
  }

  const path = knownPluginPath(plugin);
  if (path === undefined) return false;
  return signaturePaths(signature).some((p) => p.includes(path));
}

/**
 * §6.1 relevance, evaluated against ALL usable signatures:
 *   relevant   — implicated by any usable signature
 *   irrelevant — an inactive plugin implicated by none, because it is not loaded
 *   unknown    — anything else
 */
export function relevanceOf(plugin: Plugin, signatures: ErrorSignature[]): Relevance {
  const usable = signatures.filter(isUsableSignature);
  if (usable.some((s) => isImplicatedBy(plugin, s))) return "relevant";
  if (plugin.kind === "inactive") return "irrelevant";
  return "unknown";
}

/**
 * Relevance of a non-plugin environment component (database engine, web
 * server, memory limit). Signatures implicate plugin and theme paths, so no
 * deterministic association with infrastructure can be established and these
 * always remain `unknown`. §6.1 requires that this be surfaced rather than
 * silently resolved in either direction.
 */
export function infrastructureRelevance(): Relevance {
  return "unknown";
}

export function usableSignatures(environment: Environment): ErrorSignature[] {
  return environment.signatures.filter(isUsableSignature);
}
