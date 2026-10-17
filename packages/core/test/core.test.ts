import { describe, expect, test } from "bun:test";
import golden from "../../../data/golden.json";
import series from "../../../data/series/v1.json";
import {
  type EvalRecord, brier, brierBaseline, authorityFor, AUTHORITY_LADDER, capSplit, confirm as confirmRun, createColony, crossover, dev as devRun,
  isValid, mulberry32, mutate, randomSpec, run, sealed as sealedRun, specId, sweep, validate,
} from "../src";

const roles = { devEnd: series.devEnd, confirmEnd: series.confirmEnd };
const R = series.returns;
const cfg = (seed = 1, over: object = {}) => ({ seed, perGeneration: 60, generations: 6, confirmTopK: 8, roles, returns: R, ...over });

function drive(col: ReturnType<typeof createColony>, gens: number, evalFn?: (c: { operator: number; spec: readonly number[] }) => { dev: number; trades: number }) {
  const all: EvalRecord[] = [];
  const plans: string[] = [];
  const confs: { ref: { gen: number; idx: number }; score: number; trades: number }[] = [];
  for (let g = 0; g < gens; g++) {
    const plan = col.planGeneration(g);
    plans.push(JSON.stringify(plan));
    for (const c of plan.candidates) {
      const r = evalFn ? evalFn(c) : (() => { const x = devRun(c.spec, R, roles); return { dev: x.pnl, trades: x.trades }; })();
      const rec: EvalRecord = { gen: c.gen, idx: c.idx, spec: c.spec, operator: c.operator, ...(c.parent ? { parent: c.parent } : {}), dev: r.dev, trades: r.trades };
      all.push(rec); col.recordDev(rec);
    }
    col.endGeneration(g);
    for (const c of col.confirmCandidates()) { const r = confirmRun(c.spec, R, roles); col.recordConfirm({ gen: c.gen, idx: c.idx }, r.pnl, r.trades); confs.push({ ref: { gen: c.gen, idx: c.idx }, score: r.pnl, trades: r.trades }); }
  }
  return { all, plans, confs };
}

describe("golden conformance", () => {
  test("all cases, all three roles, pnl and trades", () => {
    expect(golden.cases.length).toBe(200);
    const gr = { devEnd: golden.devEnd, confirmEnd: golden.confirmEnd };
    for (const c of golden.cases) {
      const d = devRun(c.spec, golden.returns, gr), cf = confirmRun(c.spec, golden.returns, gr), s = sealedRun(c.spec, golden.returns, gr);
      expect([d.pnl, d.trades, cf.pnl, cf.trades, s.pnl, s.trades]).toEqual([c.dev, c.devTrades, c.confirm, c.confirmTrades, c.sealed, c.sealedTrades]);
      expect(run(c.spec, golden.returns, 6, gr.devEnd).pnl).toBe(c.dev);
    }
  });
});

describe("operators", () => {
  test("every output is valid, across many seeds", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rng = mulberry32(seed);
      const a = randomSpec(rng), b = randomSpec(rng);
      expect(validate(a)).toBeNull();
      expect(isValid(mutate(a, rng))).toBe(true);
      expect(isValid(crossover(a, b, rng))).toBe(true);
      const s = sweep(a, rng); expect(isValid(s.spec)).toBe(true);
      // edge parents at the boundary
      for (const edge of [[-64, -64, -64, -64, -64, -64, 0], [63, 63, 63, 63, 63, 63, 8191]]) {
        expect(isValid(mutate(edge, rng))).toBe(true);
        expect(isValid(sweep(edge, rng).spec)).toBe(true);
        expect(isValid(crossover(edge, a, rng))).toBe(true);
      }
    }
  });
  test("mutate and sweep change the parent; sweep changes one coordinate", () => {
    const rng = mulberry32(5);
    for (let i = 0; i < 200; i++) {
      const p = randomSpec(rng);
      expect(specId(mutate(p, rng))).not.toBe(specId(p));
      const s = sweep(p, rng).spec;
      expect(s.filter((v, k) => v !== p[k]).length).toBe(1);
    }
  });
});

