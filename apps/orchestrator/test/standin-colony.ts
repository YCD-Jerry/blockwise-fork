// Stand-in implementing the Colony interface (NOT the real one; lives here only to test the loop independently of packages/core).
import { mulberry32, specId, type Candidate, type Colony, type ColonyConfig, type EvalRecord, type Operator, type Ref } from "@blockwise/core";

export function standInColony(cfg: ColonyConfig): Colony {
  const rng = mulberry32(cfg.seed);
  const recs = new Map<string, EvalRecord>();
  const confirms = new Map<string, { score: number; trades: number }>();
  const seen = new Set<string>();
  const k = (r: Ref) => `${r.gen}:${r.idx}`;
  const map = (gen: number) => ({ type: "map" as const, gen, cells: [], discovery: {}, diagnostics: { ruggedness: null, plateau: 0, duplicates: 0 } });
  const best = () => [...recs.values()].sort((a, b) => b.dev - a.dev)[0];
  return {
    planGeneration(gen) {
      const candidates: Candidate[] = [];
      while (candidates.length < cfg.perGeneration) {
        const spec = [...Array.from({ length: 6 }, () => Math.floor(rng() * 128) - 64), Math.floor(rng() * 400)];
        if (seen.has(specId(spec))) continue;
        seen.add(specId(spec));
        candidates.push({ gen, idx: candidates.length, spec, operator: (candidates.length % 4) as Operator });
      }
      return { allocation: [{ operator: 0, count: cfg.perGeneration }], candidates };
    },
    recordDev(r) { recs.set(k(r), r); return { discovered: false }; },
    endGeneration(gen) {
      const b = best()!;
      return { best: { idx: b.idx, dev: b.dev, params: [...b.spec] }, archive: [{ gen: b.gen, idx: b.idx, dev: b.dev, params: [...b.spec] }], bandit: { "0": 1 }, map: map(gen) };
    },
    confirmCandidates() {
      return [...recs.values()].filter((r) => !confirms.has(k(r))).sort((a, b) => b.dev - a.dev).slice(0, cfg.confirmTopK).map((r) => ({ gen: r.gen, idx: r.idx, spec: r.spec, operator: r.operator, parent: r.parent }));
    },
    recordConfirm(ref, score, trades) { confirms.set(k(ref), { score, trades }); },
    champion() {
      let b: { r: EvalRecord; c: number } | null = null;
      for (const [key, c] of confirms) { const r = recs.get(key); if (r && (!b || c.score > b.c)) b = { r, c: c.score }; }
      return b ? { gen: b.r.gen, idx: b.r.idx, spec: b.r.spec, dev: b.r.dev, confirm: b.c } : null;
    },
    setFunding() {}, suggestedSplit: () => [],
    restore(rs, cs) { for (const r of rs) { recs.set(k(r), r); seen.add(specId(r.spec)); } for (const c of cs) confirms.set(k(c.ref), c); },
  };
}
