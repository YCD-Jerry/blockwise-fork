import { encodeFunctionData } from "viem";
import { NonceBook, evaluatorAbi, fanOut, fundWorkers, landingReport, loadDeployment, type Wallets, type Ctx } from "@blockwise/chain";
import { loadGas, saveGas } from "./gas";

const SMOKE_GEN = 900_000; // never collides with run generations

export async function smoke(ctx: Ctx, wallets: Wallets, o: { txs: number; workers: number; gasPrice: bigint; write: boolean; log: (s: string) => void }) {
  const dep = loadDeployment(ctx.chainId);
  const gas = loadGas(ctx.chainId);
  const ws = wallets.workers(o.workers);
  const per = Math.ceil(o.txs / o.workers) + 2;
  const need = BigInt(per) * 600_000n * o.gasPrice;
  o.log(`budget: ${o.txs} txs + confirm + sealed, per-worker reserve ${Number(need) / 1e18} MON x ${o.workers} workers (smoke uses a loose 600k limit to measure)`);
  const f = await fundWorkers(ctx.pool, wallets.deployer, ws.map((w) => w.address), need, ctx.chainId, o.gasPrice);
  o.log(`funded ${f.funded.length} workers, total ${Number(f.total) / 1e18} MON`);
  const accounts = [wallets.deployer, ...ws];
  const book = new NonceBook(); await book.sync(ctx.pool, ws.map((w) => w.address));
  const base = Date.now() % 1_000_000; // unique idx per smoke run
  const spec = (i: number) => [(i % 7) - 3, 2, -1, 3, 0, -2, 50 + i] as any;
  const jobs = Array.from({ length: o.txs }, (_, i) => ({
    key: `${SMOKE_GEN}:${base + i}`, worker: 1 + (i % o.workers), to: dep.contracts.evaluator, gas: 600_000n,
    data: encodeFunctionData({ abi: evaluatorAbi, functionName: "evaluate", args: [SMOKE_GEN, base + i, spec(i), { operator: 0, parentGen: 0, parentIdx: 0 }] }),
  }));
  const t0 = Date.now();
  const outs = await fanOut(ctx.pool, accounts, book, jobs, ctx.chainId, o.gasPrice);
  const rep = landingReport(outs);
  const used = outs.filter((x) => x.gasUsed).map((x) => x.gasUsed!);
  const maxUsed = used.length ? Math.max(...used) : 0;
  // one confirm and one sealed look to measure their gas too
  const probe = outs.find((x) => x.status === "success");
  let confUsed = 0, sealUsed = 0;
  if (probe) {
    const i = Number(probe.job.key.split(":")[1]) - base;
    const w = probe.job.worker;
    const mk = (fn: "confirm" | "sealedLook") => ({ key: fn, worker: w, to: dep.contracts.evaluator, gas: 600_000n, data: encodeFunctionData({ abi: evaluatorAbi, functionName: fn, args: [SMOKE_GEN, base + i, spec(i)] }) });
    const c = await fanOut(ctx.pool, accounts, book, [mk("confirm")], ctx.chainId, o.gasPrice);
    const s = await fanOut(ctx.pool, accounts, book, [mk("sealedLook")], ctx.chainId, o.gasPrice);
    confUsed = c[0]?.gasUsed ?? 0; sealUsed = s[0]?.gasUsed ?? 0;
  }
  const lim = (u: number) => Math.ceil(u * 1.15);
  const g = { evaluate: lim(maxUsed), confirm: lim(confUsed || maxUsed), sealed: lim(sealUsed || maxUsed) };
  if (o.write && maxUsed) saveGas(ctx.chainId, g);
  const price = Number(o.gasPrice) / 1e9;
  const out = { txs: o.txs, workers: o.workers, landed: rep.landed, reverted: rep.reverted, lost: rep.lost, wallMs: Date.now() - t0, blocks: rep, gasUsedMax: maxUsed, confirmGasUsed: confUsed, sealedGasUsed: sealUsed, suggestedGasLimit: g, rpc: { requests: ctx.pool.requests, retries: ctx.pool.retries }, previousLimits: { evaluate: Number(gas.evaluate) } };
  const date = new Date().toISOString().slice(0, 10);
  const net = ctx.chainId === 10143 ? "Monad testnet" : `local chain ${ctx.chainId} (NOT Monad)`;
  const row = `| A1/A2 smoke ${o.txs} txs x ${o.workers} workers (${date}, ${net}) | landed ${rep.landed}/${o.txs}, reverted ${rep.reverted}, lost ${rep.lost}; blocks ${rep.first}..${rep.last} (span ${rep.span}); histogram ${JSON.stringify(rep.histogram)}; latency p50 ${rep.latency.p50} ms p90 ${rep.latency.p90} ms; evaluate gasUsed max ${maxUsed}, confirm ${confUsed}, sealed ${sealUsed}; GAS_LIMIT = ${g.evaluate} (x1.15), price ${price} gwei | \`bun run orch smoke --txs ${o.txs} --workers ${o.workers}\` |`;
  return { out, row };
}
