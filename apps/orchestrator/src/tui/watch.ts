// The watch surface: a TTY gets the full-screen instrument, anything else gets line logs. Same events, same fold.
import { detectEnv } from "./ansi";
import { endLine, lineFor } from "./lines";
import { renderFrame } from "./render";
import { liveEvents, paced, readEvents, type Pace } from "./source";
import { fold, initState, reduce, type Ev } from "./state";

export interface Out { write(s: string): unknown; isTTY?: boolean; columns?: number; rows?: number; on?(ev: "resize", f: () => void): unknown; off?(ev: "resize", f: () => void): unknown }
export interface In { isTTY?: boolean; setRawMode?(b: boolean): unknown; on?(ev: "data", f: (b: Buffer | string) => void): unknown; off?(ev: "data", f: (b: Buffer | string) => void): unknown; resume?(): unknown; pause?(): unknown }
export interface IO { out: Out; inp: In; env: Record<string, string | undefined>; err(s: string): void }

export interface WatchArgs {
  replay?: string;
  live?: string;
  speed?: number;       // Infinity = as fast as possible
  speedGiven?: boolean; // explicit --speed; non-TTY replays are instant otherwise
  lines?: boolean;      // force the line log
  frame?: boolean;      // render one frame and exit
  at?: number;          // --frame: stop after this many events
  width?: number; height?: number;
  color?: boolean | "auto"; ascii?: boolean;
  exitAtEnd?: boolean;  // TTY: leave when a recording ends instead of waiting for q
}

export const ALT_ON = "\x1b[?1049h\x1b[?25l";
export const ALT_OFF = "\x1b[?25h\x1b[?1049l";

function sourceOf(a: WatchArgs, pace: Pace, signal: AbortSignal): AsyncIterable<Ev | { type: "__reset" } | { type: "__status"; text: string }> {
  if (a.live) return liveEvents(a.live, signal);
  return paced(readEvents(a.replay!), pace);
}

/** One frame, to a string. Used by `watch --frame` and by tests. */
export function frameOf(events: Ev[], o: { width: number; height: number; color: boolean; ascii?: boolean; links?: boolean; status?: string; keys?: string }): string {
  const s = fold(events);
  return renderFrame(s, { width: o.width, height: o.height, color: o.color, ascii: !!o.ascii, links: !!o.links, status: o.status, keys: o.keys }).join("\n") + "\n";
}

export async function watch(a: WatchArgs, io: IO, signal: AbortSignal = new AbortController().signal): Promise<number> {
  const tty = !!io.out.isTTY && !!io.inp.isTTY && !a.lines && !a.frame && io.env.BLOCKWISE_NO_TUI !== "1";
  const term = detectEnv(io.env, !!io.out.isTTY, { color: a.color ?? "auto", ascii: a.ascii });

  if (a.frame) {
    const evs = readEventsFor(a);
    const take = a.at !== undefined ? evs.slice(0, a.at) : evs;
    io.out.write(frameOf(take, { width: a.width ?? 120, height: a.height ?? 34, color: term.color, ascii: term.ascii, links: false, keys: "q quit", status: `${take.length} of ${evs.length} events` }));
    return 0;
  }

  if (!tty) return watchLines(a, io, signal);
  return watchTty(a, io, signal, term);
}

function readEventsFor(a: WatchArgs): Ev[] {
  if (!a.replay) throw new Error("--frame needs --replay FILE");
  return readEvents(a.replay);
}

async function watchLines(a: WatchArgs, io: IO, signal: AbortSignal): Promise<number> {
  const s = initState();
  const pace: Pace = { speed: a.speedGiven ? (a.speed ?? 1) : Infinity, paused: false };
  let live = !!a.live;
  for await (const item of sourceOf(a, pace, signal)) {
    if (item.type === "__status") { if (!/^connected$/.test(item.text)) io.err(item.text); continue; }
    if (item.type === "__reset") { Object.assign(s, initState()); continue; }
    const line = (reduce(s, item), lineFor(s, item));
    if (line) io.out.write(line + "\n");
  }
  if (!live) io.out.write(endLine(s) + "\n");
  return 0;
}

