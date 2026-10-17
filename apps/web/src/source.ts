import type { BlockwiseEvent as E } from "../../../packages/core/src/events";
import { demoEvents } from "./demo";

export type Kind = "replay" | "live" | "demo";
export type Act = E | { type: "__reset" } | { type: "__seek"; events: E[] };
export interface Player {
  kind: Kind; label: string; total?: number;
  start(emit: (e: Act) => void, setStatus: (s: string) => void): () => void;
  setSpeed?(x: number): void; restart?(): void;
  /** replay-only transport */
  isPaused?(): boolean; pos?(): number; togglePause?(): boolean; stepGen?(dir: 1 | -1): void;
}

function pace(prev: E | undefined, e: E): number {
  // ms at 1x. Block gaps derive from recorded block ts when present.
  if (e.type === "tx_sent") return 6;
  if (e.type === "tx_landed") return 14;
  if (e.type === "block") return 350;
  if (e.type === "generation_end") return 900;
  if (e.type === "generation_start") return 600;
  return 120;
}

export function replayPlayer(events: E[], kind: Kind): Player {
  let speed = 1, gen = 0, paused = false, i = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let emitRef: ((e: Act) => void) | undefined, statusRef: ((s: string) => void) | undefined;
  // Generation boundaries: event index just before the next generation_start (and the end). Stepping lands on these.
  const starts = events.map((e, k) => (e.type === "generation_start" ? k : -1)).filter((k) => k >= 0);
  const bounds = [...starts.slice(1), events.length];
  const first = Math.max(1, starts[0] ?? 1);
  const tsOf = (e: E) => (e.type === "block" ? (e.ts < 1e11 ? e.ts * 1000 : e.ts) : 0);
  let lastTs = 0;
  const run = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (paused || !emitRef) return;
    const my = gen;
    const step = () => {
      if (my !== gen || paused) return;
      const batchEnd = performance.now() + 8;
      let wait = 0;
      while (i < events.length) {
        const e = events[i]!;
        emitRef!(e); i++;
        let d = pace(events[i - 2], e);
        if (e.type === "block") {
          const t = tsOf(e);
          if (lastTs && t > lastTs) d = Math.min(1500, Math.max(250, t - lastTs));
          if (t) lastTs = t;
        }
        wait = d / speed;
        if (wait >= 4 || performance.now() > batchEnd) break;
      }
      if (i >= events.length) { statusRef?.("done"); return; }
      timer = setTimeout(step, Math.max(0, wait));
    };
    statusRef?.("playing");
    step();
  };
  const seek = (to: number) => { i = Math.max(0, Math.min(events.length, to)); lastTs = 0; emitRef?.({ type: "__seek", events: events.slice(0, i) }); };
  const p: Player = {
    kind, label: kind, total: events.length,
    start(emit, setStatus) {
      gen++; i = 0; lastTs = 0; paused = false; emitRef = emit; statusRef = setStatus;
      run();
      return () => { gen++; if (timer) clearTimeout(timer); };
    },
    setSpeed(x) { speed = x; },
    isPaused: () => paused,
    pos: () => i,
    togglePause() {
      if (i >= events.length) { gen++; seek(0); paused = false; run(); return false; }
      paused = !paused;
      if (paused) { if (timer) clearTimeout(timer); statusRef?.("paused"); } else { gen++; run(); }
      return paused;
    },
    stepGen(dir) {
      gen++; paused = true; if (timer) clearTimeout(timer);
      const target = dir > 0 ? (bounds.find((b) => b > i) ?? events.length) : ([...bounds].reverse().find((b) => b < i) ?? first);
      seek(target); statusRef?.("paused");
    },
  };
  return p;
}

function parseLines(t: string): E[] {
  const s = t.trim();
  if (s.startsWith("[")) return JSON.parse(s);
  return s.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function safeBase(u: string): string | null {
  try { const x = new URL(u); return x.protocol === "http:" || x.protocol === "https:" ? x.origin : null; } catch { return null; }
}

export function livePlayer(base: string): Player {
  return {
    kind: "live", label: "live",
    start(emit, setStatus) {
      let es: EventSource | undefined, dead = false;
      (async () => {
        try {
          setStatus("loading history");
          const r = await fetch(base + "/history");
          const evs = parseLines(await r.text());
          for (const e of evs) emit(e);
        } catch (err) { setStatus("history unavailable"); }
        if (dead) return;
        es = new EventSource(base + "/events");
        es.onopen = () => setStatus("connected");
        es.onerror = () => setStatus("reconnecting");
        es.onmessage = (m) => { try { emit(JSON.parse(m.data)); } catch { /* ignore malformed */ } };
      })();
      return () => { dead = true; es?.close(); };
    },
  };
}

export function pickSource(): Player {
  const q = new URLSearchParams(location.search).get("live");
  if (q) { const b = safeBase(q); if (b) return livePlayer(b); }
  const emb = (window as any).__BLOCKWISE_REPLAY__ as E[] | undefined;
  if (Array.isArray(emb) && emb.length) return replayPlayer(emb, "replay");
  return replayPlayer(demoEvents(), "demo");
}
