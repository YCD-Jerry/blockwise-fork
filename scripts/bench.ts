// Offline benchmark: portfolio vs random 1x/2x vs evo_niche. Usage: bun run scripts/bench.ts [seeds] [perGeneration] [generations]
import { ceilingProxy, runOfflineBenchmark } from "../packages/core/src";
const series = await Bun.file("data/series/v1.json").json();
const roles = { devEnd: series.devEnd, confirmEnd: series.confirmEnd };
const seeds = Number(process.argv[2] ?? 12), perGeneration = Number(process.argv[3] ?? 100), generations = Number(process.argv[4] ?? 6);
const t0 = Date.now();
const out = runOfflineBenchmark({ returns: series.returns, roles, perGeneration, generations, confirmTopK: 8, seeds });
const f = (s: { median: number; q1: number; q3: number }) => `${s.median.toFixed(1)} [${s.q1.toFixed(1)}, ${s.q3.toFixed(1)}]`;
console.log(`Offline benchmark (TS mirror, synthetic series, ${seeds} seeds, ${perGeneration}x${generations} dev evals per arm; random2x gets double). Median [IQR] in bp.`);
console.log("arm".padEnd(11), "dev".padEnd(24), "confirm".padEnd(24), "sealed");
for (const a of out.arms) console.log(a.arm.padEnd(11), f(a.dev).padEnd(24), f(a.confirm).padEnd(24), f(a.sealed));
console.log("paired sealed wins (of", seeds + "):", JSON.stringify(out.pairedWins));
const c = ceilingProxy({ returns: series.returns, roles, evals: 20000, seed: 1 });
console.log("ceiling PROXY (20k-eval multi-start hill-climb, not a proof):", JSON.stringify(c));
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s. Dev is never used to rank arms; one primary comparison: portfolio vs random2x on sealed.`);
