/**
 * Foundational types only. No parser, rule engine, planner, or Blueprint
 * generator exists yet — those are Phases 1–5.
 */
export type { FieldStatus, Field, AdapterId, Evidence, Citation } from "./evidence.js";
export type { StackFrame, OwnerType, Confidence, ErrorSignature } from "./signature.js";
export type {
  PluginSource,
  Plugin,
  Provenance,
  WordPressInfo,
  ServerInfo,
  ThemeInfo,
  WooCommerceInfo,
  DatabaseInfo,
  Environment,
} from "./environment.js";
export type { Severity, Finding } from "./finding.js";
export type {
  Tier,
  ReproStatus,
  Relevance,
  ReproductionTrigger,
  Reason,
  Substitution,
  Omission,
  ReproPlan,
} from "./repro.js";
export type { LogExtraction, Verification } from "./verification.js";
