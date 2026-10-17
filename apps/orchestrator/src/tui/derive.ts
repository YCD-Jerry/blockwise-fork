// Numbers derived from a folded ViewState, shared by the pages and by `report`. Pure; memoised per (state, event count).
import { ref, type Cand, type ViewState } from "./state";

export const median = (xs: number[]): number | null => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2; };

const memo = new WeakMap<ViewState, Map<string, { at: number; v: unknown }>>();
function cached<T>(s: ViewState, key: string, f: () => T): T {
  let m = memo.get(s); if (!m) { m = new Map(); memo.set(s, m); }
  const hit = m.get(key);
  if (hit && hit.at === s.events + s.badLines) return hit.v as T;
  const v = f(); m.set(key, { at: s.events + s.badLines, v }); return v;
}

export interface BlockRow { block: number; gen: number; evals: number; reverted: number; ts?: number; dBlk?: number; dTs?: number; msPerBlk?: number }
export interface BlockStats { blocks: number; evals: number; median: number | null; max: number | null; intervalMs: number | null; intervalBlocks: number }

/** One row per block that has evals landed (or a block event), ascending, with gaps to the previous row. */
export function blockRows(s: ViewState): BlockRow[] {
  return cached(s, "blockRows", () => {
    const rows = [...s.blocks.values()].sort((a, b) => a.block - b.block).map((b): BlockRow => ({ block: b.block, gen: b.gen, evals: b.evals || b.evalsLanded || 0, reverted: b.reverted, ts: b.ts }));
    for (let i = 1; i < rows.length; i++) {
      const p = rows[i - 1]!, r = rows[i]!;
      r.dBlk = r.block - p.block;
      if (r.ts !== undefined && p.ts !== undefined) { r.dTs = r.ts - p.ts; if (r.dBlk > 1) r.msPerBlk = (r.dTs * 1000) / r.dBlk; }
    }
    return rows;
  });
}

/**
 * Block interval from chain timestamps over runs of consecutive blocks (dBlk = 1): sum of timestamp deltas over the number of block steps.
 * The timestamp has 1 s resolution, so a single step says nothing; the sum over many steps is the estimate.
 */
export function blockStats(s: ViewState): BlockStats {
  return cached(s, "blockStats", () => {
    const rows = blockRows(s);
    const counts = rows.map((r) => r.evals).filter((n) => n > 0);
    let dt = 0, db = 0;
    for (const r of rows) if (r.dBlk === 1 && r.dTs !== undefined && r.dTs >= 0) { dt += r.dTs; db++; }
    return { blocks: rows.filter((r) => r.evals > 0).length, evals: counts.reduce((a, b) => a + b, 0), median: median(counts), max: counts.length ? Math.max(...counts) : null, intervalMs: db >= 5 ? (dt * 1000) / db : null, intervalBlocks: db };
  });
}

export function latencyPct(s: ViewState, p: number): number | null {
  if (!s.latencyN) return null;
  const keys = [...s.latency.keys()].sort((a, b) => a - b);
  let acc = 0; const target = Math.ceil(s.latencyN * p);
  for (const k of keys) { acc += s.latency.get(k)!; if (acc >= target) return k * 100 + 50; }
  return s.latencyMax;
}

export type SortKey = "dev" | "confirm";
export function sortedCands(s: ViewState, key: SortKey, desc: boolean): Cand[] {
  return cached(s, `cands:${key}:${desc}`, () => {
    const v = (c: Cand) => (key === "dev" ? c.dev : c.confirm);
    const list = [...s.cands.values()].filter((c) => v(c) !== undefined || key === "dev" && c.status !== "sent");
    list.sort((a, b) => {
      const x = v(a), y = v(b);
      if (x === undefined && y === undefined) return a.gen - b.gen || a.idx - b.idx;
      if (x === undefined) return 1;
      if (y === undefined) return -1;
      return (desc ? y - x : x - y) || a.gen - b.gen || a.idx - b.idx;
    });
    return list;
  });
}

export function childCounts(s: ViewState): Map<string, number> {
  return cached(s, "kids", () => {
    const m = new Map<string, number>();
    for (const c of s.cands.values()) if (c.parent) { const k = ref(c.parent.gen, c.parent.idx); m.set(k, (m.get(k) ?? 0) + 1); }
    return m;
  });
}

/** Parent chain of a candidate, nearest first, as far as the stream (and the memory bound) lets us see. */
export function ancestry(s: ViewState, c: Cand, max = 8): Cand[] {
  const out: Cand[] = []; let cur: Cand | undefined = c;
  while (cur?.parent && out.length < max) { const p: Cand | undefined = s.cands.get(ref(cur.parent.gen, cur.parent.idx)); if (!p) break; out.push(p); cur = p; }
  return out;
}

export function spearman(pairs: [number, number][]): number | null {
  const n = pairs.length; if (n < 5) return null;
  const rank = (xs: number[]) => { const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]); const r = new Array<number>(n); for (let i = 0; i < n;) { let j = i; while (j + 1 < n && idx[j + 1]![0] === idx[i]![0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k]![1]] = avg; i = j + 1; } return r; };
  const a = rank(pairs.map((p) => p[0])), b = rank(pairs.map((p) => p[1]));
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i]! - ma) * (b[i]! - mb); saa += (a[i]! - ma) ** 2; sbb += (b[i]! - mb) ** 2; }
  return saa === 0 || sbb === 0 ? null : sab / Math.sqrt(saa * sbb);
}

export interface Generalization {
  n: number; nSealed: number; medianDev: number | null; medianConfirm: number | null; medianGap: number | null;
  positive: number; rho: number | null; failed: { reverted: number; lost: number };
  rows: Cand[];
}
/** Candidates that reached confirm, with the dev -> confirm gap statistics. */
export function generalization(s: ViewState): Generalization {
  return cached(s, "gen", () => {
    const rows = [...s.cands.values()].filter((c) => c.confirm !== undefined && c.dev !== undefined);
    const gaps = rows.map((c) => c.confirm! - c.dev!);
    let reverted = 0, lost = 0;
    for (const c of s.cands.values()) if (c.confirmFail === "reverted") reverted++; else if (c.confirmFail === "lost") lost++;
    return {
      n: rows.length, nSealed: s.sealed ? 1 : 0, medianDev: median(rows.map((c) => c.dev!)), medianConfirm: median(rows.map((c) => c.confirm!)), medianGap: median(gaps),
      positive: rows.filter((c) => c.confirm! > 0).length, rho: spearman(rows.map((c) => [c.dev!, c.confirm!] as [number, number])), failed: { reverted, lost }, rows,
    };
  });
}

export function shares(w: Record<string, number> | null | undefined, keys: readonly string[]): (number | null)[] {
  if (!w) return keys.map(() => null);
  const tot = keys.reduce((a, k) => a + Math.max(0, w[k] ?? 0), 0);
  return keys.map((k) => (tot > 0 ? Math.max(0, w[k] ?? 0) / tot : null));
}
