// Calibration of (shadow) judges: Brier score and the authority ladder. Judges never change a score (AGENTS.md).
import type { Authority } from "./events";

export const DEFAULT_AUTHORITY: Authority = "shadow";
/** Ladder constants (docs/jev.md, principle 8). Promotion is a human decision; these are the evidence bars. */
export const AUTHORITY_LADDER = {
  default: "shadow" as Authority,
  advisoryMinN: 30,
  advisoryMargin: 0.02, // Brier must beat the base-rate predictor by this much
} as const;

export interface Resolved { pBps: number; outcome: boolean } // pBps in [0, 10000]

/** Mean squared error between probability and 0/1 outcome. NaN for an empty list. */
export function brier(xs: readonly Resolved[]): number {
  if (!xs.length) return NaN;
  return xs.reduce((a, x) => a + (x.pBps / 10000 - (x.outcome ? 1 : 0)) ** 2, 0) / xs.length;
}
/** Brier of the base-rate predictor (always predicts the observed hit rate). */
export function brierBaseline(xs: readonly Resolved[]): number {
  if (!xs.length) return NaN;
  const p = xs.filter((x) => x.outcome).length / xs.length;
  return p * (1 - p);
}
/** Authority for the evidence so far. This only *recommends* advisory; shadow is the default and delegated is never automatic. */
export function authorityFor(xs: readonly Resolved[]): Authority {
  if (xs.length >= AUTHORITY_LADDER.advisoryMinN && brier(xs) + AUTHORITY_LADDER.advisoryMargin <= brierBaseline(xs)) return "advisory";
  return "shadow";
}
export function calibrationSummary(xs: readonly Resolved[]) {
  return { n: xs.length, brier: brier(xs), brierBaseline: brierBaseline(xs), authority: authorityFor(xs) };
}
