/**
 * Constructors for the three-state Field model (docs/SPEC.md §4.2).
 *
 * These are the only sanctioned ways to build a Field. There is deliberately no
 * constructor that takes a fallback value: a missing field never acquires one.
 */
import type { Field, Evidence } from "../types/evidence.js";

export function known<T>(value: T, evidence: Evidence): Field<T> {
  return { status: "known", value, evidence: [evidence] };
}

export function missing<T>(): Field<T> {
  return { status: "missing" };
}

export function inferred<T>(value: T, evidence: Evidence[], inferenceBasis: string): Field<T> {
  return { status: "inferred", value, evidence, inferenceBasis };
}

export function isPresent<T>(field: Field<T>): boolean {
  return field.status !== "missing";
}