async function watchTty(a: WatchArgs, io: IO, signal: AbortSignal, term: ReturnType<typeof detectEnv>): Promise<number> {
  const { out, inp } = io;
  const pace: Pace = { speed: a.speed ?? 1, paused: false };
  let s = initState();
  let status = a.live ? "connecting" : "";
  let ended = false, quit = false, dirty = true, lastDraw = 0;
  const ac = new AbortController();
  const onAbort = () => { pace.stop = true; ac.abort(); };
  signal.addEventListener("abort", onAbort);

  const size = () => ({ width: out.columns ?? 120, height: out.rows ?? 34 });
  const keys = () => (a.live ? "q quit" : "q quit   space pause   + faster   - slower");
  const draw = () => {
    const { width, height } = size();
    const note = a.live ? status : `${ended ? "end of recording" : pace.paused ? "paused" : Number.isFinite(pace.speed) ? `x${trim(pace.speed)}` : "max speed"}  ${s.events} events`;
    const lines = renderFrame(s, { width, height, color: term.color, ascii: term.ascii, links: term.links, keys: keys(), status: note });
    let buf = "";
    for (let i = 0; i < Math.min(lines.length, height); i++) buf += `\x1b[${i + 1};1H${lines[i]}\x1b[K`;
    buf += `\x1b[${Math.min(lines.length, height) + 1};1H\x1b[J`;
    out.write(buf);
    dirty = false; lastDraw = Date.now();
  };

  let restored = false;
  const restore = () => { if (restored) return; restored = true; try { inp.setRawMode?.(false); } catch { /* not a tty any more */ } out.write(ALT_OFF); };
  const onKey = (b: Buffer | string) => {
    const raw = b.toString();
    if (raw.startsWith("\x1b[") || raw.startsWith("\x1bO")) return; // arrow/function keys: ignored
    for (const k of raw === "\x1b" ? ["q"] : raw) {
      if (k === "q" || k === "Q" || k === "\x03") { quit = true; pace.stop = true; ac.abort(); return; }
      if (a.live) continue;
      if (k === " ") pace.paused = !pace.paused;
      else if (k === "+" || k === "=") pace.speed = Number.isFinite(pace.speed) ? Math.min(1024, pace.speed * 2) : pace.speed;
      else if (k === "-" || k === "_") pace.speed = Number.isFinite(pace.speed) ? Math.max(0.25, pace.speed / 2) : 16;
    }
    dirty = true;
  };
  const onResize = () => { dirty = true; };
  const onSig = () => { quit = true; pace.stop = true; ac.abort(); };

  try { inp.setRawMode?.(true); } catch { /* ignore */ }
  inp.resume?.(); inp.on?.("data", onKey); out.on?.("resize", onResize);
  process.on("exit", restore); process.on("SIGTERM", onSig);
  out.write(ALT_ON);
  const timer = setInterval(() => { if (dirty && Date.now() - lastDraw >= 60) draw(); }, 30);

  try {
    draw();
    try {
      for await (const item of sourceOf(a, pace, ac.signal)) {
        if (quit) break;
        if (item.type === "__status") { status = item.text; dirty = true; continue; }
        if (item.type === "__reset") { s = initState(); dirty = true; continue; }
        reduce(s, item); dirty = true;
      }
    } catch (e) { if (!quit) throw e; }
    ended = !quit;
    dirty = true; draw();
    if (!quit && !a.live && !a.exitAtEnd) await new Promise<void>((r) => { ac.signal.addEventListener("abort", () => r()); if (ac.signal.aborted) r(); });
  } finally {
    clearInterval(timer);
    inp.off?.("data", onKey); out.off?.("resize", onResize); inp.pause?.();
    process.off("exit", restore); process.off("SIGTERM", onSig);
    signal.removeEventListener("abort", onAbort);
    restore();
  }
  return 0;
}

const trim = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, ""));
