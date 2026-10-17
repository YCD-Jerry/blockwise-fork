// Round-robin JSON-RPC pool with per-endpoint pacing, batching and backoff. No keys pass through here except as signed raw txs.
export const DEFAULT_TESTNET_RPCS = [
  "https://testnet-rpc.monad.xyz",
  "https://rpc.ankr.com/monad_testnet",
  "https://rpc-testnet.monadinfra.com",
];

export interface Endpoint { url: string; rps: number; batch: number; next: number }

function profile(url: string): { rps: number; batch: number } {
  if (url.includes("monadinfra")) return { rps: 20, batch: 1 }; // documented: 20 rps, no batch
  if (url.includes("testnet-rpc.monad.xyz")) return { rps: 25, batch: 50 };
  if (url.includes("ankr")) return { rps: 15, batch: 25 };
  return { rps: 200, batch: 100 }; // local node / private RPC
}

export function rpcUrlsFromEnv(env = process.env): string[] {
  const list = (env.RPC_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length) return list;
  if (env.RPC_URL) return [env.RPC_URL.trim()];
  return DEFAULT_TESTNET_RPCS;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) { super(message); }
}

export class RpcPool {
  eps: Endpoint[];
  private rr = 0;
  private id = 1;
  public requests = 0;
  public retries = 0;
  constructor(urls: string[] = rpcUrlsFromEnv()) {
    this.eps = urls.map((url) => ({ url, ...profile(url), next: 0 }));
  }
  get url(): string { return this.eps[0]!.url; }
  get batchSize(): number { return Math.max(1, Math.min(...this.eps.map((e) => e.batch))); }

  private pick(): Endpoint {
    const e = this.eps[this.rr++ % this.eps.length]!;
    return e;
  }
  private async pace(e: Endpoint) {
    const now = Date.now();
    const at = Math.max(now, e.next);
    e.next = at + Math.ceil(1000 / e.rps);
    if (at > now) await sleep(at - now);
  }

  private async post(e: Endpoint, body: unknown): Promise<any> {
    await this.pace(e);
    this.requests++;
    const res = await fetch(e.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (res.status === 429 || res.status >= 500) throw new RpcError(res.status, `http ${res.status}`);
    if (!res.ok) throw new RpcError(res.status, `http ${res.status}`);
    return res.json();
  }

  /** Single call; transport/rate-limit failures rotate endpoint with backoff. JSON-RPC errors are thrown as RpcError without retry. */
  async request<T = any>(method: string, params: unknown[] = [], attempts = 6): Promise<T> {
    let last: unknown;
    for (let a = 0; a < attempts; a++) {
      const e = this.pick();
      try {
        const out = await this.post(e, { jsonrpc: "2.0", id: this.id++, method, params });
        if (out.error) throw new RpcError(out.error.code, out.error.message, out.error.data);
        return out.result as T;
      } catch (err) {
        if (err instanceof RpcError && err.code <= 0 && err.code !== -32005) throw err; // real JSON-RPC error: caller decides
        last = err; this.retries++;
        await sleep(Math.min(2000, 150 * 2 ** a));
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  /** Batched calls. Returns per-item {result}|{error}. Whole-batch transport failures retry on another endpoint (callers must only batch idempotent calls or identical raw txs). */
  async batch(calls: { method: string; params: unknown[] }[], attempts = 6): Promise<({ result: any } | { error: RpcError })[]> {
    const out: ({ result: any } | { error: RpcError })[] = new Array(calls.length);
    const size = this.batchSize;
    const chunks: [number, typeof calls][] = [];
    for (let i = 0; i < calls.length; i += size) chunks.push([i, calls.slice(i, i + size)]);
    await Promise.all(chunks.map(async ([off, chunk]) => {
      let last: unknown;
      for (let a = 0; a < attempts; a++) {
        const e = this.pick();
        try {
          let rows: any[];
          if (e.batch <= 1 || chunk.length === 1) {
            rows = [];
            for (const c of chunk) rows.push(await this.post(e, { jsonrpc: "2.0", id: this.id++, method: c.method, params: c.params }));
            rows = rows.map((r, i) => ({ ...r, id: i }));
          } else {
            const base = this.id; this.id += chunk.length;
            const body = chunk.map((c, i) => ({ jsonrpc: "2.0", id: base + i, method: c.method, params: c.params }));
            const res = await this.post(e, body);
            if (!Array.isArray(res)) throw new RpcError(-1, "batch not supported");
            const byId = new Map<number, any>(res.map((r: any) => [r.id, r]));
            rows = body.map((b, i) => byId.get(base + i) ?? { error: { code: -1, message: "missing batch item" }, id: i });
          }
          rows.forEach((r, i) => { out[off + i] = r.error ? { error: new RpcError(r.error.code, r.error.message, r.error.data) } : { result: r.result }; });
          return;
        } catch (err) { last = err; this.retries++; await sleep(Math.min(2000, 150 * 2 ** a)); }
      }
      chunk.forEach((_, i) => { out[off + i] = { error: new RpcError(-1, `transport: ${(last as Error)?.message ?? last}`) }; });
    }));
    return out;
  }
}
