// Fan-out: pre-assigned nonces, offline signing, batched eth_sendRawTransaction, receipt collection, landing histogram.
import { keccak256, type Address, type Hex } from "viem";
import type { HDAccount } from "viem/accounts";
import type { RpcPool } from "./rpc";

export interface TxJob { key: string; worker: number; to: Address; data: Hex; gas: bigint; value?: bigint }
export interface Signed { job: TxJob; nonce: number; raw: Hex; hash: Hex; from: Address }
export type SendState = "sent" | "maybe" | "failed";
export interface Outcome {
  job: TxJob; hash: Hex; from: Address; nonce: number; sendState: SendState; sendError?: string;
  status: "success" | "reverted" | "lost";
  block?: number; gasUsed?: number; logs?: { address: string; topics: Hex[]; data: Hex }[];
  sentAt: number; landedAt?: number; latencyMs?: number; blockTs?: number;
}

export class NonceBook {
  private next = new Map<string, number>();
  take(a: Address): number { const k = a.toLowerCase(); const n = this.next.get(k) ?? 0; this.next.set(k, n + 1); return n; }
  async sync(pool: RpcPool, addrs: Address[], tag: "pending" | "latest" = "pending") {
    const rows = await pool.batch(addrs.map((a) => ({ method: "eth_getTransactionCount", params: [a, tag] })));
    rows.forEach((r, i) => { if ("result" in r) this.next.set(addrs[i]!.toLowerCase(), Number(BigInt(r.result))); else throw new Error(`nonce sync failed: ${r.error.message}`); });
  }
}

export async function signJobs(accounts: HDAccount[], book: NonceBook, jobs: TxJob[], chainId: number, gasPrice: bigint): Promise<Signed[]> {
  const out: Signed[] = [];
  for (const job of jobs) {
    const acc = accounts[job.worker]!;
    const nonce = book.take(acc.address);
    const raw = await acc.signTransaction({ type: "legacy", chainId, nonce, gasPrice, gas: job.gas, to: job.to, data: job.data, value: job.value ?? 0n });
    out.push({ job, nonce, raw, hash: keccak256(raw), from: acc.address });
  }
  return out;
}

const MAYBE = /already known|nonce too low|known transaction|already imported|replacement transaction/i;

/** Send signed raw txs in batches. Re-sending the identical raw bytes is idempotent; "already known"/"nonce too low" mean possibly landed, settled by receipt. */
export async function sendSigned(pool: RpcPool, signed: Signed[]): Promise<{ state: SendState; error?: string }[]> {
  const rows = await pool.batch(signed.map((s) => ({ method: "eth_sendRawTransaction", params: [s.raw] })));
  return rows.map((r) => {
    if ("result" in r) return { state: "sent" as const };
    const m = r.error.message ?? "";
    if (MAYBE.test(m)) return { state: "maybe" as const, error: m };
    return { state: "failed" as const, error: m };
  });
}

