/**
 * An Environment with no artifacts behind it.
 *
 * Used when an adapter was not applicable, so that no provenance entry claims
 * an artifact was read when none was. Every field is `missing`, which is the
 * honest state for "nothing was supplied", and is distinct from a parse that
 * ran and found nothing.
 */
import type { Environment } from "../types/environment.js";
import { missing } from "./field.js";

export function emptyEnvironment(): Environment {
  return {
    provenance: { artifacts: [], warnings: [] },
    wordPress: { version: missing<string>() },
    server: {
      phpVersion: missing<string>(),
      memoryLimit: missing<string>(),
      webServer: missing<string>(),
    },
    database: { engine: missing<string>(), version: missing<string>() },
    theme: {
      name: missing<string>(),
      version: missing<string>(),
      isChildTheme: missing<boolean>(),
      parentName: missing<string>(),
      parentVersion: missing<string>(),
    },
    plugins: [],
    wooCommerce: {
      version: missing<string>(),
      databaseVersion: missing<string>(),
      templateOverrides: missing(),
    },
    signatures: [],
  };
}
