import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Bus } from "../src/bus";
import { checkFlags, nearest } from "../src/cli-meta";
import { detectEnv, stripAnsi, vlen } from "../src/tui/ansi";
import { cmdReport } from "../src/tui/commands";
import { fitUrl, renderFrame } from "../src/tui/render";
import { buildReport, formatReport } from "../src/tui/report";
import { liveEvents, liveUrls, paced, parseJsonl, readEvents, SourceError } from "../src/tui/source";
import { fold, initState, reduce, type Ev } from "../src/tui/state";
import { ALT_OFF, ALT_ON, frameOf, watch, type IO } from "../src/tui/watch";

const ROOT = join(import.meta.dir, "../../..");
const FIXTURE = join(ROOT, "fixtures/events.sample.jsonl");
const CLI = join(ROOT, "apps/orchestrator/src/cli.ts");
const events = readEvents(FIXTURE);

const base = { color: false, ascii: false, links: false };
const frame = (evs: Ev[], width: number, height: number) => renderFrame(fold(evs), { ...base, width, height, keys: "q quit", status: `${evs.length} events` });

function fakeIO(o: { tty: boolean; env?: Record<string, string>; columns?: number; rows?: number }) {
  const out: string[] = [], err: string[] = [];
  const io: IO = {
    out: { write: (s) => { out.push(s); return true; }, isTTY: o.tty, columns: o.columns ?? 120, rows: o.rows ?? 34 },
    inp: { isTTY: o.tty, setRawMode: () => {}, on: () => {}, off: () => {}, resume: () => {}, pause: () => {} },
    env: o.env ?? {}, err: (s) => err.push(s),
  };
  return { io, out, err };
}

describe("state fold", () => {
  const s = fold(events);
  test("counts agree with the stream", () => {
    expect(s.events).toBe(events.length);
    expect(s.landed).toBe(1999); // success + reverted
    expect(s.reverted).toBe(1);
    expect(s.lost).toBe(1);
    expect(s.gensDone.length).toBe(10);
    expect(s.unknown).toBe(0);
  });
  test("champion is the sealed candidate once sealed", () => {
    expect(s.sealed?.gen).toBe(7);
    expect(s.sealed?.idx).toBe(182);
  });
  test("an unknown event type is counted and ignored", () => {
    const t = initState();
    reduce(t, { type: "from_the_future" } as unknown as Ev);
    expect(t.unknown).toBe(1);
  });
});

