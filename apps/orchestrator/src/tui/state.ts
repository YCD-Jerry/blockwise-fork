// The only thing a surface needs from the engine is the event stream. This file folds events into a view model;
// it has no I/O, no clock and no terminal knowledge, so the same fold serves the TUI, the line log and the report.
// The fold is total: an unknown event type is counted, an event with missing fields is counted as malformed, nothing throws.
import type { BlockwiseEvent } from "@blockwise/core";

export type Ev = BlockwiseEvent & { t?: number };
type Of<T extends BlockwiseEvent["type"]> = Extract<BlockwiseEvent, { type: T }>;

/** 0 queued, 1 sent, 2 landed, 3 reverted, 4 lost */
export type CellState = 0 | 1 | 2 | 3 | 4;

export interface TapeLine { kind: "landed" | "confirm" | "sealed" | "error"; gen?: number; idx?: number; block?: number; dev?: number; score?: number; trades?: number; gasUsed?: number; latencyMs?: number; status?: string; txHash?: string; message?: string }
export interface Champion { gen: number; idx: number; dev?: number; confirm: number; trades: number; txHash: string }

/** One candidate as the stream describes it. Params are not kept (they are large and no surface draws them). */
export interface Cand {
  gen: number; idx: number;
  operator?: number; parent?: { gen: number; idx: number };
  status: "sent" | "success" | "reverted" | "lost";
  dev?: number; trades?: number; block?: number; gasUsed?: number; latencyMs?: number; txHash?: string;
  confirm?: number; confirmTrades?: number; confirmTx?: string;
  sealed?: number;
  /** a confirm attempt for this candidate was reported as failed (parsed from an `error` event with scope confirm) */
  confirmFail?: "reverted" | "lost";
}
export interface BlockInfo { block: number; evals: number; reverted: number; gen: number; ts?: number; evalsLanded?: number }
export interface GenInfo {
  gen: number; planned: number; alloc: number[];
  sent: number; ok: number; reverted: number; lost: number;
  bestDev?: number; first?: number; last?: number; span?: number;
  bandit?: Record<string, number>; discovery?: Record<string, number>;
  baseline?: { bestRandom1x: number; bestRandom2xMedian: number; seeds: number };
  done: boolean;
}
export interface OperatorStat { sent: number; ok: number; reverted: number; lost: number; devSum: number; best?: number; withParent: number; improved: number }
export interface TotalsPoint { gen: number | null; evals: number; reverted: number; lost: number; gasMon: number; jevUsd: number; blocksSpanned: number }
export interface ErrorGroup { scope: string; pattern: string; count: number; example: string }

export interface ViewState {
  events: number;
  unknown: number;
  unknownTypes: Map<string, number>;
  /** events of a known type whose fields made the fold throw; counted and skipped */
  malformed: number;
  /** lines of a JSONL source that were not JSON objects with a type (set by the source, not by the fold) */
  badLines: number;
  firstBadLine: { line: number; reason: string } | null;
  hello: Of<"hello"> | null;
  gen: number | null;
  planned: number;
  gensStarted: number[];
  gensDone: number[];
  cells: CellState[];
  cellDev: (number | undefined)[];
  maxDev: number;
  hist: Record<string, number>;
  lastHist: { gen: number; hist: Record<string, number> } | null;
  genBlocks: Record<number, { first: number; last: number; span: number }>;
  block: number | null;
  cands: Map<string, Cand>;
  blocks: Map<number, BlockInfo>;
  gens: Map<number, GenInfo>;
  operators: OperatorStat[];
  totalsHist: TotalsPoint[];
  latency: Map<number, number>; // 100 ms buckets
  latencyN: number;
  latencyMax: number;
  errorGroups: Map<string, ErrorGroup>;
  errorsTotal: number;
  sent: number;
  bestDev: { gen: number; idx: number; dev: number } | null;
  champion: Champion | null;
  sealed: Of<"sealed"> | null;
  baseline: Of<"baseline"> | null;
  calibration: Of<"calibration"> | null;
  map: Of<"map"> | null;
  totalsEvent: Of<"totals"> | null;
  landed: number;     // success + reverted: a receipt exists
  success: number;
  reverted: number;
  lost: number;       // no receipt
  gasUsedSum: number;
  gasUsedN: number;
  judge: { n: number; usd: number };
  allocations: number;
  errors: { scope: string; message: string }[]; // the first ERRORS_KEPT only; errorsTotal and errorGroups count them all
  tape: TapeLine[];
  bandit: Record<string, number> | null;
  firstT: number | null;
  lastT: number | null;
}

