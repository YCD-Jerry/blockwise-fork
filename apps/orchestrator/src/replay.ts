import { readFileSync } from "node:fs";
import { Bus } from "./bus";

/** Serve a recorded JSONL through the same SSE endpoint, mode "replay". Uses the recorded `t` for pacing (speed x). */
export function replay(file: string, port: number, speed = 1, loop = false) {
  const events = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const bus = new Bus({});
  const server = bus.serve(port);
  const play = async () => {
    bus.history.length = 0; bus.hello = null;
    let prev = 0;
    for (const e of events) {
      const t = typeof e.t === "number" ? e.t : prev + 150;
      await new Promise((r) => setTimeout(r, Math.max(0, (t - prev) / speed)));
      prev = t;
      if (e.type === "hello") e.mode = "replay";
      bus.emit(e, t);
    }
  };
  (async () => { do { await play(); } while (loop); })();
  return { server, bus, count: events.length };
}