describe("frame rendering", () => {
  const f120 = frame(events, 120, 34);
  test("fits the terminal exactly, no colour codes without colour", () => {
    expect(f120.length).toBe(34);
    for (const l of f120) { expect(vlen(l)).toBeLessThanOrEqual(120); expect(l).toBe(stripAnsi(l)); }
  });
  test("has every required panel", () => {
    const t = f120.join("\n");
    for (const needle of ["BLOCKWISE", "[REPLAY]", "[STAND-IN JUDGE]", "block 71750045", "POPULATION", "200 of 200 landed", "200 evals in 4 blocks", "CHAMPION", "dev", "confirm", "sealed", "+145", "NICHE MAP", "reversion", "momentum", "TOTALS", "evals 1,999", "reverted 1", "lost 1", "LAST TRANSACTIONS", "/tx/0x"]) expect(t).toContain(needle);
  });
  test("snapshot, end of the recording at 120x34", () => { expect(f120.join("\n")).toMatchSnapshot(); });
  test("snapshot, mid generation at 120x34", () => { expect(frame(events.slice(0, 700), 120, 34).join("\n")).toMatchSnapshot(); });
  test("sealed reads unopened before the sealed look", () => {
    const t = frame(events.slice(0, 700), 120, 34).join("\n");
    expect(t).toContain("unopened");
  });
  test("narrow terminals stack the panels and still fit", () => {
    const f = frame(events, 80, 40);
    expect(f.length).toBe(40);
    for (const l of f) expect(vlen(l)).toBeLessThanOrEqual(80);
    expect(f.join("\n")).toContain("NICHE MAP");
  });
  test("a short terminal keeps the footer", () => {
    const f = frame(events, 100, 20);
    expect(f.length).toBe(20);
    expect(f[19]).toContain("events");
  });
  test("before any event it says it is waiting, not a crash", () => {
    const f = frame([], 120, 34);
    expect(f.join("\n")).toContain("WAITING");
    expect(f.length).toBe(34);
  });
  test("ascii mode uses no non-ASCII glyphs", () => {
    const f = renderFrame(fold(events), { ...base, ascii: true, width: 120, height: 34 }).join("\n");
    expect(f).toMatch(/^[\x20-\x7e\n]*$/);
  });
  test("one accent colour only", () => {
    const f = renderFrame(fold(events), { ...base, color: true, links: true, width: 120, height: 34 }).join("\n");
    const colours = new Set([...f.matchAll(/\x1b\[(?:1;)?(38;5;\d+)m/g)].map((m) => m[1]));
    expect([...colours]).toEqual(["38;5;74"]);
    expect(stripAnsi(f)).not.toContain("\x1b");
  });
  test("long urls are shortened to fit, short ones kept whole", () => {
    const hash = "0x" + "ab".repeat(32);
    const url = `https://testnet.monadvision.com/tx/${hash}`;
    expect(fitUrl(url, hash, 200, "…")).toBe(url);
    const short = fitUrl(url, hash, 60, "…");
    expect(short.length).toBeLessThanOrEqual(60);
    expect(short).toContain("testnet.monadvision.com/tx/0x");
    expect(short.endsWith("abab")).toBe(true);
  });
});

describe("environment", () => {
  test("NO_COLOR and dumb terminals disable colour; a pipe never gets colour", () => {
    expect(detectEnv({ NO_COLOR: "1" }, true).color).toBe(false);
    expect(detectEnv({ TERM: "dumb" }, true).color).toBe(false);
    expect(detectEnv({}, false).color).toBe(false);
    expect(detectEnv({ NO_COLOR: "" }, true).color).toBe(true); // empty means unset, per no-color.org
    expect(detectEnv({ NO_COLOR: "1" }, true, { color: true }).color).toBe(true); // explicit --color wins
  });
  test("non-UTF-8 locale falls back to ascii glyphs", () => {
    expect(detectEnv({ LANG: "C" }, true).ascii).toBe(true);
    expect(detectEnv({ LANG: "en_US.UTF-8" }, true).ascii).toBe(false);
    expect(detectEnv({}, true).ascii).toBe(false);
  });
});

describe("watch", () => {
  test("not a TTY: line log, no escapes, ends with a summary", async () => {
    const { io, out } = fakeIO({ tty: false });
    expect(await watch({ replay: FIXTURE }, io)).toBe(0);
    const text = out.join("");
    expect(text).not.toContain("\x1b");
    const lines = text.trim().split("\n");
    expect(lines[0]).toStartWith("hello mode=replay model=stand-in chain=10143");
    expect(lines).toContain("gen 0 start planned=200");
    expect(lines.some((l) => l.startsWith("gen 9 end best_idx="))).toBe(true);
    expect(lines.some((l) => l.startsWith("gen 7 sealed idx=182 dev=+604 confirm=+242 sealed=+145"))).toBe(true);
    expect(lines.some((l) => / reverted /.test(l))).toBe(true);
    expect(lines.some((l) => / lost /.test(l))).toBe(true);
    expect(lines.at(-1)).toBe("end events=4225 evals=1999 reverted=1 lost=1 gens_done=10");
    expect(lines.length).toBeLessThan(200); // notable events only, not 4225 lines
  });
  test("--lines forces the line log even on a TTY; BLOCKWISE_NO_TUI=1 too", async () => {
    for (const [args, env] of [[{ replay: FIXTURE, lines: true }, {}], [{ replay: FIXTURE }, { BLOCKWISE_NO_TUI: "1" }]] as const) {
      const { io, out } = fakeIO({ tty: true, env });
      await watch(args, io);
      expect(out.join("")).not.toContain("\x1b");
    }
  });
  test("TTY: alternate screen in, frame drawn, alternate screen out", async () => {
    const { io, out } = fakeIO({ tty: true, env: { NO_COLOR: "1" } });
    expect(await watch({ replay: FIXTURE, speed: Infinity, exitAtEnd: true }, io)).toBe(0);
    expect(out[0]).toBe(ALT_ON);
    expect(out.at(-1)).toBe(ALT_OFF);
    const text = out.join("");
    expect(text).toContain("BLOCKWISE");
    expect(text).toContain("end of recording");
    expect(text).not.toMatch(/\x1b\[[0-9;]*m/); // NO_COLOR: not one SGR sequence
  });
  test("--frame prints one frame of the requested size", async () => {
    const { io, out } = fakeIO({ tty: false });
    await watch({ replay: FIXTURE, frame: true, at: 700, width: 100, height: 30 }, io);
    const lines = out.join("").trimEnd().split("\n");
    expect(lines.length).toBe(30);
    expect(out.join("")).not.toContain("\x1b");
    expect(out.join("")).toContain("700 of 4225 events");
  });
  test("a bad recording says where and what", () => {
    expect(() => parseJsonl('{"type":"hello"}\nnot json\n', "x.jsonl")).toThrow(/x\.jsonl:2: not JSON/);
    expect(() => parseJsonl('{"a":1}\n', "x.jsonl")).toThrow(/without a "type"/);
    expect(() => readEvents("/nonexistent/run.jsonl")).toThrow(SourceError);
    expect(() => readEvents("/nonexistent/run.jsonl")).toThrow(/no such file.*fixtures\/events\.sample\.jsonl/);
  });
});

describe("pacing", () => {
  const evs = (n: number): Ev[] => Array.from({ length: n }, (_, i) => ({ type: "error", scope: "t", message: String(i), t: i * 1000 }) as Ev);
  test("waits recorded time divided by speed", async () => {
    let waited = 0;
    const pace = { speed: 10, paused: false };
    for await (const _ of paced(evs(5), pace, async (ms) => { waited += ms; })) { /* drain */ }
    expect(Math.round(waited)).toBe(400); // 4 gaps of 1000 ms at 10x
  });
  test("max speed does not wait", async () => {
    let waited = 0;
    for await (const _ of paced(evs(5), { speed: Infinity, paused: false }, async (ms) => { waited += ms; })) { /* drain */ }
    expect(waited).toBe(0);
  });
  test("pause holds the next event until resumed; stop ends the stream", async () => {
    const pace = { speed: Infinity, paused: true, stop: false };
    let sleeps = 0;
    const it = paced(evs(3), pace, async () => { if (++sleeps === 3) pace.paused = false; });
    const first = await it.next();
    expect(first.done).toBe(false);
    expect(sleeps).toBe(3);
    pace.stop = true;
    expect((await it.next()).done).toBe(true);
  });
});

describe("live source", () => {
  test("url forms", () => {
    expect(liveUrls("http://localhost:8787").events).toBe("http://localhost:8787/events");
    expect(liveUrls("localhost:8787/events").history).toBe("http://localhost:8787/history?n=20000");
    expect(() => liveUrls("http://")).toThrow(/Example: --live/);
  });
  test("history then stream, no duplicates, reset first", async () => {
    const bus = new Bus({});
    const server = bus.serve(0);
    const hello = events[0]!;
    bus.emit(hello, 0); bus.emit(events[1]!, 1); bus.emit(events[2]!, 2);
    const ac = new AbortController();
    const got: string[] = [];
    const done = (async () => {
      for await (const it of liveEvents(`http://localhost:${server.port}`, ac.signal)) {
        if (it.type === "__status") continue;
        got.push(it.type === "__reset" ? "reset" : `${it.type}@${(it as Ev).t}`);
        if (got.length >= 7) ac.abort();
      }
    })();
    await Bun.sleep(300);
    bus.emit(events[3]!, 3); bus.emit(events[4]!, 4);
    await Promise.race([done, Bun.sleep(3000)]);
    ac.abort(); server.stop(true);
    expect(got[0]).toBe("reset");
    const typed = got.slice(1);
    expect(typed.length).toBe(new Set(typed).size); // no event twice (hello is on the stream and in the history)
    expect(typed.map((x) => x.split("@")[1])).toEqual(["0", "1", "2", "3", "4"]);
  });
  test("an unreachable server is retried, not fatal; abort ends it", async () => {
    const ac = new AbortController();
    const seen: string[] = [];
    setTimeout(() => ac.abort(), 400);
    for await (const it of liveEvents("http://127.0.0.1:1", ac.signal, fetch, [50])) if (it.type === "__status") seen.push(it.text);
    expect(seen[0]).toContain("connecting");
    expect(seen.some((t) => t.startsWith("disconnected"))).toBe(true);
    expect(seen.some((t) => t.startsWith("reconnecting"))).toBe(true);
  });
});

describe("report", () => {
  const r = buildReport(events, "fixtures/events.sample.jsonl");
  test("numbers come from the stream", () => {
    expect(r.evals).toEqual({ landed: 1999, success: 1998, reverted: 1, lost: 1 });
    expect(r.champion).toMatchObject({ gen: 7, idx: 182, dev: 604, confirm: 242, sealed: 145, trades: 9 });
    expect(r.run).toMatchObject({ mode: "replay", model: "stand-in", chainId: 10143, generationsComplete: 10, generationsPlanned: 10 });
    expect(r.landing.blocksSpanned).toBe(45);
    expect(r.gas.totalMon).toBeCloseTo(18.97, 2);
  });
  test("text states what we may and may not claim", () => {
    const t = formatReport(r);
    for (const n of ["What we may claim", "What we may not claim", "dev +604 -> confirm +242 -> sealed +145", "1 lost", "stand-in", "replay of a recording", "one seed", "test MON"]) expect(t.toLowerCase()).toContain(n.toLowerCase());
    expect(t).not.toContain("\x1b");
  });
  test("without a sealed look no out-of-sample claim is made", () => {
    const cut = events.filter((e) => e.type !== "sealed");
    const t = formatReport(buildReport(cut, "x"));
    expect(t).toContain("No sealed look was recorded");
    expect(t).toContain("selected number");
  });
  test("an incomplete run is said to be incomplete", () => {
    const t = formatReport(buildReport(events.slice(0, 700), "x"));
    expect(t).toContain("Only 1 of 10 planned generations completed");
  });
  test("--json is one parseable object with stable keys", () => {
    const { io, out } = fakeIO({ tty: false });
    expect(cmdReport(["report", FIXTURE], { json: true }, io)).toBe(0);
    const j = JSON.parse(out.join(""));
    expect(Object.keys(j)).toEqual(["file", "events", "run", "champion", "evals", "landing", "gas", "baseline", "judge", "errors", "claims", "notClaimed"]);
  });
  test("surfaces read events only: no wallet, key or chain code is imported under tui/", async () => {
    for await (const f of new Bun.Glob("tui/*.ts").scan({ cwd: join(import.meta.dir, "../src") })) {
      const src = await Bun.file(join(import.meta.dir, "../src", f)).text();
      expect(src).not.toMatch(/@blockwise\/chain|Wallets|loadMnemonic|MNEMONIC|privateKey/);
    }
  });
});

describe("cli ergonomics", () => {
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["bun", CLI, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, stdout, stderr };
  };
  test("typos are suggested", () => {
    expect(nearest("wach", ["watch", "report", "run"])).toBe("watch");
    expect(checkFlags("run", { gen: "3" })).toContain("Did you mean --gens?");
    expect(checkFlags("run", { gens: "3", yes: true })).toBeNull();
  });
  test("version, help, per-command help", async () => {
    expect((await run("--version")).stdout).toMatch(/^blockwise \d+\.\d+\.\d+/);
    const h = await run("help");
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("watch");
    expect(h.stdout).toContain("exit:");
    expect((await run("watch", "--help")).stdout).toContain("usage:   bun run orch watch");
  });
  test("errors say what to do next and exit 1", async () => {
    let r = await run("watch");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("watch needs a source");
    expect(r.stderr).toContain("try: bun run orch watch --replay fixtures/events.sample.jsonl");
    r = await run("wach");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Did you mean "watch"?');
    r = await run("run", "--gen", "3");
    expect(r.stderr).toContain("Did you mean --gens?");
    r = await run("report", "nope.jsonl");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no such file");
    r = await run("watch", "--replay", FIXTURE, "--speed", "fast");
    expect(r.stderr).toContain("--speed needs a number");
    r = await run("serve");
    expect(r.stderr).toContain("Example: bun run orch serve --replay");
  });
  test("report works end to end from the CLI, flag order does not matter", async () => {
    const a = await run("report", "--json", FIXTURE);
    expect(a.code).toBe(0);
    expect(JSON.parse(a.stdout).champion.sealed).toBe(145);
    const b = await run("watch", "--replay", FIXTURE, "--lines");
    expect(b.code).toBe(0);
    expect(b.stdout).toContain("end events=4225");
  });
});