export const TAPE_MAX = 12;
export const ERRORS_KEPT = 200;
export const CAND_CAP = 60_000;
const ERROR_GROUPS_MAX = 100;
export const ref = (gen: number, idx: number) => `${gen}:${idx}`;
export const OP_KEYS = ["random", "mutate", "crossover", "sweep"] as const;

export function initState(): ViewState {
  return {
    events: 0, unknown: 0, unknownTypes: new Map(), malformed: 0, badLines: 0, firstBadLine: null,
    hello: null, gen: null, planned: 0, gensStarted: [], gensDone: [], cells: [], cellDev: [], maxDev: 0,
    hist: {}, lastHist: null, genBlocks: {}, block: null, cands: new Map(), blocks: new Map(), gens: new Map(),
    operators: OP_KEYS.map(() => ({ sent: 0, ok: 0, reverted: 0, lost: 0, devSum: 0, withParent: 0, improved: 0 })),
    totalsHist: [], latency: new Map(), latencyN: 0, latencyMax: 0, errorGroups: new Map(), errorsTotal: 0, sent: 0,
    bestDev: null, champion: null, sealed: null,
    baseline: null, calibration: null, map: null, totalsEvent: null, landed: 0, success: 0, reverted: 0, lost: 0, gasUsedSum: 0, gasUsedN: 0,
    judge: { n: 0, usd: 0 }, allocations: 0, errors: [], tape: [], bandit: null, firstT: null, lastT: null,
  };
}

function tape(s: ViewState, l: TapeLine) { s.tape.push(l); if (s.tape.length > TAPE_MAX) s.tape.shift(); }
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const strip = (x: string) => x.replace(/[\x00-\x1f\x7f-\x9f]/g, " "); // eslint-disable-line no-control-regex

function genInfo(s: ViewState, gen: number): GenInfo {
  let g = s.gens.get(gen);
  if (!g) { g = { gen, planned: 0, alloc: [0, 0, 0, 0], sent: 0, ok: 0, reverted: 0, lost: 0, done: false }; s.gens.set(gen, g); }
  return g;
}
function cand(s: ViewState, gen: number, idx: number): Cand {
  const k = ref(gen, idx);
  let c = s.cands.get(k);
  if (!c) { c = { gen, idx, status: "sent" }; s.cands.set(k, c); if (s.cands.size > CAND_CAP) prune(s); }
  return c;
}
/** Bound memory on huge recordings: keep recent generations, anything confirmed, and the best by dev. */
function prune(s: ViewState) {
  const recent = (s.gen ?? 0) - 1;
  const rest: [string, Cand][] = [];
  for (const [k, c] of s.cands) if (c.gen < recent && c.confirm === undefined && c.sealed === undefined) rest.push([k, c]);
  rest.sort((a, b) => (b[1].dev ?? -Infinity) - (a[1].dev ?? -Infinity));
  for (const [k] of rest.slice(Math.floor(CAND_CAP / 4))) s.cands.delete(k);
}

/** "confirm 1:72 reverted" -> "confirm #:# reverted": digits and hashes collapse so the same reason groups together. */
export function errorPattern(msg: string): string { return strip(msg).replace(/0x[0-9a-fA-F]{6,}/g, "0x..").replace(/\d+(\.\d+)?/g, "#").slice(0, 120); }

function noteError(s: ViewState, scope: string, message: string) {
  const m = strip(message), sc = strip(scope);
  s.errorsTotal++;
  if (s.errors.length < ERRORS_KEPT) s.errors.push({ scope: sc, message: m });
  const pattern = errorPattern(m), k = `${sc}\u0000${pattern}`;
  let g = s.errorGroups.get(k);
  if (!g) { if (s.errorGroups.size >= ERROR_GROUPS_MAX) return; g = { scope: sc, pattern, count: 0, example: m }; s.errorGroups.set(k, g); }
  g.count++; g.example = m;
  const cf = /^confirm (\d+):(\d+) (reverted|lost)/.exec(m);
  if (cf) { const c = s.cands.get(ref(Number(cf[1]), Number(cf[2]))); if (c) c.confirmFail = cf[3] as "reverted" | "lost"; }
}

/** Fold one event into the state (mutates and returns it). Never throws: unknown types are counted, broken events are counted and skipped. */
export function reduce(s: ViewState, e: Ev): ViewState {
  s.events++;
  try { apply(s, e); } catch { s.malformed++; }
  return s;
}

