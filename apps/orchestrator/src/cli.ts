#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ChainGuardError, REPO_ROOT, RpcPool, Wallets, connect, deployAll, gasPriceWei, loadMnemonic, loadSeries, rpcUrlsFromEnv, MONAD_TESTNET_ID, loadDeployment } from "@blockwise/chain";
import { createColony } from "@blockwise/core";
import { Bus } from "./bus";
import { replay } from "./replay";
import { runLoop } from "./run";
import { smoke } from "./smoke";
import { BOOL_FLAGS, COMMANDS, EXIT, UsageError, checkFlags, commandHelp, nearest, numFlag, usage } from "./cli-meta";
import { cmdReport, cmdWatch } from "./tui/commands";
import pkg from "../package.json";

function parse(argv: string[]) {
  const flags: Record<string, string | true> = {}; const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const k = a.slice(2); const n = argv[i + 1];
      if (!BOOL_FLAGS.has(k) && n !== undefined && !n.startsWith("--")) { flags[k] = n; i++; } else flags[k] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}
const err = (s: string) => process.stderr.write(s + "\n");

async function main() {
  const { flags, pos } = parse(process.argv.slice(2));
  const cmd = pos[0];
  if (flags.version) { console.log(`blockwise ${pkg.version}`); return 0; }
  if (cmd === "help" && pos[1] && COMMANDS[pos[1]]) { console.log(commandHelp(pos[1])); return 0; }
  if (!cmd || cmd === "help") { console.log(usage()); return 0; }
  if (flags.help && COMMANDS[cmd]) { console.log(commandHelp(cmd)); return 0; }
  if (!COMMANDS[cmd]) { const n = nearest(cmd, Object.keys(COMMANDS)); err(`unknown command "${cmd}".${n ? ` Did you mean "${n}"?` : ""} Run \`bun run orch help\` for the list.`); return EXIT.usage; }
  const bad = checkFlags(cmd, flags);
  if (bad) { err(bad); return EXIT.usage; }
  const num = (k: string, d: number) => numFlag(flags, k, d);
  if (flags.local) process.env.BLOCKWISE_ALLOW_OTHER_CHAIN = "1";

  if (cmd === "watch") return cmdWatch(flags);
  if (cmd === "report") return cmdReport(pos, flags);

  if (cmd === "serve") {
    if (typeof flags.replay !== "string") { err("serve needs --replay FILE (a recording). Example: bun run orch serve --replay fixtures/events.sample.jsonl"); return 1; }
    const port = num("port", 8787);
    const r = replay(flags.replay, port, num("speed", 1), !!flags.loop);
    err(`replaying ${r.count} events on http://localhost:${port}/events (mode replay)`);
    await new Promise(() => {});
    return 0;
  }

  const pool = new RpcPool(rpcUrlsFromEnv());
  let ctx;
  try { ctx = await connect(pool); } catch (e) {
    if (e instanceof ChainGuardError) { err(e.message); return 5; }
    err(`cannot reach RPC: ${(e as Error).message}\n  set RPC_URL (or RPC_URLS, comma-separated) to a reachable endpoint; for a local anvil: RPC_URL=http://127.0.0.1:8545 ... --local`); return 1;
  }
  let wallets: Wallets;
  try { wallets = new Wallets(loadMnemonic({ local: ctx.chainId !== MONAD_TESTNET_ID })); } catch (e) { err((e as Error).message); return 1; }
  const gasPrice = gasPriceWei();
  err(`using chain=${ctx.chainId} rpc=${pool.eps.map((e) => new URL(e.url).host).join(",")} deployer=${wallets.deployer.address} gasPrice=${Number(gasPrice) / 1e9} gwei`);

  if (cmd === "deploy") {
    const bal = BigInt(await pool.request<string>("eth_getBalance", [wallets.deployer.address, "latest"]));
    err(`deployer balance ${Number(bal) / 1e18}`);
    if (bal < 3_000_000n * gasPrice) { err("deployer cannot cover the deploy budget (~3M gas x price)"); return 4; }
    const dep = await deployAll(ctx, wallets.deployer, gasPrice, { log: err });
    console.log(JSON.stringify(dep, null, 2));
    return 0;
  }

  if (cmd === "smoke") {
    const txs = num("txs", 20), workers = num("workers", 10);
    const { out, row } = await smoke(ctx, wallets, { txs, workers, gasPrice, write: !!flags.write, log: err });
    console.log(JSON.stringify(out, null, 2));
    if (!flags.json) console.log("\n# suggested row for docs/monad-notes.md (Measured table):\n" + row);
    return out.landed === 0 ? 1 : 0;
  }

  if (cmd === "run") {
    const gens = num("gens", 10), perGen = num("per-gen", 200), workers = num("workers", 20), confirmK = num("confirm-k", 8);
    const series = loadSeries();
    const dep = loadDeployment(ctx.chainId);
    const { loadGas } = await import("./gas");
    const g = loadGas(ctx.chainId);
    const txs = gens * (perGen + confirmK) + 1;
    const budget = BigInt(txs) * g.evaluate * gasPrice;
    err(`budget: ${txs} txs x ${g.evaluate} gas x ${Number(gasPrice) / 1e9} gwei = ${Number(budget) / 1e18} MON (+ funding transfers); epoch ${dep.epoch.slice(0, 10)}...`);
    const bal = BigInt(await pool.request<string>("eth_getBalance", [wallets.deployer.address, "latest"]));
    if (bal < budget / 2n) { err(`deployer holds ${Number(bal) / 1e18} MON, less than half the budget; refusing (exit 4). Lower --gens/--per-gen or fund the deployer.`); return 4; }
    if (ctx.chainId === MONAD_TESTNET_ID && !flags.yes) { err("this spends testnet gas (see the budget above): re-run the same command with --yes to confirm"); return 4; }
    mkdirSync(join(REPO_ROOT, "runs"), { recursive: true });
    const file = join(REPO_ROOT, "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    const bus = new Bus({ stdout: true, file });
    const port = num("port", 8787);
    if (!flags["no-serve"]) { bus.serve(port); err(`SSE on http://localhost:${port}/events  history /history`); }
    err(`recording to ${file}`);
    const stop = { flag: false };
    for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => { err("stop requested; finishing the current step"); stop.flag = true; });
    if (flags.judge !== undefined && flags.judge !== "off" && flags.judge !== "stand-in") err(`--judge ${flags.judge} is not wired yet; using stand-in (labelled). Valid values: stand-in, off`);
    const judge = flags.judge === "off" ? "off" : "stand-in"; // Jev not wired: stand-in mock only, labelled
    const reason = await runLoop(ctx, wallets, bus, { gens, perGen, workers, confirmK, seed: num("seed", 1), gasPrice, series, makeColony: createColony, judge, stop, log: err, timeoutMs: num("timeout", 60) * 1000 });
    err(`run finished: ${reason}`);
    if (flags.hold) await new Promise(() => {});
    return 0;
  }
  err(`unknown command ${cmd}`); return EXIT.usage;
}

main().then((c) => process.exit(c), (e) => {
  if (e instanceof UsageError) { err(e.message); process.exit(EXIT.usage); }
  err(`error: ${(e as Error).message}`); process.exit(1);
});
