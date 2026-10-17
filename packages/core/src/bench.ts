// Offline helpers: honest controls and the ceiling proxy (architecture 3a, benchmark.md). Pure.
import { createColony } from "./colony-impl";
import { type Rng, int, mulberry32, normal } from "./rng";
import { randomSpec, mutate } from "./operators";
import { type Roles, confirm as confirmRun, dev as devRun, sealed as sealedRun } from "./strategy";
import { Archive, nicheOf } from "./archive";
import { type Spec, specId } from "./spec";

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2) : NaN; };
export const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); if (!s.length) return NaN; const i = (s.length - 1) * q; const lo = Math.floor(i), hi = Math.ceil(i); return s[lo]! + (s[hi]! - s[lo]!) * (i - lo); };

export interface BaselineOpts {
  returns: readonly number[]; roles: Roles; perGeneration: number; generations: number; seeds: number; seed: number;
}

/** Cumulative best dev per generation of pure random search at 1x and 2x budget; median over seeds. */
export function randomBaseline(o: BaselineOpts): { gen: number; bestRandom1x: number; bestRandom2xMedian: number; seeds: number }[] {
  const curves1: number[][] = [], curves2: number[][] = [];
  for (let s = 0; s < o.seeds; s++) {
    const rng = mulberry32(o.seed * 1000 + s + 1);
    let best = -Infinity, best2 = -Infinity;
    const c1: number[] = [], c2: number[] = [];
    for (let g = 0; g < o.generations; g++) {
      for (let i = 0; i < o.perGeneration; i++) best = Math.max(best, devRun(randomSpec(rng), o.returns, o.roles).pnl);
      for (let i = 0; i < 2 * o.perGeneration; i++) best2 = Math.max(best2, devRun(randomSpec(rng), o.returns, o.roles).pnl);
      c1.push(best); c2.push(best2);
    }
    curves1.push(c1); curves2.push(c2);
  }
  return Array.from({ length: o.generations }, (_, g) => ({
    gen: g, bestRandom1x: median(curves1.map((c) => c[g]!)), bestRandom2xMedian: median(curves2.map((c) => c[g]!)), seeds: o.seeds,
  }));
}

/** PROXY (not a proof): offline multi-start hill-climb with the mirror. Returns the best-by-dev spec's three scores. */
export function ceilingProxy(o: { returns: readonly number[]; roles: Roles; evals: number; seed: number }): { dev: number; confirm: number; sealed: number; evals: number } {
  const rng = mulberry32(o.seed ^ 0x9e3779b9);
  let used = 0;
  let best: { spec: Spec; dev: number } | null = null;
  const restartLen = Math.max(50, Math.floor(o.evals / 40));
  while (used < o.evals) {
    let cur = randomSpec(rng); let curDev = devRun(cur, o.returns, o.roles).pnl; used++;
    for (let i = 0; i < restartLen && used < o.evals; i++) {
      const c = mutate(cur, rng); const d = devRun(c, o.returns, o.roles).pnl; used++;
      if (d >= curDev) { cur = c; curDev = d; }
    }
    if (!best || curDev > best.dev) best = { spec: cur, dev: curDev };
  }
  const sp = best!.spec;
  return { dev: best!.dev, confirm: confirmRun(sp, o.returns, o.roles).pnl, sealed: sealedRun(sp, o.returns, o.roles).pnl, evals: used };
}

export type Arm = "portfolio" | "random1x" | "random2x" | "evo_niche";
export interface ArmResult { arm: Arm; seed: number; dev: number; confirm: number; sealed: number }

function finish(best: { spec: Spec } | null, r: readonly number[], roles: Roles, arm: Arm, seed: number): ArmResult {
  if (!best) return { arm, seed, dev: 0, confirm: 0, sealed: 0 };
  return { arm, seed, dev: devRun(best.spec, r, roles).pnl, confirm: confirmRun(best.spec, r, roles).pnl, sealed: sealedRun(best.spec, r, roles).pnl };
}