function apply(s: ViewState, e: Ev) {
  if (num(e.t)) { if (s.firstT === null) s.firstT = e.t; s.lastT = e.t; }
  switch (e.type) {
    case "hello": s.hello = e; break;
    case "generation_start": {
      if (s.hist && Object.keys(s.hist).length && s.gen !== null) s.lastHist = { gen: s.gen, hist: s.hist };
      s.gen = e.gen; s.planned = e.planned; s.hist = {};
      s.cells = new Array(Math.max(0, Math.min(e.planned, 100_000))).fill(0); s.cellDev = new Array(s.cells.length).fill(undefined);
      if (!s.gensStarted.includes(e.gen)) s.gensStarted.push(e.gen);
      const g = genInfo(s, e.gen); g.planned = e.planned;
      for (const a of e.allocation ?? []) if (a.operator >= 0 && a.operator < 4) g.alloc[a.operator] = a.count;
      break;
    }
    case "tx_sent": {
      s.sent++;
      const c = cand(s, e.gen, e.idx);
      c.operator = e.operator; c.parent = e.parent; c.txHash = e.txHash;
      const op = s.operators[e.operator]; if (op) op.sent++;
      genInfo(s, e.gen).sent++;
      if (e.gen !== s.gen) break;
      if (s.cells[e.idx] === undefined || s.cells[e.idx] === 0) s.cells[e.idx] = 1;
      break;
    }
    case "tx_landed": {
      const c = cand(s, e.gen, e.idx);
      const g = genInfo(s, e.gen);
      const op = c.operator !== undefined ? s.operators[c.operator] : undefined;
      c.status = e.status; c.block = e.block || undefined; c.txHash = e.txHash ?? c.txHash;
      if (e.status === "lost") { s.lost++; g.lost++; if (op) op.lost++; }
      else {
        s.landed++;
        if (e.status === "success") { s.success++; g.ok++; if (op) op.ok++; } else { s.reverted++; g.reverted++; if (op) op.reverted++; }
        if (e.block) {
          const k = String(e.block); s.hist[k] = (s.hist[k] ?? 0) + 1; if (s.block === null || e.block > s.block) s.block = e.block;
          let b = s.blocks.get(e.block);
          if (!b) { b = { block: e.block, evals: 0, reverted: 0, gen: e.gen }; s.blocks.set(e.block, b); }
          b.evals++; if (e.status !== "success") b.reverted++;
        }
        if (num(e.gasUsed)) { s.gasUsedSum += e.gasUsed; s.gasUsedN++; }
        if (num(e.latencyMs)) { const k = Math.floor(e.latencyMs / 100); s.latency.set(k, (s.latency.get(k) ?? 0) + 1); s.latencyN++; if (e.latencyMs > s.latencyMax) s.latencyMax = e.latencyMs; }
      }
      if (e.gen === s.gen) {
        s.cells[e.idx] = e.status === "success" ? 2 : e.status === "reverted" ? 3 : 4;
        if (num(e.dev) && e.status === "success") { s.cellDev[e.idx] = e.dev; if (e.dev > s.maxDev) s.maxDev = e.dev; }
      }
      if (num(e.dev) && e.status === "success") {
        c.dev = e.dev; c.trades = e.trades; c.gasUsed = e.gasUsed; c.latencyMs = e.latencyMs;
        if (op) {
          op.devSum += e.dev; if (op.best === undefined || e.dev > op.best) op.best = e.dev;
          if (c.parent) { const p = s.cands.get(ref(c.parent.gen, c.parent.idx)); if (p?.dev !== undefined) { op.withParent++; if (e.dev > p.dev) op.improved++; } }
        }
      }
      tape(s, { kind: "landed", gen: e.gen, idx: e.idx, block: e.block, dev: e.dev, trades: e.trades, gasUsed: e.gasUsed, latencyMs: e.latencyMs, status: e.status, txHash: e.txHash });
      break;
    }
    case "block": {
      if (s.block === null || e.number > s.block) s.block = e.number;
      let b = s.blocks.get(e.number);
      if (!b) { b = { block: e.number, evals: 0, reverted: 0, gen: s.gen ?? 0 }; s.blocks.set(e.number, b); }
      if (num(e.ts)) b.ts = e.ts;
      if (num(e.evalsLanded)) b.evalsLanded = e.evalsLanded;
      break;
    }
    case "generation_end": {
      if (!s.gensDone.includes(e.gen)) s.gensDone.push(e.gen);
      if (e.gen === s.gen) s.hist = { ...e.blocks.histogram };
      s.genBlocks[e.gen] = { first: e.blocks.first, last: e.blocks.last, span: e.blocks.span };
      if (!s.bestDev || e.best.dev > s.bestDev.dev) s.bestDev = { gen: e.gen, idx: e.best.idx, dev: e.best.dev };
      s.bandit = e.bandit;
      const g = genInfo(s, e.gen);
      g.bestDev = e.best.dev; g.first = e.blocks.first; g.last = e.blocks.last; g.span = e.blocks.span; g.bandit = { ...e.bandit }; g.done = true;
      break;
    }
    case "confirm": {
      const c = cand(s, e.gen, e.idx); c.confirm = e.score; c.confirmTrades = e.trades; c.confirmTx = e.txHash; c.confirmFail = undefined;
      tape(s, { kind: "confirm", gen: e.gen, idx: e.idx, score: e.score, trades: e.trades, txHash: e.txHash });
      if (!s.champion || e.score > s.champion.confirm) s.champion = { gen: e.gen, idx: e.idx, confirm: e.score, trades: e.trades, txHash: e.txHash };
      break;
    }
    case "sealed": { s.sealed = e; const c = cand(s, e.gen, e.idx); c.sealed = e.score; tape(s, { kind: "sealed", gen: e.gen, idx: e.idx, dev: e.dev, score: e.score, trades: e.trades, txHash: e.txHash }); break; }
    case "judge": s.judge.n++; s.judge.usd += num(e.usd) ? e.usd : 0; break;
    case "calibration": s.calibration = e; break;
    case "baseline": { s.baseline = e; const g = genInfo(s, e.gen); g.baseline = { bestRandom1x: e.bestRandom1x, bestRandom2xMedian: e.bestRandom2xMedian, seeds: e.seeds }; break; }
    case "map": { s.map = e; const g = genInfo(s, e.gen); g.discovery = { ...e.discovery }; break; }
    case "allocation": s.allocations++; break;
    case "totals": {
      s.totalsEvent = e;
      const last = s.gensDone.length ? Math.max(...s.gensDone) : null;
      s.totalsHist.push({ gen: last, evals: e.evals, reverted: e.reverted, lost: e.lost, gasMon: e.gasMon, jevUsd: e.jevUsd, blocksSpanned: e.blocksSpanned });
      break;
    }
    case "error": noteError(s, e.scope, e.message); tape(s, { kind: "error", message: `${strip(e.scope)}: ${strip(e.message)}` }); break;
    default: {
      s.unknown++;
      const name = strip(String((e as { type?: unknown }).type)).slice(0, 40);
      if (s.unknownTypes.size < 20 || s.unknownTypes.has(name)) s.unknownTypes.set(name, (s.unknownTypes.get(name) ?? 0) + 1);
    }
  }
  if (s.champion && s.champion.dev === undefined) s.champion.dev = s.cands.get(ref(s.champion.gen, s.champion.idx))?.dev;
}

