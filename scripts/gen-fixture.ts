// Synthetic replay fixture: a 10-generation Colony run against the TS mirror with fake landing blocks.
// Output: fixtures/events.sample.jsonl  (one BlockwiseEvent per line, mode "replay", labelled synthetic in hello).
// Run: bun run scripts/gen-fixture.ts
import { type BlockwiseEvent, type Operator, authorityFor, brier, brierBaseline, ceilingProxy, createColony, confirm as confirmRun, dev as devRun, mulberry32, randomBaseline, sealed as sealedRun, type Resolved, type Rng } from "../packages/core/src";

const series = await Bun.file("data/series/v1.json").json();
const roles = { devEnd: series.devEnd, confirmEnd: series.confirmEnd };
const GENS = 10, N = 200, TOPK = 8, WORKERS = 20;
const rng: Rng = mulberry32(424242);
const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rng() * 16)]).join("");
const hash = () => "0x" + hex(64);
const wallets = Array.from({ length: WORKERS }, () => "0x" + hex(40));
const out: BlockwiseEvent[] = [];
const emit = (e: BlockwiseEvent) => out.push(e);

emit({
  type: "hello", epoch: "0x" + "5e".repeat(32), chainId: 10143,
  contracts: { evaluator: "0x" + "0".repeat(39) + "1", ledger: "0x" + "0".repeat(39) + "2", judgeLog: "0x" + "0".repeat(39) + "3" },
  config: { n: series.n, devEnd: roles.devEnd, confirmEnd: roles.confirmEnd, workers: WORKERS, perGeneration: N, generations: GENS },
  mode: "replay", model: "stand-in", explorer: "https://explorer.example.invalid/SYNTHETIC-FIXTURE",
});

const colony = createColony({ seed: 7, perGeneration: N, generations: GENS, confirmTopK: TOPK, roles, returns: series.returns });
const baseline = randomBaseline({ returns: series.returns, roles, perGeneration: N, generations: GENS, seeds: 20, seed: 99 });
const resolved: Resolved[] = [];
let block = 71_750_000, ts = 1_792_236_000_000;
let evals = 0, reverted = 0, lost = 0, gasMon = 0, blocksSpanned = 0, jevUsd = 0, funded = 0;
const fundedBy: Record<string, number> = {};
const THRESH = 300;
const confirmHash = new Map<string, string>();

