// Event sources: a recorded JSONL file (paced) or a live SSE endpoint. Both yield the same events the engine emits.
import { readFileSync } from "node:fs";
import type { Ev } from "./state";

export class SourceError extends Error {}

export function parseJsonl(text: string, label: string): Ev[] {
  const out: Ev[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (!l) continue;
    let o: unknown;
    try { o = JSON.parse(l); } catch { throw new SourceError(`${label}:${i + 1}: not JSON. Is this a Blockwise event recording (one JSON object per line)?`); }
    if (!o || typeof o !== "object" || typeof (o as { type?: unknown }).type !== "string") throw new SourceError(`${label}:${i + 1}: JSON without a "type" field; not a Blockwise event.`);
    out.push(o as Ev);
  }
  return out;
}

export function readEvents(path: string): Ev[] {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new SourceError(`cannot read ${path}${code === "ENOENT" ? ": no such file" : code ? ` (${code})` : ""}. \`run\` records to runs/<timestamp>.jsonl; a sample is fixtures/events.sample.jsonl`);
  }
  return parseJsonl(text, path);
}

export interface Pace { speed: number; paused: boolean; stop?: boolean }
export const FALLBACK_STEP_MS = 150; // same default as `serve --replay` when a recording has no `t`

/** Yield events at recorded pace / speed. speed Infinity = no waiting. Pausing and speed changes take effect within 50 ms. */
export async function* paced(events: Ev[], pace: Pace, sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms))): AsyncGenerator<Ev> {
  let prev = 0;
  for (const e of events) {
    const t = typeof e.t === "number" ? e.t : prev + FALLBACK_STEP_MS;
    let rem = Math.min(Math.max(0, t - prev), 5000); // recorded ms; never sit still for more than 5 s of recording time
    prev = t;
    while ((rem > 0.01 || pace.paused) && !pace.stop) {
      if (pace.paused) { await sleep(50); continue; }
      if (!Number.isFinite(pace.speed)) break;
      const wall = Math.min(50, rem / pace.speed);
      await sleep(wall); rem -= wall * pace.speed;
    }
    if (pace.stop) return;
    yield e;
  }
}

export function liveUrls(input: string): { events: string; history: string } {
  let u: URL;
  try { u = new URL(/^https?:\/\//.test(input) ? input : `http://${input}`); } catch { throw new SourceError(`bad --live URL "${input}". Example: --live http://localhost:8787`); }
  const base = u.pathname.replace(/\/events\/?$/, "").replace(/\/$/, "");
  return { events: `${u.origin}${base}/events`, history: `${u.origin}${base}/history?n=20000` };
}

export type LiveItem = Ev | { type: "__reset" } | { type: "__status"; text: string };
const key = (e: unknown) => JSON.stringify(e);

/**
 * Follow an orchestrator's SSE endpoint. On each (re)connect: open the stream, fetch /history, emit `__reset` then the history,
 * then the stream minus anything already in the history. Reconnects with backoff until aborted. Never throws on network errors.
 */
export async function* liveEvents(input: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch, backoffMs = [500, 1000, 2000, 4000]): AsyncGenerator<LiveItem> {
  const { events, history } = liveUrls(input);
  let attempt = 0;
  while (!signal.aborted) {
    try {
      yield { type: "__status", text: attempt === 0 ? `connecting to ${events}` : `reconnecting to ${events} (attempt ${attempt})` };
      const res = await fetchImpl(events, { signal, headers: { accept: "text/event-stream" } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const seen = new Set<string>();
      let hist: Ev[] = [];
      try { const hr = await fetchImpl(history, { signal }); if (hr.ok) hist = (await hr.json()) as Ev[]; } catch { /* history is optional */ }
      yield { type: "__reset" };
      for (const e of hist) { seen.add(key(e)); yield e; }
      yield { type: "__status", text: "connected" };
      attempt = 0;
      const dec = new TextDecoder(); let buf = "";
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
          if (!data) continue;
          let e: Ev; try { e = JSON.parse(data); } catch { continue; }
          const k = key(e);
          if (seen.has(k)) { seen.delete(k); continue; }
          yield e;
        }
      }
      throw new Error("stream closed");
    } catch (err) {
      if (signal.aborted) return;
      attempt++;
      yield { type: "__status", text: `disconnected (${(err as Error).message}); retrying` };
      await new Promise<void>((r) => { const t = setTimeout(r, backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]); signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
    }
  }
}
