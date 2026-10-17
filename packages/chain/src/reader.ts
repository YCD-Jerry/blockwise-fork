// Rebuild Ledger state from Evaluated / Confirmed / Sealed events (resume, UI).
import { decodeEventLog, type Address, type Hex } from "viem";
import { evaluatorAbi } from "./abi";
import type { Ctx } from "./clients";

export interface DevRow { gen: number; idx: number; proposer: Address; dev: number; trades: number; operator: number; parent?: { gen: number; idx: number }; params: number[]; txHash: Hex; block: number }
export interface LookRow { gen: number; idx: number; proposer: Address; score: number; trades: number; txHash: Hex; block: number }
export interface LedgerState { devs: DevRow[]; confirms: LookRow[]; sealed: LookRow[]; head: number }

export async function readState(ctx: Ctx, evaluator: Address, fromBlock: number, opts: { chunk?: number; proposers?: Address[] } = {}): Promise<LedgerState> {
  const head = Number(BigInt(await ctx.pool.request<string>("eth_blockNumber"))); // not client.getBlockNumber: viem caches it
  let chunk = opts.chunk ?? 2000;
  const allow = opts.proposers ? new Set(opts.proposers.map((a) => a.toLowerCase())) : null;
  const devs: DevRow[] = [], confirms: LookRow[] = [], sealed: LookRow[] = [];
  for (let from = fromBlock; from <= head; ) {
    const to = Math.min(head, from + chunk - 1);
    let logs;
    try {
      logs = await ctx.client.getLogs({ address: evaluator, fromBlock: BigInt(from), toBlock: BigInt(to) });
    } catch (e) {
      if (chunk > 10) { chunk = Math.max(10, Math.floor(chunk / 2)); continue; }
      throw e;
    }
    for (const l of logs) {
      let ev: any;
      try { ev = decodeEventLog({ abi: evaluatorAbi, data: l.data, topics: l.topics as any }); } catch { continue; }
      const a = ev.args;
      if (allow && !allow.has((a.proposer as string).toLowerCase())) continue;
      const base = { gen: Number(a.gen), idx: Number(a.idx), proposer: a.proposer as Address, txHash: l.transactionHash as Hex, block: Number(l.blockNumber) };
      if (ev.eventName === "Evaluated") {
        const hasParent = Number(a.parentGen) !== 0 || Number(a.parentIdx) !== 0;
        devs.push({ ...base, dev: Number(a.dev), trades: Number(a.trades), operator: Number(a.operator), parent: hasParent ? { gen: Number(a.parentGen), idx: Number(a.parentIdx) } : undefined, params: (a.params as readonly bigint[] | readonly number[]).map(Number) });
      } else if (ev.eventName === "Confirmed") confirms.push({ ...base, score: Number(a.score), trades: Number(a.trades) });
      else if (ev.eventName === "Sealed") sealed.push({ ...base, score: Number(a.score), trades: Number(a.trades) });
    }
    from = to + 1;
  }
  return { devs, confirms, sealed, head };
}
