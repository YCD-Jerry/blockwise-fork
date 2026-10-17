import type { BlockwiseEvent as E } from "../../../packages/core/src/events";

export type Cell = { state: "idle" | "sent" | "landed"; status?: "success" | "reverted" | "lost"; dev?: number; block?: number; op?: number; hash?: string };
export type TapeItem = { key: string; kind: "eval" | "confirm" | "sealed"; gen: number; idx: number; op?: number; value?: number; block?: number; status?: string; hash: string };
/** One candidate strategy, joined from tx_sent and tx_landed. Nothing here is invented: every field is an event field. */
export type Cand = {
  gen: number; idx: number; op: number; parent?: { gen: number; idx: number }; wallet: string; hash: string; params: number[];
  status?: "success" | "reverted" | "lost"; dev?: number; trades?: number; gasUsed?: number; latencyMs?: number; block?: number;
};
export type BlockRow = { number: number; ts: number; evals: number; gen: number };
export type ErrRow = { scope: string; message: string; gen: number; seq: number };
type Ge = Extract<E, { type: "generation_end" }>;
type Map_ = Extract<E, { type: "map" }>;
type Alloc = Extract<E, { type: "allocation" }>;
type Totals = Extract<E, { type: "totals" }>;
export type Seek = { type: "__seek"; events: E[] };
export type Action = E | { type: "__reset" } | Seek;

export interface State {
  hello?: Extract<E, { type: "hello" }>;
  gen: number; base: number; planned: number; cells: Cell[];
  block: number; lastBlockEvals: number; blockSeq: number;
  liveHist: Record<string, number>;
  ends: Record<number, Ge>; baselines: Record<number, { b1: number; b2: number; seeds: number }>;
  confirms: Record<string, Extract<E, { type: "confirm" }>>;
  sealed?: Extract<E, { type: "sealed" }>;
  sealedAll: Extract<E, { type: "sealed" }>[];
  lastConfirm?: Extract<E, { type: "confirm" }>;
  map?: Map_; calib?: Extract<E, { type: "calibration" }>; judges: number; judgeUsd: number; judgeModel?: string;
  allocs: Alloc[]; funded?: Alloc["funded"];
  totals?: Totals; totalsHist: Totals[];
  tape: TapeItem[]; errors: string[]; count: number; ops: Record<string, number>;
  cands: Record<string, Cand>;
  blocks: BlockRow[];
  plan: Record<number, { operator: number; count: number }[]>;
  banditBy: Record<number, Record<string, number>>;
  discBy: Record<number, Record<string, number>>;
  errLog: ErrRow[];
  firstGen?: number;
}
export const init = (): State => ({
  gen: 0, base: 1, planned: 0, cells: [], block: 0, lastBlockEvals: 0, blockSeq: 0, liveHist: {}, ends: {}, baselines: {}, confirms: {},
  sealedAll: [], judges: 0, judgeUsd: 0, allocs: [], totalsHist: [], tape: [], errors: [], count: 0, ops: {},
  cands: {}, blocks: [], plan: {}, banditBy: {}, discBy: {}, errLog: [],
});

export const ck = (gen: number, idx: number) => `${gen}:${idx}`;

