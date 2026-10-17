// The Colony (architecture 3a/3b). Deterministic given cfg.seed. Pure: no I/O, no Math.random.
import type { Colony, ColonyConfig, Candidate, EvalRecord } from "./colony";
import { type BlockwiseEvent, OPERATOR_NAMES, type Operator, type Ref } from "./events";
import { ACTIVITIES, Archive, STYLES, type Elite, better, nicheOf } from "./archive";
import { needConfirm, pickChampion } from "./cascade";
import { crossover, mutate, randomSpec, sweep } from "./operators";
import { BURST_SHARE, CREDIT_DECAY, CREDIT_DEPTH, OPS, Portfolio, STAGNATION_GENS, apportion } from "./portfolio";
import { type Rng, int, mulberry32 } from "./rng";
import { type Spec, specId, validate } from "./spec";

type MapEvent = Extract<BlockwiseEvent, { type: "map" }>;
type EndResult = ReturnType<Colony["endGeneration"]>;
const key = (r: Ref) => `${r.gen}:${r.idx}`;
const MAX_ATTEMPTS = 40;
const TABU_GENS = 2;

interface Rec extends EvalRecord { id: string }

export interface ColonyDebug {
  state(): unknown;
}

export function createColony(cfg: ColonyConfig): Colony & ColonyDebug {
  let archive = new Archive();
  let prevCells = new Archive(); // archive as of the end of the last ended generation (canonical discovery base)
  let portfolio = new Portfolio();
  let recs = new Map<string, Rec>();
  let byGen = new Map<number, Rec[]>();
  let immediate = new Map<string, boolean>();
  let idFirst = new Map<string, string>();
  let idMinGen = new Map<string, number>();
  let seen = new Set<string>(); // specIds recorded or planned this epoch
  let confirms = new Map<string, { score: number; trades: number }>();
  let plans = new Map<number, ReturnType<Colony["planGeneration"]>>();
  let ended = new Map<number, EndResult>();
  let tabu = new Map<string, number>(); // `${parentId}|${coord}` -> expires after gen
  let history: number[][] = Array.from({ length: 9 }, () => []); // per-niche level per ended gen
  let bestSoFar: number | null = null;
  let flat = 0;
  let burstPending = false;
  let dupDropped = 0, dupTotal = 0;
  let funding: Record<string, number> = {};
  let lastEndedGen = -1;

  const genRng = (gen: number): Rng => mulberry32((cfg.seed * 2654435761 + gen * 40503 + 12345) >>> 0);

  function reset() {
    archive = new Archive(); prevCells = new Archive(); portfolio = new Portfolio();
    recs = new Map(); byGen = new Map(); immediate = new Map(); idFirst = new Map(); idMinGen = new Map(); seen = new Set(); confirms = new Map();
    plans = new Map(); ended = new Map(); tabu = new Map(); history = Array.from({ length: 9 }, () => []);
    bestSoFar = null; flat = 0; burstPending = false; dupDropped = 0; dupTotal = 0; lastEndedGen = -1;
  }

  function mkCand(gen: number, idx: number, spec: number[], operator: Operator, parent?: Ref): Candidate {
    return parent ? { gen, idx, spec, operator, parent } : { gen, idx, spec, operator };
  }
  const eliteRef = (e: Elite): Ref => ({ gen: e.gen, idx: e.idx });

  function fundedParents(): { rec: Rec; w: number }[] {
    const out: { rec: Rec; w: number }[] = [];
    for (const [k, w] of Object.entries(funding)) {
      const r = recs.get(k);
      if (r && w > 0) out.push({ rec: r, w });
    }
    return out.sort((a, b) => (a.rec.gen - b.rec.gen) || (a.rec.idx - b.rec.idx));
  }

  function planGeneration(gen: number) {
    const cached = plans.get(gen);
    if (cached) return cached;
    const rng = genRng(gen);
    const N = cfg.perGeneration;
    const elites = archive.elites();
    // slots per operator
    let slots: { op: Operator; funded: boolean }[] = [];
    if (elites.length === 0) {
      slots = Array.from({ length: N }, () => ({ op: 0 as Operator, funded: false }));
    } else {
      const fp = fundedParents();
      const F = Object.values(funding).reduce((a, b) => a + Math.max(0, b), 0);
      const phi = fp.length ? Math.min(0.25, F / (F + 10)) : 0;
      const S = Math.round(phi * N);
      const B = burstPending ? Math.round(BURST_SHARE * N) : 0;
      if (burstPending) { burstPending = false; flat = 0; }
      const R = Math.max(0, N - S - B);
      const counts = apportion(portfolio.shares(rng), R);
      const add = [0, 0, 0, 0];
      add[1]! += Math.ceil(S / 2) - 0; add[3]! += S - Math.ceil(S / 2);
      add[0]! += Math.ceil(B / 2); add[2]! += B - Math.ceil(B / 2);
      // funded slots are tracked separately so they pick funded parents
      for (let a = 0; a < OPS; a++) for (let j = 0; j < counts[a]! + add[a]!; j++) slots.push({ op: a as Operator, funded: false });
      // mark the first S of mutate/sweep add-ons as funded
      let mS = Math.ceil(S / 2), sS = S - mS;
      for (const sl of slots) {
        if (sl.op === 1 && mS > 0) { sl.funded = true; mS--; }
        else if (sl.op === 3 && sS > 0) { sl.funded = true; sS--; }
      }
    }
    const cands: Candidate[] = [];
    const planned = new Set<string>();
    let dropped = 0;
    const fp = fundedParents();
    const fTot = fp.reduce((a, b) => a + b.w, 0);
    const pickFunded = (): Rec => {
      let x = rng() * fTot;
      for (const f of fp) { x -= f.w; if (x <= 0) return f.rec; }
      return fp[fp.length - 1]!.rec;
    };
    const pickElite = (): Elite => elites[int(rng, 0, elites.length - 1)]!;
    const parentSpec = (r: Ref): number[] => (recs.get(key(r))?.spec as number[]) ?? [];

    for (const slot of slots) {
      let made: Candidate | null = null;
      for (let at = 0; at < MAX_ATTEMPTS && !made; at++) {
        let spec: number[]; let op: Operator = slot.op; let parent: Ref | undefined;
        if (op === 0 || elites.length === 0) { op = 0; spec = randomSpec(rng); }
        else {
          const base = slot.funded && fp.length ? (() => { const r = pickFunded(); return { ref: { gen: r.gen, idx: r.idx }, spec: [...r.spec] }; })()
            : (() => { const e = pickElite(); return { ref: eliteRef(e), spec: [...e.spec] }; })();
          parent = base.ref;
          if (op === 1) spec = mutate(base.spec, rng);
          else if (op === 3) {
            const pid = specId(base.spec);
            spec = sweep(base.spec, rng, (k) => (tabu.get(`${pid}|${k}`) ?? -1) >= gen).spec;
          } else {
            const other = elites.length > 1 && rng() < 0.9
              ? (() => { let e = pickElite(); for (let t = 0; t < 6 && e.gen === base.ref.gen && e.idx === base.ref.idx; t++) e = pickElite(); return [...e.spec]; })()
              : randomSpec(rng);
            spec = crossover(base.spec, other, rng);
          }
        }
        if (validate(spec)) continue;
        const id = specId(spec);
        dupTotal++;
        if (seen.has(id) || planned.has(id)) { dropped++; dupDropped++; continue; }
        planned.add(id);
        made = mkCand(gen, cands.length, spec, op, parent);
      }
      if (!made) { // extremely unlikely: grammar exhausted around the parent; fall back to random
        for (;;) {
          const spec = randomSpec(rng); const id = specId(spec);
          if (!seen.has(id) && !planned.has(id)) { planned.add(id); made = mkCand(gen, cands.length, spec, 0); break; }
        }
      }
      cands.push(made);
    }
    void parentSpec; void dropped;
    for (const id of planned) seen.add(id);
    const allocation = [0, 1, 2, 3].map((a) => ({ operator: a as Operator, count: cands.filter((c) => c.operator === a).length }));
    const out = { allocation, candidates: cands };
    plans.set(gen, out);
    return out;
  }

  function recordDev(rec: EvalRecord): { discovered: boolean } {
    const k = key(rec);
    const have = immediate.get(k);
    if (have !== undefined) return { discovered: false };
    const r: Rec = { ...rec, spec: [...rec.spec], id: specId(rec.spec) };
    recs.set(k, r);
    let arr = byGen.get(rec.gen); if (!arr) byGen.set(rec.gen, (arr = []));
    arr.push(r);
    const dup = idFirst.has(r.id);
    if (!dup) idFirst.set(r.id, k);
    idMinGen.set(r.id, Math.min(idMinGen.get(r.id) ?? Infinity, r.gen));
    seen.add(r.id);
    const d = dup ? false : archive.insert(r);
    immediate.set(k, d);
    return { discovered: d };
  }

  function ancestors(r: Rec): Rec[] {
    const out: Rec[] = [];
    let cur: Rec | undefined = r;
    for (let d = 0; d < CREDIT_DEPTH && cur?.parent; d++) {
      const p = recs.get(key(cur.parent));
      if (!p) break;
      out.push(p); cur = p;
    }
    return out;
  }

  function endGeneration(gen: number): EndResult {
    const done = ended.get(gen);
    if (done) return done;
    const list = [...(byGen.get(gen) ?? [])].sort((a, b) => a.idx - b.idx);
    // canonical discovery replay against the archive as of the previous generation end
    const replay = prevCells.clone();
    const proposals = [0, 0, 0, 0], credit = [0, 0, 0, 0];
    const discoverers = new Set<Rec>();
    const seenIds = new Set<string>();
    for (const r of list) {
      proposals[r.operator]!++;
      const dupId = seenIds.has(r.id) || (idMinGen.get(r.id) ?? Infinity) < gen;
      seenIds.add(r.id);
      if (!dupId && replay.insert(r)) { credit[r.operator]!++; discoverers.add(r); }
    }
    // descendant credit for the elites this generation installed
    for (const e of replay.elites()) {
      if (e.gen !== gen) continue;
      const r = recs.get(key(e));
      if (!r) continue;
      ancestors(r).forEach((anc, i) => { credit[anc.operator]! += CREDIT_DECAY ** (i + 1); });
    }
    // tabu: a sweep step that failed to discover is blocked for 2 generations
    for (const r of list) {
      if (r.operator !== 3 || discoverers.has(r) || !r.parent) continue;
      const p = recs.get(key(r.parent)); if (!p) continue;
      for (let k = 0; k < r.spec.length; k++) if (r.spec[k] !== p.spec[k]) tabu.set(`${p.id}|${k}`, gen + TABU_GENS);
    }
    portfolio.update(proposals, credit);
    // labels
    const levelsPrev = history.map((h) => (h.length ? h[h.length - 1]! : null));
    const cur = archive.cells;
    cur.forEach((e, n) => { if (e) history[n]!.push(e.dev); });
    const maxDev = archive.bestDev();
    if (maxDev !== null) {
      if (bestSoFar === null || maxDev > bestSoFar) { bestSoFar = maxDev; flat = 0; } else flat++;
      if (flat >= STAGNATION_GENS) burstPending = true;
    }
    prevCells = archive.clone();
    const cells: MapEvent["cells"] = cur.map((e, n) => {
      const h = history[n]!;
      let label: MapEvent["cells"][number]["label"] = "young";
      if (e && h.length >= 3) {
        if (e.dev === maxDev) label = "leader";
        else if (h[h.length - 1]! > h[h.length - 2]!) label = "riser";
        else label = "stalled";
      }
      void levelsPrev;
      return {
        style: STYLES[Math.floor(n / 3)]!, activity: ACTIVITIES[n % 3]!,
        elite: e ? { gen: e.gen, idx: e.idx, dev: e.dev } : null, label,
      };
    });
    const rates = portfolio.rates();
    const discovery: Record<string, number> = {};
    OPERATOR_NAMES.forEach((nm, a) => { discovery[nm] = rates[a]!; });
    // diagnostics
    const children = [...recs.values()].filter((r) => r.parent && recs.has(key(r.parent)));
    const mpairs = children.filter((r) => r.operator === 1).map((r) => [recs.get(key(r.parent!))!.dev, r.dev] as const);
    const plateau = children.length ? children.filter((r) => Math.abs(r.dev - recs.get(key(r.parent!))!.dev) <= 1).length / children.length : 0;
    const diagnostics = { ruggedness: corr(mpairs), plateau, duplicates: dupTotal ? dupDropped / dupTotal : 0 };
    const map: MapEvent = { type: "map", gen, cells, discovery, diagnostics };
    const elites = archive.elites();
    const genBest = list.length ? list.reduce((a, b) => (b.dev > a.dev || (b.dev === a.dev && b.idx < a.idx) ? b : a)) : null;
    const top = genBest ?? (elites.length ? elites.reduce((a, b) => (better(b, a) ? b : a)) : null);
    const bandit: Record<string, number> = {};
    OPERATOR_NAMES.forEach((nm, a) => { bandit[nm] = portfolio.s[a]!; });
    const res: EndResult = {
      best: top ? { idx: top.idx, dev: top.dev, params: [...top.spec] } : { idx: 0, dev: 0, params: [0, 0, 0, 0, 0, 0, 0] },
      archive: elites.map((e) => ({ gen: e.gen, idx: e.idx, dev: e.dev, params: [...e.spec] })),
      bandit, map,
    };
    ended.set(gen, res);
    lastEndedGen = Math.max(lastEndedGen, gen);
    return res;
  }

  function candOf(e: { gen: number; idx: number }): Candidate {
    const r = recs.get(key(e))!;
    return mkCand(r.gen, r.idx, [...r.spec], r.operator, r.parent);
  }

  function confirmCandidates(): Candidate[] {
    return needConfirm(archive.elites(), cfg.confirmTopK, (e) => confirms.has(key(e))).map(candOf);
  }
  function recordConfirm(ref: Ref, score: number, trades: number) {
    if (!confirms.has(key(ref))) confirms.set(key(ref), { score, trades });
  }
  function confirmed() {
    const out: { gen: number; idx: number; spec: Spec; dev: number; confirm: number; confirmTrades: number }[] = [];
    for (const [k, c] of confirms) {
      const r = recs.get(k); if (!r) continue;
      out.push({ gen: r.gen, idx: r.idx, spec: r.spec, dev: r.dev, confirm: c.score, confirmTrades: c.trades });
    }
    return out;
  }
  function champion() {
    const c = pickChampion(confirmed());
    return c ? { gen: c.gen, idx: c.idx, spec: c.spec, dev: c.dev, confirm: c.confirm } : null;
  }
  function setFunding(byAgent: Record<string, number>) { funding = { ...byAgent }; }

  function suggestedSplit(): { agent: Ref; weight: number }[] {
    const xs = confirmed().map((c) => ({ agent: { gen: c.gen, idx: c.idx }, w: Math.max(0, c.confirm - Math.max(0, c.dev - c.confirm) / 2) }))
      .filter((x) => x.w > 0);
    const tot = xs.reduce((a, b) => a + b.w, 0);
    if (!tot) return [];
    return capSplit(xs.map((x) => x.w / tot), 0.4).map((w, i) => ({ agent: xs[i]!.agent, weight: w }));
  }

  function restore(records: EvalRecord[], conf: { ref: Ref; score: number; trades: number }[]) {
    reset();
    const uniq = new Map<string, EvalRecord>();
    for (const r of records) { const k = key(r); if (!uniq.has(k)) uniq.set(k, r); }
    const sorted = [...uniq.values()].sort((a, b) => a.gen - b.gen || a.idx - b.idx);
    const gens = [...new Set(sorted.map((r) => r.gen))];
    const maxGen = gens[gens.length - 1];
    for (const g of gens) {
      for (const r of sorted) if (r.gen === g) recordDev(r);
      if (g < maxGen! || (byGen.get(g)!.length >= cfg.perGeneration)) endGeneration(g);
    }
    for (const c of conf) recordConfirm(c.ref, c.score, c.trades);
  }

  return {
    planGeneration, recordDev, endGeneration, confirmCandidates, recordConfirm, champion, setFunding, suggestedSplit, restore,
    state: () => ({
      cells: archive.cells, n: portfolio.n, s: portfolio.s, flat, burstPending, bestSoFar, lastEndedGen,
      tabu: [...tabu.entries()].sort(), seen: [...seen].sort(), confirms: [...confirms.entries()].sort(),
    }),
  };
}

/** Cap weights at `cap` and renormalise the rest (water-filling). If cap*n < 1 the weights stay capped and sum below 1. */
export function capSplit(w: number[], cap: number): number[] {
  const out = [...w];
  const capped = new Array<boolean>(w.length).fill(false);
  for (let iter = 0; iter < w.length + 1; iter++) {
    const fixed = out.reduce((a, v, i) => a + (capped[i] ? v : 0), 0);
    const free = out.reduce((a, v, i) => a + (capped[i] ? 0 : v), 0);
    if (free <= 0) break;
    const scale = (1 - fixed) / free;
    let any = false;
    for (let i = 0; i < out.length; i++) if (!capped[i]) { out[i] = out[i]! * scale; }
    for (let i = 0; i < out.length; i++) if (!capped[i] && out[i]! > cap + 1e-12) { out[i] = cap; capped[i] = true; any = true; }
    if (!any) break;
  }
  return out.map((v) => Math.min(cap, v));
}

function corr(pairs: (readonly [number, number])[]): number | null {
  if (pairs.length < 5) return null;
  const n = pairs.length;
  const mx = pairs.reduce((a, p) => a + p[0], 0) / n, my = pairs.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}
