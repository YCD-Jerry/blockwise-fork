// In-browser stand-in event generator. Follows packages/core/src/events.ts exactly. Seeded, no Math.random.
import type { BlockwiseEvent as E } from "../../../packages/core/src/events";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hex = (r: () => number, n: number) => "0x" + Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join("");

export function demoEvents(): E[] {
  const r = rng(7);
  const out: E[] = [];
  const G = 10, PER = 200;
  out.push({
    type: "hello", epoch: "0x3fa9" + hex(r, 8).slice(2), chainId: 10143,
    contracts: { evaluator: hex(r, 40), ledger: hex(r, 40) },
    config: { n: 4096, devEnd: 2048, confirmEnd: 3072, workers: 10, perGeneration: PER, generations: G },
    mode: "replay", model: "stand-in", explorer: "https://testnet.monadexplorer.com",
  });
  let block = 71750141, ts = 1760000000000, evals = 0, gas = 0;
  let best = 20;
  const archive: { gen: number; idx: number; dev: number; params: number[] }[] = [];
  for (let g = 1; g <= G; g++) {
    out.push({ type: "generation_start", gen: g, planned: PER, allocation: [{ operator: 0, count: 50 }, { operator: 1, count: 80 }, { operator: 2, count: 50 }, { operator: 3, count: 20 }] });
    const landed: { idx: number; dev: number; params: number[]; blk: number }[] = [];
    const sent: E[] = [];
    const land: E[] = [];
    const hist: Record<string, number> = {};
    const nb = 3 + Math.floor(r() * 2);
    for (let i = 0; i < PER; i++) {
      const op = (i < 50 ? 0 : i < 130 ? 1 : i < 180 ? 2 : 3) as 0 | 1 | 2 | 3;
      const params = Array.from({ length: 7 }, () => Math.floor(r() * 64) - 32);
      const tx = hex(r, 64);
      sent.push({ type: "tx_sent", gen: g, idx: i, operator: op, wallet: hex(r, 40), txHash: tx, params });
      const blk = block + 1 + Math.floor((i / PER) * nb);
      const dev = Math.round((Math.pow(r(), 2) * (60 + g * 38) + g * 12 - 40) * 10) / 10;
      const reverted = r() < 0.01;
      land.push({ type: "tx_landed", gen: g, idx: i, txHash: tx, block: blk, status: reverted ? "reverted" : "success", dev: reverted ? undefined : dev, trades: 12 + Math.floor(r() * 40), gasUsed: 180000, latencyMs: 400 + Math.floor(r() * 900) });
      hist[blk] = (hist[blk] ?? 0) + 1;
      gas += 0.0004; evals++;
      if (!reverted) landed.push({ idx: i, dev, params, blk });
    }
    // interleave: sends then landings, block events between
    for (const s of sent) out.push(s);
    for (let b = 1; b <= nb; b++) {
      const bn = block + b;
      const these = land.filter((e) => e.type === "tx_landed" && e.block === bn);
      for (const e of these) out.push(e);
      ts += 400;
      out.push({ type: "block", number: bn, ts, evalsLanded: these.length });
    }
    block += nb + 1; ts += 2400;
    landed.sort((a, b) => b.dev - a.dev);
    const top = landed[0]!;
    best = Math.max(best, top.dev);
    for (const l of landed.slice(0, 3)) archive.push({ gen: g, idx: l.idx, dev: l.dev, params: l.params });
    archive.sort((a, b) => b.dev - a.dev); archive.length = Math.min(archive.length, 8);
    const keys = Object.keys(hist).map(Number);
    out.push({ type: "generation_end", gen: g, best: { idx: top.idx, dev: top.dev, params: top.params }, archive: archive.map((a) => ({ ...a })), bandit: { "0": 1, "1": 1.4, "2": 1.1, "3": 0.8 }, blocks: { first: Math.min(...keys), last: Math.max(...keys), span: nb, histogram: hist } });
    const dev0 = archive[0]!.dev;
    out.push({ type: "baseline", gen: g, bestRandom1x: Math.round((30 + g * 6 + (r() - 0.5) * 8) * 10) / 10, bestRandom2xMedian: Math.round((38 + g * 8 + (r() - 0.5) * 8) * 10) / 10, seeds: 20 });
    const styles = ["reversion", "neutral", "momentum"] as const, acts = ["low", "mid", "high"] as const;
    const labels = ["young", "leader", "riser", "stalled"] as const;
    out.push({ type: "map", gen: g, cells: styles.flatMap((st, si) => acts.map((ac, ai) => ({ style: st, activity: ac, elite: (g + si * 3 + ai) % 7 === 0 && g < 4 ? null : { gen: Math.max(1, g - ((si + ai) % 3)), idx: (si * 17 + ai * 31) % PER, dev: Math.round(dev0 * (0.45 + 0.55 * ((si * 3 + ai * 7) % 9) / 9) * 10) / 10 }, label: labels[(si + ai + g) % 4]! }))), discovery: { "0": 0.1, "1": 0.2 }, diagnostics: { ruggedness: 0.4, plateau: 0, duplicates: 2 }, ceilingProxy: g >= 5 ? { dev: dev0 * 1.3, confirm: dev0 * 0.6, sealed: dev0 * 0.2, evals: evals * 5 } : undefined });
    for (let j = 0; j < 4; j++) out.push({ type: "judge", gen: g, idx: j, threshold: 50, pBps: 3000 + Math.floor(r() * 4000), latencyMs: 900, usd: 0.0003, model: "stand-in" });
    out.push({ type: "calibration", n: g * 4, brier: Math.max(0.12, 0.26 - g * 0.012), brierBaseline: 0.25, authority: "shadow" });
    const c = archive[0]!;
    const conf = Math.round(c.dev * (0.45 + (r() - 0.5) * 0.2) * 10) / 10;
    out.push({ type: "confirm", gen: g, idx: c.idx, score: conf, trades: 30, txHash: hex(r, 64) });
    if (g === G) out.push({ type: "sealed", gen: g, idx: c.idx, dev: c.dev, confirm: conf, score: Math.round(conf * -0.25 * 10) / 10, trades: 28, txHash: hex(r, 64) });
    out.push({ type: "totals", evals, reverted: Math.floor(evals * 0.01), lost: 0, gasMon: Math.round(gas * 1000) / 1000, jevUsd: Math.round(g * 4 * 0.0003 * 10000) / 10000, blocksSpanned: g * nb });
  }
  return out;
}
