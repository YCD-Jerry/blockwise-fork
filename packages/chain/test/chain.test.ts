import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData } from "viem";
import { ANVIL_DEV_MNEMONIC, ChainGuardError, NonceBook, RpcPool, Wallets, assertChainAllowed, computeEpoch, connect, deployAll, evaluatorAbi, fanOut, fundWorkers, gasPriceWei, landingReport, loadSeries, readState } from "../src";
import { hasAnvil, startAnvil } from "./anvil";

describe("chain guard", () => {
  test("refuses a wrong chain id", () => {
    expect(() => assertChainAllowed(1, {})).toThrow(ChainGuardError);
    expect(() => assertChainAllowed(31337, {})).toThrow(ChainGuardError);
    expect(() => assertChainAllowed(10143, {})).not.toThrow();
    expect(() => assertChainAllowed(31337, { BLOCKWISE_ALLOW_OTHER_CHAIN: "1" })).not.toThrow();
  });
  test("epoch is deterministic", () => {
    expect(computeEpoch(loadSeries())).toBe(computeEpoch(loadSeries()));
  });
  test("wallet object does not stringify keys", () => {
    const w = new Wallets("test test test test test test test test test test test junk");
    w.at(0);
    expect(JSON.stringify(w)).not.toContain("test test");
  });
});

const d = hasAnvil ? describe : describe.skip;
d("anvil", () => {
  let stop = () => {}; let ctx: Awaited<ReturnType<typeof connect>>; let root: string;
  const wallets = new Wallets(ANVIL_DEV_MNEMONIC);
  const gp = gasPriceWei({ GAS_PRICE_GWEI: "2" } as any);
  beforeAll(async () => {
    const a = await startAnvil(18545); stop = a.stop;
    process.env.BLOCKWISE_ALLOW_OTHER_CHAIN = "1";
    ctx = await connect(new RpcPool([a.url]));
    root = mkdtempSync(join(tmpdir(), "bw-"));
  });
  afterAll(() => stop());

  test("connect refuses 31337 without the override", async () => {
    await expect(connect(new RpcPool(["http://127.0.0.1:18545"]), {} as any)).rejects.toThrow(ChainGuardError);
  });

  test("deploy: epoch matches, config written", async () => {
    const dep = await deployAll(ctx, wallets.deployer, gp, { root });
    expect(dep.epoch).toBe(computeEpoch(loadSeries()));
    const f = JSON.parse(readFileSync(join(root, "config/deployments.local.json"), "utf8"));
    expect(f.contracts.evaluator).toBe(dep.contracts.evaluator);
    expect(f.explorer).toBe("https://testnet.monadvision.com");
    expect(f.chainId).toBe(31337);

    // fan-out smoke: 20 txs from 10 workers
    const K = 10, gas = 600_000n;
    const workers = wallets.workers(K);
    await fundWorkers(ctx.pool, wallets.deployer, workers.map((w) => w.address), gas * gp * 2n, ctx.chainId, gp);
    const book = new NonceBook(); await book.sync(ctx.pool, workers.map((w) => w.address));
    const accounts = [wallets.deployer, ...workers];
    const jobs = Array.from({ length: 20 }, (_, i) => ({
      key: `0:${i}`, worker: 1 + (i % K), to: dep.contracts.evaluator, gas,
      data: encodeFunctionData({ abi: evaluatorAbi, functionName: "evaluate", args: [777, i, [i - 5, 3, -2, 1, 0, 7, 100 + i], { operator: 0, parentGen: 0, parentIdx: 0 }] }),
    }));
    const outs = await fanOut(ctx.pool, accounts, book, jobs, ctx.chainId, gp);
    expect(outs.every((o) => o.status === "success")).toBe(true);
    const rep = landingReport(outs);
    expect(rep.landed).toBe(20);
    const st = await readState(ctx, dep.contracts.evaluator, dep.deployBlock, { chunk: 7 });
    expect(st.devs.length).toBe(20);
    expect(st.devs.find((x) => x.idx === 3)!.params[6]).toBe(103);
    // lost tx: unfunded sender is a send failure, counted not thrown
    const bad = await fanOut(ctx.pool, [wallets.at(15)], new NonceBook(), [{ key: "x", worker: 0, to: dep.contracts.evaluator, gas, data: "0x" }], ctx.chainId, gp, { timeoutMs: 500 });
    expect(bad[0]!.status).toBe("lost");
  }, 60_000);
});
