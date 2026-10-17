// Niche archive: style x activity (architecture 3a). Elite = highest dev, ties by fewer trades, then smaller specId.
import { LAGS, type Spec, specId } from "./spec";

export const STYLES = ["reversion", "neutral", "momentum"] as const;
export const ACTIVITIES = ["low", "mid", "high"] as const;
export type Style = (typeof STYLES)[number];
export type Activity = (typeof ACTIVITIES)[number];

export function styleOf(spec: Spec): number {
  let s = 0;
  for (let k = 0; k < LAGS; k++) s += spec[k]!;
  return s < -8 ? 0 : s > 8 ? 2 : 1;
}
export function activityOf(trades: number): number {
  return trades <= 8 ? 0 : trades <= 24 ? 1 : 2;
}
export function nicheOf(spec: Spec, trades: number): number {
  return styleOf(spec) * 3 + activityOf(trades);
}

export interface Elite {
  gen: number; idx: number; dev: number; trades: number; spec: number[]; id: string;
}

/** a strictly better than b */
export function better(a: Pick<Elite, "dev" | "trades" | "id">, b: Pick<Elite, "dev" | "trades" | "id">): boolean {
  if (a.dev !== b.dev) return a.dev > b.dev;
  if (a.trades !== b.trades) return a.trades < b.trades;
  return a.id < b.id;
}

export class Archive {
  cells: (Elite | null)[] = Array.from({ length: 9 }, () => null);

  /** Returns whether the entry discovered (beat the niche elite or filled an empty niche). */
  insert(e: { gen: number; idx: number; dev: number; trades: number; spec: Spec }): boolean {
    const el: Elite = { gen: e.gen, idx: e.idx, dev: e.dev, trades: e.trades, spec: [...e.spec], id: specId(e.spec) };
    const n = nicheOf(e.spec, e.trades);
    const cur = this.cells[n];
    if (!cur || better(el, cur)) { this.cells[n] = el; return true; }
    return false;
  }
  elites(): Elite[] { return this.cells.filter((c): c is Elite => c !== null); }
  clone(): Archive { const a = new Archive(); a.cells = this.cells.map((c) => (c ? { ...c, spec: [...c.spec] } : null)); return a; }
  bestDev(): number | null { const e = this.elites(); return e.length ? Math.max(...e.map((x) => x.dev)) : null; }
}
