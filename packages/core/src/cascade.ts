// Dev -> top-k confirm -> champion on CONFIRM (never on dev). Pure helpers used by the colony.
import { better, type Elite } from "./archive";
import { specId } from "./spec";

export interface ConfirmRec { score: number; trades: number }

/** Top-k elites by dev (same tie rule as the archive) that have no confirm yet. */
export function needConfirm(elites: Elite[], k: number, confirmed: (e: Elite) => boolean): Elite[] {
  return [...elites].sort((a, b) => (better(a, b) ? -1 : 1)).slice(0, k).filter((e) => !confirmed(e));
}

/** Champion = best confirm score; ties by fewer trades, then smaller specId. */
export function pickChampion<T extends { spec: readonly number[]; confirm: number; confirmTrades: number }>(xs: T[]): T | null {
  let best: T | null = null;
  for (const x of xs) {
    if (!best) { best = x; continue; }
    if (x.confirm !== best.confirm ? x.confirm > best.confirm
      : x.confirmTrades !== best.confirmTrades ? x.confirmTrades < best.confirmTrades
      : specId(x.spec) < specId(best.spec)) best = x;
  }
  return best;
}
