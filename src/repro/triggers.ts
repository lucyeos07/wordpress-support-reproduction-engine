/**
 * Trigger derivation (docs/SPEC.md §8.1).
 *
 * Derived only from the Environment, that target's own ErrorSignature, and the
 * documented capabilities. Never from a Finding. When no supported trigger can
 * be established deterministically the target records `attempted: false` with
 * an explicit reason, rather than falling back to something plausible.
 */
import type { ErrorSignature } from "../types/signature.js";
import type { ReproductionTrigger } from "../types/repro.js";
import { isUsableSignature, signaturePaths } from "./relevance.js";

export interface TriggerDecision {
  trigger?: ReproductionTrigger;
  attempted: boolean;
  /** Present whenever `attempted` is false. */
  reason?: string;
  /** Machine-readable counterpart of `reason`, for plan reasons. */
  code: string;
}

/**
 * A direct wp-admin page, e.g. `/wp-admin/plugins.php`. Deliberately excludes
 * anything nested such as `/wp-admin/includes/plugin.php`, which is an include
 * rather than a page that can be requested.
 */
const ADMIN_PAGE = /\/wp-admin\/([A-Za-z0-9._-]+\.php)$/;

function adminPagePath(signature: ErrorSignature): string | undefined {
  for (const path of signaturePaths(signature)) {
    const match = ADMIN_PAGE.exec(path);
    if (match) return `/wp-admin/${match[1] ?? ""}`;
  }
  return undefined;
}

/**
 * @param installableSlugs Slugs the plan will actually install. A plugin
 * activation trigger is only executable for a plugin that is being installed.
 */
export function deriveTrigger(
  signature: ErrorSignature,
  installableSlugs: ReadonlySet<string>,
): TriggerDecision {
  if (!isUsableSignature(signature)) {
    return {
      attempted: false,
      code: "signature_not_usable",
      reason:
        "this signature carries no file path, no stack frame with a file path, and no identified owner, so no concrete reported failure target can be derived from it (docs/SPEC.md §6.1)",
    };
  }

  // Stack information clearly indicating a wp-admin page takes precedence:
  // it names an executable request, which activation alone may not reach.
  const adminPath = adminPagePath(signature);
  if (adminPath !== undefined) {
    return { trigger: { kind: "admin_page_load", path: adminPath }, attempted: true, code: "admin_page_load" };
  }

  if (signature.owner.type === "plugin") {
    const slug = signature.owner.slug;
    if (slug === undefined) {
      return {
        attempted: false,
        code: "owner_plugin_unresolved",
        reason:
          "the failure is owned by a plugin, but its directory is not in the bundled catalog, so there is no slug to install or activate. A slug is never guessed from a directory name.",
      };
    }
    if (!installableSlugs.has(slug)) {
      return {
        attempted: false,
        code: "owner_plugin_not_installable",
        reason: `the failure is owned by plugin "${slug}", which this plan does not install, so its activation cannot be executed`,
      };
    }
    return { trigger: { kind: "plugin_activation", slug }, attempted: true, code: "plugin_activation" };
  }

  if (signature.owner.type === "theme") {
    return {
      attempted: false,
      code: "owner_theme_not_installable",
      reason:
        "the failure is owned by a theme, and no reported theme can be resolved to an installable source, so the code that failed would not be present in the reconstructed site",
    };
  }

  // Core-owned and path-only signatures: boot is always executable, and the
  // debug.log diff around boot is a legitimate observation point.
  return { trigger: { kind: "boot" }, attempted: true, code: "boot" };
}
