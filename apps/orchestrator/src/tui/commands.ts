// Command entry points for the terminal surfaces. cli.ts only dispatches here, so the CLI file stays small.
import { numFlag, UsageError } from "../cli-meta";
import { buildReport, formatReport } from "./report";
import { SourceError, readEvents } from "./source";
import { watch, type IO } from "./watch";

type Flags = Record<string, string | true>;

export function processIO(): IO {
  return {
    out: process.stdout as unknown as IO["out"],
    inp: process.stdin as unknown as IO["inp"],
    env: process.env,
    err: (s) => process.stderr.write(s + "\n"),
  };
}

export async function cmdWatch(flags: Flags, io: IO = processIO(), signal?: AbortSignal): Promise<number> {
  const replay = typeof flags.replay === "string" ? flags.replay : undefined;
  const live = typeof flags.live === "string" ? flags.live : undefined;
  if (flags.replay === true || flags.live === true) throw new UsageError(`--${flags.replay === true ? "replay" : "live"} needs a value. Example: --replay fixtures/events.sample.jsonl or --live http://localhost:8787`);
  if (!replay && !live) throw new UsageError("watch needs a source: --replay FILE (a recording) or --live URL (a running `run` or `serve`).\n  try: bun run orch watch --replay fixtures/events.sample.jsonl --speed 16");
  if (replay && live) throw new UsageError("choose one source: --replay FILE or --live URL, not both.");
  if (flags.frame && live) throw new UsageError("--frame renders a recording; use it with --replay FILE.");
  const speedRaw = flags.speed;
  const speed = speedRaw === "max" ? Infinity : numFlag(flags, "speed", 1);
  if (speed <= 0) throw new UsageError("--speed must be above 0 (or `max`).");
  try {
    return await watch({
      replay, live, speed, speedGiven: speedRaw !== undefined, lines: !!flags.lines, frame: !!flags.frame, exitAtEnd: !!flags.exit,
      at: flags.at !== undefined ? numFlag(flags, "at", 0) : undefined,
      width: flags.width !== undefined ? numFlag(flags, "width", 120) : undefined,
      height: flags.height !== undefined ? numFlag(flags, "height", 34) : undefined,
      color: flags["no-color"] ? false : flags.color ? true : "auto", ascii: flags.ascii ? true : undefined,
    }, io, signal);
  } catch (e) {
    if (e instanceof SourceError) throw new UsageError(e.message);
    throw e;
  }
}

export function cmdReport(pos: string[], flags: Flags, io: Pick<IO, "out"> = { out: process.stdout as unknown as IO["out"] }): number {
  const file = pos[1];
  if (!file) throw new UsageError("report needs a recording: report FILE.\n  recordings are written by `run` to runs/<timestamp>.jsonl; a sample is fixtures/events.sample.jsonl");
  let events;
  try { events = readEvents(file); } catch (e) { if (e instanceof SourceError) throw new UsageError(e.message); throw e; }
  if (!events.length) throw new UsageError(`${file} has no events. Was the run stopped before the first generation?`);
  const r = buildReport(events, file);
  io.out.write(flags.json ? JSON.stringify(r, null, 2) + "\n" : formatReport(r));
  return 0;
}
