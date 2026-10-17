// Line-log surface: what `watch` prints when stdout is not a terminal (pipe, file, CI) or with --lines.
// One greppable key=value line per notable event; no colour, no cursor control, no timestamps (the recording has its own clock).
import { explorerTx, signed, type Ev, type ViewState } from "./state";

const kv = (o: Record<string, string | number | undefined>) => Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${v}`).join(" ");

/** `s` is the state AFTER the event was folded in. Returns null for events too frequent to log (tx_sent, successful landings, block, judge, map). */
export function lineFor(s: ViewState, e: Ev): string | null {
  switch (e.type) {
    case "hello": return `hello ${kv({ mode: e.mode, model: e.model, chain: e.chainId, epoch: e.epoch.slice(0, 10) + "..", gens: e.config.generations, per_gen: e.config.perGeneration })}`;
    case "generation_start": return `gen ${e.gen} start ${kv({ planned: e.planned })}`;
    case "generation_end": return `gen ${e.gen} end ${kv({ best_idx: e.best.idx, best_dev: signed(e.best.dev), blocks: `${e.blocks.first}..${e.blocks.last}`, span: e.blocks.span })}`;
    case "tx_landed":
      if (e.status === "success") return null;
      return `gen ${e.gen} idx ${e.idx} ${e.status} ${kv({ block: e.block || undefined, tx: explorerTx(s, e.txHash) || e.txHash })}`;
    case "confirm": return `gen ${e.gen} confirm ${kv({ idx: e.idx, score: signed(e.score), trades: e.trades, tx: explorerTx(s, e.txHash) || e.txHash })}`;
    case "sealed": return `gen ${e.gen} sealed ${kv({ idx: e.idx, dev: signed(e.dev), confirm: signed(e.confirm), sealed: signed(e.score), trades: e.trades, tx: explorerTx(s, e.txHash) || e.txHash })}`;
    case "totals": return `totals ${kv({ evals: e.evals, reverted: e.reverted, lost: e.lost, gas_mon: e.gasMon, blocks: e.blocksSpanned })}`;
    case "error": return `error ${e.scope}: ${e.message}`;
    default: return null;
  }
}

export function endLine(s: ViewState): string {
  return `end ${kv({ events: s.events, evals: s.landed, reverted: s.reverted, lost: s.lost, gens_done: s.gensDone.length })}`;
}