export function reduce(s: State, e: Action): State {
  if (e.type === "__reset") return init();
  if (e.type === "__seek") return e.events.reduce<State>((a, x) => reduce(a, x), init());
  const n: State = { ...s, count: s.count + 1 };
  switch (e.type) {
    case "hello": n.hello = e; break;
    case "generation_start":
      if (s.gen === 0 && Object.keys(s.ends).length === 0) n.base = e.gen;
      n.gen = e.gen; n.planned = e.planned;
      n.cells = Array.from({ length: e.planned }, () => ({ state: "idle" as const }));
      n.plan = { ...s.plan, [e.gen]: e.allocation };
      n.liveHist = {}; n.lastBlockEvals = 0; break;
    case "tx_sent": {
      const c: Cand = { gen: e.gen, idx: e.idx, op: e.operator, parent: e.parent, wallet: e.wallet, hash: e.txHash, params: e.params };
      n.cands = { ...s.cands, [ck(e.gen, e.idx)]: c };
      n.ops = { ...n.ops, [ck(e.gen, e.idx)]: e.operator };
      if (e.gen !== n.gen) break;
      n.cells = n.cells.slice();
      while (n.cells.length <= e.idx) n.cells.push({ state: "idle" });
      n.cells[e.idx] = { state: "sent", op: e.operator, hash: e.txHash }; break;
    }
    case "tx_landed": {
      const prev = s.cands[ck(e.gen, e.idx)];
      n.cands = { ...n.cands, [ck(e.gen, e.idx)]: { gen: e.gen, idx: e.idx, op: prev?.op ?? 0, parent: prev?.parent, wallet: prev?.wallet ?? "", params: prev?.params ?? [], ...prev, hash: e.txHash, status: e.status, dev: e.dev, trades: e.trades, gasUsed: e.gasUsed, latencyMs: e.latencyMs, block: e.status === "lost" ? undefined : e.block } };
      if (e.gen === n.gen) {
        n.cells = n.cells.slice();
        while (n.cells.length <= e.idx) n.cells.push({ state: "idle" });
        n.cells[e.idx] = { state: "landed", status: e.status, dev: e.dev, block: e.block, op: n.ops[ck(e.gen, e.idx)], hash: e.txHash };
        if (e.status !== "lost") n.liveHist = { ...n.liveHist, [e.block]: (n.liveHist[e.block] ?? 0) + 1 };
      }
      n.tape = [{ key: `e${e.gen}:${e.idx}:${e.txHash}`, kind: "eval" as const, gen: e.gen, idx: e.idx, op: n.ops[ck(e.gen, e.idx)], value: e.dev, block: e.block, status: e.status, hash: e.txHash }, ...n.tape].slice(0, 12);
      break;
    }
    case "block": n.block = e.number; n.lastBlockEvals = e.evalsLanded; n.blockSeq = s.blockSeq + 1; n.blocks = [...s.blocks, { number: e.number, ts: e.ts, evals: e.evalsLanded, gen: s.gen }]; break;
    case "generation_end": n.ends = { ...n.ends, [e.gen]: e }; n.banditBy = { ...s.banditBy, [e.gen]: e.bandit }; break;
    case "baseline": n.baselines = { ...n.baselines, [e.gen]: { b1: e.bestRandom1x, b2: e.bestRandom2xMedian, seeds: e.seeds } }; break;
    case "confirm":
      n.confirms = { ...n.confirms, [ck(e.gen, e.idx)]: e }; n.lastConfirm = e;
      n.tape = [{ key: `c${e.txHash}`, kind: "confirm" as const, gen: e.gen, idx: e.idx, value: e.score, hash: e.txHash }, ...n.tape].slice(0, 12); break;
    case "sealed":
      n.sealed = e; n.sealedAll = [...s.sealedAll, e];
      n.tape = [{ key: `s${e.txHash}`, kind: "sealed" as const, gen: e.gen, idx: e.idx, value: e.score, hash: e.txHash }, ...n.tape].slice(0, 12); break;
    case "judge": n.judges = s.judges + 1; n.judgeUsd = s.judgeUsd + e.usd; n.judgeModel = e.model; break;
    case "calibration": n.calib = e; break;
    case "map": n.map = e; n.discBy = { ...s.discBy, [e.gen]: e.discovery }; break;
    case "allocation": n.allocs = [e, ...s.allocs].slice(0, 6); n.funded = e.funded; break;
    case "totals": n.totals = e; n.totalsHist = [...s.totalsHist, e]; break;
    case "error": n.errors = [`${e.scope}: ${e.message}`, ...s.errors].slice(0, 3); n.errLog = [...s.errLog, { scope: e.scope, message: e.message, gen: s.gen, seq: s.errLog.length }]; break;
  }
  return n;
}