/** Champion = best confirm among the top-k dev candidates (same cascade for every arm). */
function randomArm(arm: "random1x" | "random2x", o: BenchOpts, seed: number): ArmResult {
  const rng = mulberry32(seed * 7 + 1);
  const B = o.perGeneration * o.generations * (arm === "random2x" ? 2 : 1);
  const pool: { spec: Spec; dev: number }[] = [];
  for (let i = 0; i < B; i++) { const spec = randomSpec(rng); pool.push({ spec, dev: devRun(spec, o.returns, o.roles).pnl }); }
  pool.sort((a, b) => b.dev - a.dev);
  const top = pool.slice(0, o.confirmTopK * o.generations);
  let ch = top[0] ?? null, cs = -Infinity;
  for (const t of top) { const c = confirmRun(t.spec, o.returns, o.roles).pnl; if (c > cs) { cs = c; ch = t; } }
  return finish(ch, o.returns, o.roles, arm, seed);
}

function evoNicheArm(o: BenchOpts, seed: number): ArmResult {
  const rng = mulberry32(seed * 11 + 3);
  const arc = new Archive(); const seen = new Set<string>();
  let idx = 0;
  for (let g = 0; g < o.generations; g++) {
    const elites = arc.elites();
    for (let i = 0; i < o.perGeneration; i++) {
      const spec = elites.length && g > 0 && rng() > 0.2 ? mutate(elites[int(rng, 0, elites.length - 1)]!.spec, rng) : randomSpec(rng);
      const id = specId(spec); if (seen.has(id)) continue; seen.add(id);
      const r = devRun(spec, o.returns, o.roles);
      arc.insert({ gen: g, idx: idx++, dev: r.pnl, trades: r.trades, spec });
    }
  }
  const top = arc.elites().sort((a, b) => b.dev - a.dev).slice(0, o.confirmTopK);
  let ch: { spec: Spec } | null = top[0] ?? null, cs = -Infinity;
  for (const t of top) { const c = confirmRun(t.spec, o.returns, o.roles).pnl; if (c > cs) { cs = c; ch = t; } }
  return finish(ch, o.returns, o.roles, "evo_niche", seed);
}

export interface BenchOpts {
  returns: readonly number[]; roles: Roles; perGeneration: number; generations: number; confirmTopK: number; seeds: number;
}

function portfolioArm(o: BenchOpts, seed: number): ArmResult {
  const col = createColony({ seed, perGeneration: o.perGeneration, generations: o.generations, confirmTopK: o.confirmTopK, roles: o.roles, returns: o.returns });
  for (let g = 0; g < o.generations; g++) {
    const plan = col.planGeneration(g);
    for (const c of plan.candidates) { const r = devRun(c.spec, o.returns, o.roles); col.recordDev({ ...c, dev: r.pnl, trades: r.trades }); }
    col.endGeneration(g);
    for (const c of col.confirmCandidates()) { const r = confirmRun(c.spec, o.returns, o.roles); col.recordConfirm({ gen: c.gen, idx: c.idx }, r.pnl, r.trades); }
  }
  return finish(col.champion(), o.returns, o.roles, "portfolio", seed);
}

export interface ArmSummary { arm: Arm; n: number; dev: Stat; confirm: Stat; sealed: Stat }
export interface Stat { median: number; q1: number; q3: number }
const stat = (xs: number[]): Stat => ({ median: median(xs), q1: quantile(xs, 0.25), q3: quantile(xs, 0.75) });

/** Equal-budget comparison over seeds 1..seeds. Medians and IQR; dev is reported, never used to rank. */
export function runOfflineBenchmark(o: BenchOpts): { arms: ArmSummary[]; results: ArmResult[]; pairedWins: Record<string, number> } {
  const results: ArmResult[] = [];
  for (let s = 1; s <= o.seeds; s++) {
    results.push(portfolioArm(o, s), randomArm("random1x", o, s), randomArm("random2x", o, s), evoNicheArm(o, s));
  }
  const arms = (["portfolio", "random1x", "random2x", "evo_niche"] as Arm[]).map((arm) => {
    const rs = results.filter((r) => r.arm === arm);
    return { arm, n: rs.length, dev: stat(rs.map((r) => r.dev)), confirm: stat(rs.map((r) => r.confirm)), sealed: stat(rs.map((r) => r.sealed)) };
  });
  const sealedOf = (arm: Arm, s: number) => results.find((r) => r.arm === arm && r.seed === s)!.sealed;
  const pairedWins: Record<string, number> = {};
  for (const other of ["random2x", "random1x", "evo_niche"] as Arm[]) {
    let w = 0; for (let s = 1; s <= o.seeds; s++) if (sealedOf("portfolio", s) > sealedOf(other, s)) w++;
    pairedWins[`portfolio>${other}`] = w;
  }
  return { arms, results, pairedWins };
}
void nicheOf; void normal;