for (let g = 0; g < GENS; g++) {
  const plan = colony.planGeneration(g);
  emit({ type: "generation_start", gen: g, planned: plan.candidates.length, allocation: plan.allocation });
  // stand-in judge: 5 predictions logged BEFORE sending (shadow; nothing here affects a score)
  for (const c of plan.candidates.slice(0, 5)) {
    const actual = devRun(c.spec, series.returns, roles).pnl;
    const pBps = Math.max(500, Math.min(9500, Math.round(3500 + (c.parent ? 1500 : 0) + (rng() - 0.5) * 3000)));
    resolved.push({ pBps, outcome: actual > THRESH });
    emit({ type: "judge", gen: g, idx: c.idx, threshold: THRESH, pBps, latencyMs: 600 + Math.floor(rng() * 900), usd: 0.0021, model: "stand-in" });
    jevUsd += 0.0021;
  }
  const txs = plan.candidates.map((c) => ({ c, txHash: hash(), wallet: wallets[c.idx % WORKERS]! }));
  for (const t of txs) emit({ type: "tx_sent", gen: g, idx: t.c.idx, operator: t.c.operator as Operator, ...(t.c.parent ? { parent: t.c.parent } : {}), wallet: t.wallet, txHash: t.txHash, params: [...t.c.spec] });
  // landing: 3 to 6 consecutive blocks
  const nb = 3 + Math.floor(rng() * 4);
  const first = block + 1;
  const buckets: typeof txs[] = Array.from({ length: nb }, () => []);
  txs.forEach((t) => buckets[Math.min(nb - 1, Math.floor(rng() * rng() * nb * 1.6 + rng() * 0.5))]!.push(t));
  const hist: Record<string, number> = {};
  for (let b = 0; b < nb; b++) {
    block++; ts += 380 + Math.floor(rng() * 40);
    for (const t of buckets[b]!) {
      const isRev = g === 1 && t.c.idx === 7, isLost = g === 3 && t.c.idx === 11;
      if (isLost) { lost++; emit({ type: "tx_landed", gen: g, idx: t.c.idx, txHash: t.txHash, block: 0, status: "lost" }); continue; }
      if (isRev) { reverted++; evals++; emit({ type: "tx_landed", gen: g, idx: t.c.idx, txHash: t.txHash, block, status: "reverted", gasUsed: 21000, latencyMs: 700 }); continue; }
      const r = devRun(t.c.spec, series.returns, roles);
      colony.recordDev({ gen: g, idx: t.c.idx, spec: t.c.spec, operator: t.c.operator, ...(t.c.parent ? { parent: t.c.parent } : {}), dev: r.pnl, trades: r.trades });
      const gasUsed = 92_000 + Math.floor(rng() * 6000);
      gasMon += (gasUsed * 100e9) / 1e18; evals++;
      emit({ type: "tx_landed", gen: g, idx: t.c.idx, txHash: t.txHash, block, status: "success", dev: r.pnl, trades: r.trades, gasUsed, latencyMs: 400 * (b + 1) + Math.floor(rng() * 300) });
      hist[String(block)] = (hist[String(block)] ?? 0) + 1;
    }
    emit({ type: "block", number: block, ts, evalsLanded: buckets[b]!.length });
  }
  blocksSpanned += nb;
  const end = colony.endGeneration(g);
  emit({ type: "generation_end", gen: g, best: end.best, archive: end.archive, bandit: end.bandit, blocks: { first, last: block, span: nb, histogram: hist } });
  // top-k confirm
  for (const c of colony.confirmCandidates()) {
    const r = confirmRun(c.spec, series.returns, roles);
    colony.recordConfirm({ gen: c.gen, idx: c.idx }, r.pnl, r.trades);
    const h = hash(); confirmHash.set(`${c.gen}:${c.idx}`, h);
    emit({ type: "confirm", gen: c.gen, idx: c.idx, score: r.pnl, trades: r.trades, txHash: h });
  }
  const map = end.map;
  if (g === GENS - 1) map.ceilingProxy = ceilingProxy({ returns: series.returns, roles, evals: 20000, seed: 5 });
  emit(map);
  emit({ type: "baseline", ...baseline[g]! });
  emit({ type: "calibration", n: resolved.length, brier: brier(resolved), brierBaseline: brierBaseline(resolved), authority: authorityFor(resolved) });
  // synthetic funding after generations 3 and 5: steers later generations (test MON, virtual)
  if (g === 3 || g === 5) {
    const pick = colony.suggestedSplit()[g === 3 ? 0 : 1] ?? colony.suggestedSplit()[0];
    if (pick) {
      const amt = g === 3 ? 6 : 4; const k = `${pick.agent.gen}:${pick.agent.idx}`;
      funded += amt; fundedBy[k] = (fundedBy[k] ?? 0) + amt; colony.setFunding({ ...fundedBy });
      emit({ type: "allocation", wallet: "0x" + hex(40), agent: pick.agent, amount: amt.toFixed(1), txHash: hash(), funded: { total: funded.toFixed(1), byAgent: Object.fromEntries(Object.entries(fundedBy).map(([a, b]) => [a, b.toFixed(1)])) } });
    }
  }
  emit({ type: "totals", evals, reverted, lost, gasMon: Number(gasMon.toFixed(6)), jevUsd: Number(jevUsd.toFixed(4)), blocksSpanned });
}
const ch = colony.champion();
if (ch) {
  const s = sealedRun(ch.spec, series.returns, roles);
  emit({ type: "sealed", gen: ch.gen, idx: ch.idx, dev: ch.dev, confirm: ch.confirm, score: s.pnl, trades: s.trades, txHash: hash() });
}
await Bun.write("fixtures/events.sample.jsonl", out.map((e) => JSON.stringify(e)).join("\n") + "\n");
const types = new Set(out.map((e) => e.type));
console.log(`wrote fixtures/events.sample.jsonl: ${out.length} events, types: ${[...types].join(",")}`);
