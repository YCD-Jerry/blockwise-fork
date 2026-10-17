import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANVIL_DEV_MNEMONIC, RpcPool, Wallets, connect, deployAll, loadSeries } from "@blockwise/chain";
import { Bus } from "../src/bus";
import { runLoop } from "../src/run";
import { replay } from "../src/replay";
import { standInColony } from "./standin-colony";

const has = Bun.which("anvil") !== null;
const t = has ? test : test.skip;
let stop = () => {};
const wallets = new Wallets(ANVIL_DEV_MNEMONIC);

beforeAll(async () => {
  if (!has) return;
  const p = Bun.spawn(["anvil", "--chain-id", "31337", "--port", "18546", "--silent"], { stdout: "ignore", stderr: "ignore" });
  stop = () => p.kill();
  for (let i = 0; i < 100; i++) { try { await fetch("http://127.0.0.1:18546", { method: "POST", body: "{}" }); break; } catch { await Bun.sleep(100); } }
  process.env.BLOCKWISE_ALLOW_OTHER_CHAIN = "1";
  process.env.BLOCKWISE_CONFIG_ROOT = mkdtempSync(join(tmpdir(), "bw-orch-"));
});
afterAll(() => stop());

t("loop with stand-in colony: all events, resume, no key in output, replay", async () => {
  const ctx = await connect(new RpcPool(["http://127.0.0.1:18546"]));
  const gp = 2_000_000_000n;
  await deployAll(ctx, wallets.deployer, gp);
  const series = loadSeries();
  const file = join(process.env.BLOCKWISE_CONFIG_ROOT!, "run.jsonl");
  const logs: string[] = [];
  const bus = new Bus({ file });
  const base = { perGen: 12, workers: 4, confirmK: 3, seed: 1, gasPrice: gp, series, makeColony: standInColony, judge: "stand-in" as const, log: (s: string) => logs.push(s) };
  expect(await runLoop(ctx, wallets, bus, { ...base, gens: 3 })).toBe("done");
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const types = new Set(lines.map((l) => l.type));
  for (const ty of ["hello", "generation_start", "tx_sent", "tx_landed", "block", "generation_end", "map", "confirm", "sealed", "baseline", "totals", "judge"]) expect(types.has(ty)).toBe(true);
  expect(lines.filter((l) => l.type === "tx_landed" && l.status === "success").length).toBe(36);
  // resume: a second run to 4 generations only runs gen 4
  const bus2 = new Bus({});
  await runLoop(ctx, wallets, bus2, { ...base, gens: 4 });
  expect(bus2.history.filter((e) => e.type === "generation_start").map((e: any) => e.gen)).toEqual([4]);
  // budget refusal: unfunded deployer
  const poor = new Wallets("legal winner thank year wave sausage worth useful legal winner thank yellow");
  const bus3 = new Bus({});
  expect(await runLoop(ctx, poor, bus3, { ...base, gens: 1 })).toBe("budget");
  expect(bus3.history.some((e) => e.type === "error" && e.scope === "budget")).toBe(true);
  // no secret in anything emitted
  const blob = JSON.stringify(bus.history) + logs.join("\n");
  expect(blob).not.toContain("test test test");
  expect(blob).not.toContain("junk");
  // replay serves recorded events as mode replay
  const r = replay(file, 18802, 1000);
  await Bun.sleep(600);
  const h = (await (await fetch("http://127.0.0.1:18802/history")).json()) as any[];
  expect(h[0].type).toBe("hello"); expect(h[0].mode).toBe("replay");
  expect(h.length).toBe(r.count);
  r.server.stop(true);
}, 120_000);

t("CLI: wrong chain exits 5, deploy output never contains the mnemonic", async () => {
  const env = { ...process.env, RPC_URL: "http://127.0.0.1:18546", MNEMONIC: ANVIL_DEV_MNEMONIC, GAS_PRICE_GWEI: "2", BLOCKWISE_CONFIG_ROOT: process.env.BLOCKWISE_CONFIG_ROOT! };
  delete (env as any).BLOCKWISE_ALLOW_OTHER_CHAIN;
  const cli = join(import.meta.dir, "../src/cli.ts");
  const bad = Bun.spawnSync(["bun", cli, "deploy"], { env: env as any });
  expect(bad.exitCode).toBe(5);
  const ok = Bun.spawnSync(["bun", cli, "deploy", "--local"], { env: env as any });
  expect(ok.exitCode).toBe(0);
  const all = ok.stdout.toString() + ok.stderr.toString() + bad.stderr.toString();
  for (const w of ["test test", "junk"]) expect(all).not.toContain(w);
  expect(all).toContain("0x"); // addresses are fine
}, 60_000);
