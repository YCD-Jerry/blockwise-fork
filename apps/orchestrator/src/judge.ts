// MOCK judge. Model label is "stand-in": a deterministic heuristic, NOT an LLM, no API key used.
// Shadow only: nothing here changes a score, the grammar or a sealed look.
import { dev as devScore } from "@blockwise/core";

export function standInJudge(spec: readonly number[], returns: readonly number[], devEnd: number) {
  const t0 = Date.now();
  // crude prior: score the spec on the first half of the dev range; predict P(full dev score > threshold) from it.
  const half = devScore(spec, returns, { devEnd: Math.floor(devEnd / 2) + 8, confirmEnd: devEnd }).pnl;
  const threshold = 0;
  const pBps = Math.max(500, Math.min(9500, Math.round(5000 + half * 40)));
  return { threshold, pBps, latencyMs: Date.now() - t0, usd: 0, model: "stand-in" as const };
}