describe("colony", () => {
  test("planned candidates are valid, N long, lineage recorded, ops in range", () => {
    const col = createColony(cfg());
    const { all } = drive(col, 4);
    expect(all.length).toBe(240);
    for (const r of all) { expect(isValid(r.spec)).toBe(true); expect([0, 1, 2, 3]).toContain(r.operator); if (r.operator !== 0) expect(r.parent).toBeDefined(); }
    expect(all.filter((r) => r.gen === 0).every((r) => r.operator === 0)).toBe(true);
  });

  test("determinism: same seed => identical plans; different seed differs", () => {
    const a = drive(createColony(cfg(3)), 5), b = drive(createColony(cfg(3)), 5), c = drive(createColony(cfg(4)), 5);
    expect(a.plans).toEqual(b.plans);
    expect(a.plans).not.toEqual(c.plans);
  });

  test("duplicates are never re-planned", () => {
    const col = createColony(cfg(2, { perGeneration: 100 }));
    const seen = new Set<string>();
    drive(col, 6);
    for (let g = 0; g < 6; g++) for (const c of col.planGeneration(g).candidates) { const id = specId(c.spec); expect(seen.has(id)).toBe(false); seen.add(id); }
  });

  test("a useless operator's share decays to the floor", () => {
    const col = createColony(cfg(9, { perGeneration: 200, generations: 12 }));
    const shares: number[] = [];
    const fn = (c: { operator: number; spec: readonly number[] }) => { const x = devRun(c.spec, R, roles); return { dev: c.operator === 2 ? -100000 : x.pnl, trades: x.trades }; };
    for (let g = 0; g < 12; g++) {
      const plan = col.planGeneration(g);
      shares.push(plan.allocation.find((a) => a.operator === 2)!.count / 200);
      for (const c of plan.candidates) { const r = fn(c); col.recordDev({ gen: c.gen, idx: c.idx, spec: c.spec, operator: c.operator, ...(c.parent ? { parent: c.parent } : {}), dev: r.dev, trades: r.trades }); }
      col.endGeneration(g);
    }
    const tail = shares.slice(-6).sort((a, b) => a - b);
    expect(tail[2]!).toBeLessThan(0.12); // median; stagnation bursts (by design) lift single generations
    expect(Math.min(...shares.slice(1))).toBeGreaterThanOrEqual(0.04); // floor ~5% (rounding)
  });

  test("planted overfitter: champion is chosen on confirm, not dev", () => {
    const col = createColony(cfg(1));
    const plan = col.planGeneration(0);
    const [a, b] = plan.candidates;
    col.recordDev({ gen: 0, idx: a!.idx, spec: a!.spec, operator: 0, dev: 9000, trades: 12 });
    col.recordDev({ gen: 0, idx: b!.idx, spec: b!.spec, operator: 0, dev: 500, trades: 12 });
    col.endGeneration(0);
    col.recordConfirm({ gen: 0, idx: a!.idx }, -400, 12);
    col.recordConfirm({ gen: 0, idx: b!.idx }, 200, 12);
    const ch = col.champion()!;
    expect(ch.idx).toBe(b!.idx); expect(ch.dev).toBe(500); expect(ch.confirm).toBe(200);
  });

  test("champion null before any confirm; confirmCandidates are top-k and shrink after looks", () => {
    const col = createColony(cfg(1, { confirmTopK: 3 }));
    expect(col.champion()).toBeNull();
    drive(col, 1);
    // drive already confirmed; a fresh colony shows candidates first
    const c2 = createColony(cfg(1, { confirmTopK: 3 }));
    const plan = c2.planGeneration(0);
    for (const c of plan.candidates) { const x = devRun(c.spec, R, roles); c2.recordDev({ ...c, dev: x.pnl, trades: x.trades }); }
    c2.endGeneration(0);
    const cc = c2.confirmCandidates();
    expect(cc.length).toBeLessThanOrEqual(3); expect(cc.length).toBeGreaterThan(0);
    c2.recordConfirm({ gen: cc[0]!.gen, idx: cc[0]!.idx }, 1, 1);
    expect(c2.confirmCandidates().length).toBe(cc.length - 1);
  });

  test("recordDev is idempotent per (gen, idx)", () => {
    const col = createColony(cfg());
    const c = col.planGeneration(0).candidates[0]!;
    const rec = { ...c, dev: 100, trades: 10 };
    expect(col.recordDev(rec).discovered).toBe(true);
    expect(col.recordDev(rec).discovered).toBe(false);
  });

  test("endGeneration returns a complete map event with nine cells", () => {
    const col = createColony(cfg());
    drive(col, 3);
    const e = col.endGeneration(2);
    expect(e.map.type).toBe("map"); expect(e.map.cells.length).toBe(9);
    expect(Object.keys(e.map.discovery).sort()).toEqual(["crossover", "mutate", "random", "sweep"]);
    expect(e.map.diagnostics.plateau).toBeGreaterThanOrEqual(0);
    expect(e.archive.length).toBe(e.map.cells.filter((c) => c.elite).length);
    expect(Object.keys(e.bandit).length).toBe(4);
  });

  test("restore() == incremental state (duplicates and shuffled records allowed)", () => {
    const col = createColony(cfg(6));
    const { all, confs: all_confs } = drive(col, 4);
    const confs = all_confs;
    const fresh = createColony(cfg(6));
    const rng = mulberry32(1);
    const shuffled = [...all, ...all.slice(0, 50)].sort(() => rng() - 0.5);
    fresh.restore(shuffled, confs);
    const again = createColony(cfg(6)); again.restore(shuffled, confs); again.restore(shuffled, confs);
    const st = (c: unknown) => JSON.stringify((c as { state(): unknown }).state());
    expect(st(fresh)).toBe(st(col));
    expect(st(again)).toBe(st(col));
    expect(JSON.stringify(fresh.planGeneration(4))).toBe(JSON.stringify(col.planGeneration(4)));
    expect(fresh.champion()).toEqual(col.champion());
  });

  test("funding steering: share phi = min(0.25, F/(F+10)), half mutate / half sweep of funded agents", () => {
    const col = createColony(cfg(2, { perGeneration: 200 }));
    drive(col, 3);
    const funded = col.confirmCandidates()[0] ?? col.planGeneration(0).candidates[0]!;
    const key = `${funded.gen}:${funded.idx}`;
    col.setFunding({ [key]: 10 }); // F=10 => phi = 0.5 -> capped 0.25 => 50 slots
    const plan = col.planGeneration(3);
    const steered = plan.candidates.filter((c) => c.parent && c.parent.gen === funded.gen && c.parent.idx === funded.idx);
    expect(steered.length).toBeGreaterThanOrEqual(50);
    expect(steered.filter((c) => c.operator === 1).length).toBeGreaterThanOrEqual(25);
    expect(steered.filter((c) => c.operator === 3).length).toBeGreaterThanOrEqual(25);
    const col2 = createColony(cfg(2, { perGeneration: 200 })); drive(col2, 3);
    col2.setFunding({ [key]: 2 }); // phi = 2/12
    const p2 = col2.planGeneration(3).candidates.filter((c) => c.parent && c.parent.gen === funded.gen && c.parent.idx === funded.idx);
    expect(p2.length).toBeGreaterThanOrEqual(33);
    expect(p2.length).toBeLessThan(50);
  });

  test("suggested split: proportional to max(0, c - g/2), cap 40%, sums to 1", () => {
    const col = createColony(cfg(1, { perGeneration: 10 }));
    const plan = col.planGeneration(0);
    const devs = [1000, 800, 300, 200, 100];
    const confs = [900, 400, 300, -50, 90];
    plan.candidates.slice(0, 5).forEach((c, i) => { col.recordDev({ ...c, dev: devs[i]!, trades: 10 + i * 5, spec: c.spec }); });
    // force distinct niches irrelevant: confirms attach to records
    plan.candidates.slice(0, 5).forEach((c, i) => col.recordConfirm({ gen: 0, idx: c.idx }, confs[i]!, 10));
    const split = col.suggestedSplit();
    expect(split.length).toBe(4); // the -50 agent gets weight 0 and is omitted
    expect(split.every((s) => s.weight <= 0.4 + 1e-9)).toBe(true);
    expect(split.reduce((a, s) => a + s.weight, 0)).toBeCloseTo(1, 9);
    expect(split[0]!.weight).toBeCloseTo(0.4, 9); // raw share (900-50)/... exceeds the cap
    expect(capSplit([0.7, 0.2, 0.1], 0.4).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });
});

describe("calibration", () => {
  const mk = (f: (i: number) => [number, boolean]) => Array.from({ length: 200 }, (_, i) => { const [p, o] = f(i); return { pBps: p, outcome: o }; });
  test("perfect judge scores 0, anti judge 1, random about 0.33 (worse than baseline)", () => {
    const perfect = mk((i) => [i % 2 ? 10000 : 0, i % 2 === 1]);
    const anti = mk((i) => [i % 2 ? 0 : 10000, i % 2 === 1]);
    const rng = mulberry32(3);
    const rand = Array.from({ length: 4000 }, () => ({ pBps: Math.floor(rng() * 10001), outcome: rng() < 0.5 }));
    expect(brier(perfect)).toBe(0); expect(brier(anti)).toBe(1);
    expect(brier(rand)).toBeGreaterThan(0.31); expect(brier(rand)).toBeLessThan(0.36);
    expect(brierBaseline(rand)).toBeCloseTo(0.25, 1);
    expect(authorityFor(perfect)).toBe("advisory"); expect(authorityFor(anti)).toBe("shadow"); expect(authorityFor(rand)).toBe("shadow");
    expect(AUTHORITY_LADDER.default).toBe("shadow");
    expect(authorityFor(perfect.slice(0, 5))).toBe("shadow"); // too few resolved
  });
});
