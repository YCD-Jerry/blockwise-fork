// Event bus: stdout JSONL + runs/<ts>.jsonl recorder + SSE (/events) + /history. Events carry an extra `t` (ms since start) for replay pacing.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BlockwiseEvent } from "@blockwise/core";

export type Stamped = BlockwiseEvent & { t?: number };

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, OPTIONS" };

export class Bus {
  history: Stamped[] = [];
  hello: Stamped | null = null;
  private clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private enc = new TextEncoder();
  private t0 = Date.now();
  constructor(private opts: { stdout?: boolean; file?: string; maxHistory?: number } = {}) {
    if (opts.file) mkdirSync(dirname(opts.file), { recursive: true });
  }
  emit(ev: BlockwiseEvent, t?: number) {
    const e: Stamped = { ...ev, t: t ?? Date.now() - this.t0 };
    const line = JSON.stringify(e);
    if (this.opts.stdout) process.stdout.write(line + "\n");
    if (this.opts.file) appendFileSync(this.opts.file, line + "\n");
    if (e.type === "hello") this.hello = e;
    this.history.push(e);
    if (this.history.length > (this.opts.maxHistory ?? 20000)) this.history.shift();
    const chunk = this.enc.encode(`data: ${line}\n\n`);
    for (const c of this.clients) { try { c.enqueue(chunk); } catch { this.clients.delete(c); } }
  }
  serve(port: number) {
    const bus = this;
    return Bun.serve({
      port,
      idleTimeout: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
        if (url.pathname === "/history") {
          const n = Number(url.searchParams.get("n") ?? 5000);
          return Response.json(bus.history.slice(-n), { headers: CORS });
        }
        if (url.pathname === "/events") {
          let ctl!: ReadableStreamDefaultController<Uint8Array>;
          const stream = new ReadableStream<Uint8Array>({
            start(c) { ctl = c; bus.clients.add(c); c.enqueue(bus.enc.encode(`retry: 2000\n\n`)); if (bus.hello) c.enqueue(bus.enc.encode(`data: ${JSON.stringify(bus.hello)}\n\n`)); },
            cancel() { bus.clients.delete(ctl); },
          });
          return new Response(stream, { headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
        }
        return new Response("blockwise orchestrator: GET /events (SSE), GET /history\n", { headers: CORS });
      },
    });
  }
}
