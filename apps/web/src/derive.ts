// Pure selectors over State. Every figure is an event field or a plain count/ratio of event fields; nothing is estimated.
import type { State, Cand, BlockRow } from "./state";
import { ck } from "./state";

export const OPS = ["random", "mutate", "crossover", "sweep"] as const;
const sec = (ts: number) => (ts < 1e11 ? ts : ts / 1000);

export interface Burst { first: number; last: number; blocks: number; evals: number; dtS: number; msApart?: number }
export interface Lane {
  gen: number; rows: BlockRow[]; total: number; burst?: Burst;
  strag: { evals: number; blocks: number; lateBlocks: number };
  /** one entry per block row: gap in block numbers since the previous row (undefined for the first) */
  gaps: (number | undefined)[];
  dts: (number | undefined)[]; // ts delta in whole seconds since previous row
}
export function lanes(s: State): Lane[] {
  const by = new Map<number, BlockRow[]>();
  for (const b of s.blocks) { if (!by.has(b.gen)) by.set(b.gen, []); by.get(b.gen)!.push(b); }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([gen, rows]) => {
    const gaps = rows.map((r, i) => (i ? r.number - rows[i - 1]!.number : undefined));
    const dts = rows.map((r, i) => (i ? sec(r.ts) - sec(rows[i - 1]!.ts) : undefined));
    let end = 0;
    while (end + 1 < rows.length && (gaps[end + 1] ?? 0) <= 2) end++;
    const b = rows.slice(0, end + 1), st = rows.slice(end + 1);
    const burst: Burst | undefined = b.length ? {
      first: b[0]!.number, last: b[b.length - 1]!.number, blocks: b.length, evals: b.reduce((a, r) => a + r.evals, 0),
      dtS: sec(b[b.length - 1]!.ts) - sec(b[0]!.ts),
      msApart: b.length > 1 ? ((sec(b[b.length - 1]!.ts) - sec(b[0]!.ts)) * 1000) / (b.length - 1) : undefined,
    } : undefined;
    return { gen, rows, total: rows.reduce((a, r) => a + r.evals, 0), burst, gaps, dts, strag: { evals: st.reduce((a, r) => a + r.evals, 0), blocks: st.length, lateBlocks: st.length ? st[st.length - 1]!.number - b[b.length - 1]!.number : 0 } };
  });
}
/** true when block ts values are whole seconds (so "ms apart" is a mean over a window, not a measurement per block) */
export const coarseTs = (s: State) => s.blocks.length > 0 && s.blocks.every((b) => b.ts < 1e11);

export interface OpStat { op: number; sent: number; ok: number; best?: number; median?: number; share: number }
export function opStats(s: State): OpStat[] {
  const all = Object.values(s.cands);
  const tot = all.length || 1;
  return [0, 1, 2, 3].map((op) => {
    const m = all.filter((c) => c.op === op);
    const d = m.filter((c) => c.status === "success" && c.dev !== undefined).map((c) => c.dev!).sort((a, b) => a - b);
    return { op, sent: m.length, ok: d.length, best: d.length ? d[d.length - 1] : undefined, median: d.length ? (d.length % 2 ? d[(d.length - 1) / 2]! : (d[d.length / 2 - 1]! + d[d.length / 2]!) / 2) : undefined, share: m.length / tot };
  });
}
export function planGens(s: State) {
  return Object.keys(s.plan).map(Number).sort((a, b) => a - b).map((g) => {
    const counts = [0, 0, 0, 0];
    for (const a of s.plan[g]!) counts[a.operator] = a.count;
    return { gen: g, counts, total: counts.reduce((a, b) => a + b, 0), bandit: s.banditBy[g] };
  });
}

export interface GenRow { gen: number; idx: number; dev?: number; confirm?: number; sealed?: number; hash?: string; confirmHash?: string; sealedHash?: string }
export function generalization(s: State): { rows: GenRow[]; confirmed: number; attempts: number; failed: number } {
  const rows: GenRow[] = Object.values(s.confirms).map((c) => ({ gen: c.gen, idx: c.idx, dev: s.cands[ck(c.gen, c.idx)]?.dev, confirm: c.score, confirmHash: c.txHash, hash: s.cands[ck(c.gen, c.idx)]?.hash }));
  for (const z of s.sealedAll) {
    let r = rows.find((x) => x.gen === z.gen && x.idx === z.idx);
    if (!r) { r = { gen: z.gen, idx: z.idx }; rows.push(r); }
    r.dev = z.dev; r.confirm = z.confirm; r.sealed = z.score; r.sealedHash = z.txHash;
  }
  rows.sort((a, b) => a.gen - b.gen || a.idx - b.idx);
  const failed = s.errLog.filter((e) => e.scope === "confirm" && /revert|lost/i.test(e.message)).length;
  const confirmed = Object.keys(s.confirms).length;
  return { rows, confirmed, failed, attempts: confirmed + failed };
}