export async function collect(pool: RpcPool, signed: Signed[], sends: { state: SendState; error?: string }[], sentAt: number, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<Outcome[]> {
  const timeout = opts.timeoutMs ?? 60_000, poll = opts.pollMs ?? 300;
  const outs: Outcome[] = signed.map((s, i) => ({ job: s.job, hash: s.hash, from: s.from, nonce: s.nonce, sendState: sends[i]!.state, sendError: sends[i]!.error, status: "lost" as const, sentAt }));
  let pending = outs.map((_, i) => i).filter((i) => outs[i]!.sendState !== "failed");
  const deadline = Date.now() + timeout;
  while (pending.length && Date.now() < deadline) {
    const rows = await pool.batch(pending.map((i) => ({ method: "eth_getTransactionReceipt", params: [outs[i]!.hash] })));
    const still: number[] = [];
    rows.forEach((r, k) => {
      const i = pending[k]!;
      if ("result" in r && r.result) {
        const o = outs[i]!, rc = r.result;
        o.status = rc.status === "0x1" ? "success" : "reverted";
        o.block = Number(BigInt(rc.blockNumber)); o.gasUsed = Number(BigInt(rc.gasUsed)); o.logs = rc.logs; o.landedAt = Date.now(); o.latencyMs = o.landedAt - sentAt;
      } else still.push(i);
    });
    pending = still;
    if (pending.length) await new Promise((r) => setTimeout(r, poll));
  }
  const blocks = [...new Set(outs.filter((o) => o.block !== undefined).map((o) => o.block!))];
  if (blocks.length) {
    const rows = await pool.batch(blocks.map((b) => ({ method: "eth_getBlockByNumber", params: ["0x" + b.toString(16), false] })));
    const ts = new Map<number, number>();
    rows.forEach((r, k) => { if ("result" in r && r.result) ts.set(blocks[k]!, Number(BigInt(r.result.timestamp))); });
    for (const o of outs) if (o.block !== undefined) o.blockTs = ts.get(o.block);
  }
  return outs;
}

export async function fanOut(pool: RpcPool, accounts: HDAccount[], book: NonceBook, jobs: TxJob[], chainId: number, gasPrice: bigint, opts: { timeoutMs?: number; onSigned?: (s: Signed[]) => void } = {}): Promise<Outcome[]> {
  const signed = await signJobs(accounts, book, jobs, chainId, gasPrice);
  opts.onSigned?.(signed);
  const sentAt = Date.now();
  const sends = await sendSigned(pool, signed);
  return collect(pool, signed, sends, sentAt, opts);
}

export interface Landing {
  first: number; last: number; span: number; histogram: Record<string, number>;
  landed: number; reverted: number; lost: number;
  latency: { p50: number; p90: number; max: number };
}
export function landingReport(outs: Outcome[]): Landing {
  const histogram: Record<string, number> = {};
  const lat: number[] = [];
  let reverted = 0, lost = 0, landed = 0;
  for (const o of outs) {
    if (o.status === "lost") { lost++; continue; }
    landed++; if (o.status === "reverted") reverted++;
    histogram[String(o.block)] = (histogram[String(o.block)] ?? 0) + 1;
    if (o.latencyMs !== undefined) lat.push(o.latencyMs);
  }
  const blocks = Object.keys(histogram).map(Number);
  const first = blocks.length ? Math.min(...blocks) : 0, last = blocks.length ? Math.max(...blocks) : 0;
  lat.sort((a, b) => a - b);
  const q = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]! : 0);
  return { first, last, span: blocks.length ? last - first + 1 : 0, histogram, landed, reverted, lost, latency: { p50: q(0.5), p90: q(0.9), max: lat.length ? lat[lat.length - 1]! : 0 } };
}

/** Fund each worker up to need = gasLimit * gasPrice * txs (+ value 0). Tops up only the deficit. */
export async function fundWorkers(pool: RpcPool, deployer: HDAccount, workers: Address[], need: bigint, chainId: number, gasPrice: bigint, book = new NonceBook()): Promise<{ funded: { to: Address; amount: bigint; hash: Hex }[]; total: bigint }> {
  const bal = await pool.batch(workers.map((a) => ({ method: "eth_getBalance", params: [a, "latest"] })));
  const todo: { to: Address; amount: bigint }[] = [];
  bal.forEach((r, i) => { if (!("result" in r)) throw new Error(`balance read failed: ${r.error.message}`); const b = BigInt(r.result); if (b < need) todo.push({ to: workers[i]!, amount: need - b }); });
  if (!todo.length) return { funded: [], total: 0n };
  await book.sync(pool, [deployer.address]);
  const signed: Signed[] = [];
  for (const t of todo) {
    const nonce = book.take(deployer.address);
    const raw = await deployer.signTransaction({ type: "legacy", chainId, nonce, gasPrice, gas: 21000n, to: t.to, value: t.amount });
    signed.push({ job: { key: `fund:${t.to}`, worker: 0, to: t.to, data: "0x", gas: 21000n, value: t.amount }, nonce, raw, hash: keccak256(raw), from: deployer.address });
  }
  const sentAt = Date.now();
  const sends = await sendSigned(pool, signed);
  const outs = await collect(pool, signed, sends, sentAt, { timeoutMs: 90_000 });
  const bad = outs.filter((o) => o.status !== "success");
  if (bad.length) throw new Error(`funding failed for ${bad.length} worker(s): ${bad[0]!.sendError ?? bad[0]!.status}`);
  return { funded: outs.map((o, i) => ({ to: todo[i]!.to, amount: todo[i]!.amount, hash: o.hash })), total: todo.reduce((a, t) => a + t.amount, 0n) };
}

export function budgetWei(txs: number, gasLimit: bigint, gasPrice: bigint): bigint { return BigInt(txs) * gasLimit * gasPrice; }