export function fold(events: Iterable<Ev>, s: ViewState = initState()): ViewState { for (const e of events) reduce(s, e); return s; }

/** Record lines of a JSONL source that could not be used. */
export function noteBadLine(s: ViewState, line: number, reason: string) { s.badLines++; if (!s.firstBadLine) s.firstBadLine = { line, reason }; }

/** The champion for display: the sealed one once the sealed look happened, else the best confirm so far. */
export function championView(s: ViewState): { gen: number; idx: number; dev?: number; confirm?: number; sealed?: number; trades?: number } | null {
  if (s.sealed) return { gen: s.sealed.gen, idx: s.sealed.idx, dev: s.sealed.dev, confirm: s.sealed.confirm, sealed: s.sealed.score, trades: s.sealed.trades };
  if (s.champion) return { gen: s.champion.gen, idx: s.champion.idx, dev: s.champion.dev, confirm: s.champion.confirm, trades: s.champion.trades };
  return null;
}

/** Only http(s) URLs without control characters become links or text, so a hostile recording cannot inject terminal escapes. */
export const explorerTx = (s: ViewState, hash: string) => {
  const base = s.hello?.explorer;
  if (typeof base !== "string" || !/^https?:\/\/[^\s\x00-\x1f\x7f]+$/.test(base)) return ""; // eslint-disable-line no-control-regex
  return `${base.replace(/\/$/, "")}/tx/${strip(String(hash))}`;
};

export const signed = (n: number | undefined | null): string => {
  if (n === undefined || n === null || !Number.isFinite(n)) return "-";
  const t = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return n > 0 ? `+${t}` : t;
};