export interface HealthRow { scope: string; cls: "reverted" | "lost" | "other"; count: number; gens: number[]; sample: string }
export function health(s: State) {
  const cs = Object.values(s.cands);
  const sent = cs.length;
  const ok = cs.filter((c) => c.status === "success").length;
  const rev = cs.filter((c) => c.status === "reverted").length;
  const lost = cs.filter((c) => c.status === "lost").length;
  const pending = cs.filter((c) => !c.status).length;
  const map = new Map<string, HealthRow>();
  for (const e of s.errLog) {
    const cls = /revert/i.test(e.message) && !/0 reverted/.test(e.message) ? "reverted" : /\blost\b/i.test(e.message) ? "lost" : "other";
    const k = e.scope + "|" + (e.scope === "evaluate" ? "evaluate" : cls) + (cls === "other" ? "|" + e.message : "");
    const r = map.get(k) ?? { scope: e.scope, cls: (e.scope === "evaluate" ? "lost" : cls) as HealthRow["cls"], count: 0, gens: [], sample: e.message };
    r.count++; if (!r.gens.includes(e.gen)) r.gens.push(e.gen);
    map.set(k, r);
  }
  // evaluate-scope messages say "gen G: N tx lost, M reverted"; sum N for a tx count rather than an event count
  for (const r of map.values()) if (r.scope === "evaluate") {
    let n = 0;
    for (const e of s.errLog) if (e.scope === "evaluate") { const m = /(\d+) tx lost/.exec(e.message); if (m) n += Number(m[1]); }
    r.count = n || r.count;
  }
  const lat = cs.filter((c) => c.status === "success" && c.latencyMs !== undefined).map((c) => c.latencyMs!).sort((a, b) => a - b);
  const q = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]! : undefined);
  const confirmFail = s.errLog.filter((e) => e.scope === "confirm" && /revert|lost/i.test(e.message));
  return { sent, ok, rev, lost, pending, rows: [...map.values()].sort((a, b) => b.count - a.count), median: q(0.5), p90: q(0.9), max: lat.length ? lat[lat.length - 1] : undefined,
    confirmRev: confirmFail.filter((e) => /revert/i.test(e.message)).length, confirmLost: confirmFail.filter((e) => /\blost\b/i.test(e.message)).length,
    failedTotal: rev + lost + confirmFail.length };
}

export function cost(s: State) {
  const t = s.totals;
  const hist = s.totalsHist;
  const ok = Object.values(s.cands).filter((c) => c.status === "success").length;
  const gasUsed = [...new Set(Object.values(s.cands).map((c) => c.gasUsed).filter((g): g is number => g !== undefined))];
  return {
    gasMon: t?.gasMon, evals: t?.evals, reverted: t?.reverted, lost: t?.lost,
    perEval: t && t.evals ? t.gasMon / t.evals : undefined,
    evalsPerMon: t && t.gasMon ? t.evals / t.gasMon : undefined,
    okPerMon: t && t.gasMon ? ok / t.gasMon : undefined,
    gasUsed: gasUsed.length === 1 ? gasUsed[0] : undefined,
    series: hist.map((h) => ({ evals: h.evals, gas: h.gasMon })),
  };
}

export function bestSoFar(s: State) {
  const gens = Object.keys(s.ends).map(Number).sort((a, b) => a - b);
  let best: { gen: number; idx: number; dev: number } | undefined;
  for (const g of gens) { const b = s.ends[g]!.best; if (!best || b.dev > best.dev) best = { gen: g, idx: b.idx, dev: b.dev }; }
  const last = gens.length ? s.baselines[gens[gens.length - 1]!] : undefined;
  return { best, b1: last?.b1, b2: last?.b2, seeds: last?.seeds, gens: gens.length };
}

export const chain = (s: State, c: Cand | undefined): Cand[] => {
  const out: Cand[] = [];
  let cur = c;
  while (cur && out.length < 12) { out.push(cur); cur = cur.parent ? s.cands[ck(cur.parent.gen, cur.parent.idx)] : undefined; }
  return out;
};
export const children = (s: State, c: Cand) => Object.values(s.cands).filter((x) => x.parent && x.parent.gen === c.gen && x.parent.idx === c.idx);
export function rank(s: State, c: Cand) {
  const peers = Object.values(s.cands).filter((x) => x.gen === c.gen && x.status === "success" && x.dev !== undefined);
  if (c.dev === undefined) return undefined;
  return { rank: 1 + peers.filter((x) => x.dev! > c.dev!).length, of: peers.length };
}
