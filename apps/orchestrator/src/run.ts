// The generation loop (architecture section 3). Colony is injected so tests can use a stand-in.
import { decodeEventLog, encodeFunctionData, type Address } from "viem";
import { NonceBook, evaluatorAbi, fanOut, landingReport, loadDeployment, readState, type Ctx, type Outcome, type TxJob, type Wallets, EXPLORER } from "@blockwise/chain";
import { randomBaseline, type Candidate, type Colony, type ColonyConfig, type EvalRecord, type Operator, type Ref } from "@blockwise/core";
import type { Bus } from "./bus";
import { loadGas } from "./gas";
import { standInJudge } from "./judge";

export interface RunOpts {
  gens: number; perGen: number; workers: number; confirmK: number; seed: number; gasPrice: bigint;
  series: { devEnd: number; confirmEnd: number; returns: number[] };
  makeColony: (cfg: ColonyConfig) => Colony;
  judge: "off" | "stand-in";
  timeoutMs?: number;
  stop?: { flag: boolean };
  log: (s: string) => void;
}

const i16 = (a: readonly number[]) => a.map(Number);

function decodeFor(o: Outcome, evaluator: Address) {
  for (const l of o.logs ?? []) {
    if (l.address.toLowerCase() !== evaluator.toLowerCase()) continue;
    try { return decodeEventLog({ abi: evaluatorAbi, data: l.data, topics: l.topics as any }); } catch {}
  }
  return null;
}

export async function runLoop(ctx: Ctx, wallets: Wallets, bus: Bus, o: RunOpts): Promise<string> {
  const dep = loadDeployment(ctx.chainId);
  const evaluator = dep.contracts.evaluator;
  const gas = loadGas(ctx.chainId);
  const maxGas = [gas.evaluate, gas.confirm, gas.sealed].reduce((a, b) => (a > b ? a : b));
  const ws = wallets.workers(o.workers);
  const accounts = [wallets.deployer, ...ws];
  const wIndexOf = new Map(ws.map((w, i) => [w.address.toLowerCase(), i]));
  const book = new NonceBook();
  const owner = new Map<string, number>(); // "gen:idx" -> index into accounts
  const spec = new Map<string, number[]>();
  const rk = (gen: number, idx: number) => `${gen}:${idx}`;

  const model = o.judge === "stand-in" ? "stand-in" : "none";
  bus.emit({
    type: "hello", epoch: dep.epoch, chainId: ctx.chainId,
    contracts: { evaluator, ledger: dep.contracts.ledger, judgeLog: dep.contracts.judgeLog },
    config: { n: o.series.returns.length, devEnd: o.series.devEnd, confirmEnd: o.series.confirmEnd, workers: o.workers, perGeneration: o.perGen, generations: o.gens },
    mode: "live", model, explorer: dep.explorer ?? EXPLORER,
  });

  const colony = o.makeColony({ seed: o.seed, perGeneration: o.perGen, generations: o.gens, confirmTopK: o.confirmK, roles: { devEnd: o.series.devEnd, confirmEnd: o.series.confirmEnd }, returns: o.series.returns });

  // resume: rebuild from chain
  const st = await readState(ctx, evaluator, dep.deployBlock, { proposers: ws.map((w) => w.address) });
  let lastGen = 0;
  const sealedDone = new Set(st.sealed.map((s) => rk(s.gen, s.idx)));
  if (st.devs.length) {
    const recs: EvalRecord[] = st.devs.filter((d) => d.gen < 900_000).map((d) => ({ gen: d.gen, idx: d.idx, spec: d.params, operator: d.operator as Operator, parent: d.parent, dev: d.dev, trades: d.trades }));
    for (const d of st.devs) { owner.set(rk(d.gen, d.idx), 1 + (wIndexOf.get(d.proposer.toLowerCase()) ?? 0)); spec.set(rk(d.gen, d.idx), d.params); if (d.gen < 900_000) lastGen = Math.max(lastGen, d.gen); }
    colony.restore(recs, st.confirms.filter((c) => c.gen < 900_000).map((c) => ({ ref: { gen: c.gen, idx: c.idx }, score: c.score, trades: c.trades })));
    o.log(`resumed from chain: ${recs.length} dev records, ${st.confirms.length} confirms, last generation ${lastGen}`);
  }

  const baseline = randomBaseline({ returns: o.series.returns, roles: { devEnd: o.series.devEnd, confirmEnd: o.series.confirmEnd }, perGeneration: o.perGen, generations: o.gens, seeds: 5, seed: o.seed });

  const T = { evals: 0, reverted: 0, lost: 0, gasWei: 0n, blocks: 0 };
  const totals = () => bus.emit({ type: "totals", evals: T.evals, reverted: T.reverted, lost: T.lost, gasMon: Number(T.gasWei) / 1e18, jevUsd: 0, blocksSpanned: T.blocks });
  const timeoutMs = o.timeoutMs ?? 60_000;

  const ensureFunds = async (txsPerWorker: number, totalTxs: number): Promise<boolean> => {
    const need = BigInt(txsPerWorker) * maxGas * o.gasPrice;
    const addrs = ws.map((w) => w.address);
    const reads = await ctx.pool.batch([...addrs, wallets.deployer.address].map((a) => ({ method: "eth_getBalance", params: [a, "latest"] })));
    const bals = reads.map((r) => { if (!("result" in r)) throw new Error(r.error.message); return BigInt(r.result); });
    const deficit = bals.slice(0, -1).reduce((a, b) => a + (b < need ? need - b : 0n), 0n);
    const transferGas = BigInt(o.workers) * 21000n * o.gasPrice;
    if (bals[bals.length - 1]! < deficit + transferGas) {
      bus.emit({ type: "error", scope: "budget", message: `cannot pay for ${totalTxs} txs: need ${Number(deficit + transferGas) / 1e18} MON more than deployer holds (${Number(bals[bals.length - 1]!) / 1e18})` });
      return false;
    }
    if (deficit > 0n) {
      const { fundWorkers } = await import("@blockwise/chain");
      await fundWorkers(ctx.pool, wallets.deployer, addrs, need, ctx.chainId, o.gasPrice);
    }
    return true;
  };

  const sendJobs = async (jobs: TxJob[], onSigned?: (s: any[]) => void) => {
    const addrs = [...new Set(jobs.map((j) => accounts[j.worker]!.address))];
    await book.sync(ctx.pool, addrs);
    return fanOut(ctx.pool, accounts, book, jobs, ctx.chainId, o.gasPrice, { timeoutMs, onSigned });
  };
  const count = (outs: Outcome[]) => {
    for (const x of outs) { if (x.status === "lost") T.lost++; else { T.evals++; if (x.status === "reverted") T.reverted++; } if (x.sendState !== "failed") T.gasWei += BigInt(x.job.gas) * o.gasPrice; }
  };

  let stopReason = "";
  for (let gen = lastGen + 1; gen <= o.gens; gen++) {
    if (o.stop?.flag) { stopReason = "stopped"; break; }
    const plan = colony.planGeneration(gen);
    const N = plan.candidates.length;
    const perWorker = Math.ceil(N / o.workers) + Math.ceil(o.confirmK / o.workers) + (gen === o.gens ? 1 : 0);
    if (!(await ensureFunds(perWorker, N + o.confirmK))) { stopReason = "budget"; break; }
    bus.emit({ type: "generation_start", gen, planned: N, allocation: plan.allocation });

    const jobs: TxJob[] = plan.candidates.map((c) => {
      const w = 1 + (c.idx % o.workers);
      owner.set(rk(c.gen, c.idx), w); spec.set(rk(c.gen, c.idx), i16(c.spec));
      return { key: rk(c.gen, c.idx), worker: w, to: evaluator, gas: gas.evaluate, data: encodeFunctionData({ abi: evaluatorAbi, functionName: "evaluate", args: [c.gen, c.idx, i16(c.spec) as any, { operator: c.operator, parentGen: c.parent?.gen ?? 0, parentIdx: c.parent?.idx ?? 0 }] }) };
    });
    const byKey = new Map(plan.candidates.map((c) => [rk(c.gen, c.idx), c]));

    if (o.judge === "stand-in") {
      for (const c of plan.candidates.slice(0, Math.min(20, N))) bus.emit({ type: "judge", gen, idx: c.idx, ...standInJudge(c.spec, o.series.returns, o.series.devEnd) });
    }

    const outs = await sendJobs(jobs, (signed) => {
      for (const s of signed) { const c = byKey.get(s.job.key)!; bus.emit({ type: "tx_sent", gen, idx: c.idx, operator: c.operator, parent: c.parent, wallet: s.from, txHash: s.hash, params: i16(c.spec) }); }
    });
    count(outs);
    const perBlock = new Map<number, { ts: number; n: number }>();
    for (const x of outs) {
      const c = byKey.get(x.job.key)!;
      let dev: number | undefined, trades: number | undefined;
      if (x.status === "success") {
        const ev = decodeFor(x, evaluator);
        if (ev?.eventName === "Evaluated") { dev = Number(ev.args.dev); trades = Number(ev.args.trades); }
        const b = perBlock.get(x.block!) ?? { ts: x.blockTs ?? 0, n: 0 }; b.n++; perBlock.set(x.block!, b);
        if (dev !== undefined) colony.recordDev({ gen: c.gen, idx: c.idx, spec: c.spec, operator: c.operator, parent: c.parent, dev, trades: trades! });
      }
      bus.emit({ type: "tx_landed", gen, idx: c.idx, txHash: x.hash, block: x.block ?? 0, status: x.status, dev, trades, gasUsed: x.gasUsed, latencyMs: x.latencyMs });
    }
    for (const [number, b] of [...perBlock].sort((a, b) => a[0] - b[0])) bus.emit({ type: "block", number, ts: b.ts, evalsLanded: b.n });
    const rep = landingReport(outs);
    T.blocks += rep.span;
    if (rep.lost) bus.emit({ type: "error", scope: "evaluate", message: `gen ${gen}: ${rep.lost} tx lost, ${rep.reverted} reverted (counted, not fatal)` });

    let end: ReturnType<Colony["endGeneration"]>;
    try { end = colony.endGeneration(gen); } catch (e) { bus.emit({ type: "error", scope: "endGeneration", message: `gen ${gen}: ${(e as Error).message}` }); totals(); continue; }
    bus.emit({ type: "generation_end", gen, best: end.best, archive: end.archive, bandit: end.bandit, blocks: { first: rep.first, last: rep.last, span: rep.span, histogram: rep.histogram } });
    bus.emit(end.map);
    const bl = baseline[gen - 1];
    if (bl) bus.emit({ type: "baseline", ...bl, gen });

    // top-k confirm
    const cands = colony.confirmCandidates().slice(0, o.confirmK);
    if (cands.length) {
      const cj: TxJob[] = cands.filter((c) => owner.has(rk(c.gen, c.idx))).map((c) => ({ key: rk(c.gen, c.idx), worker: owner.get(rk(c.gen, c.idx))!, to: evaluator, gas: gas.confirm, data: encodeFunctionData({ abi: evaluatorAbi, functionName: "confirm", args: [c.gen, c.idx, i16(c.spec) as any] }) }));
      const co = await sendJobs(cj);
      count(co);
      for (const x of co) {
        const [g, i] = x.job.key.split(":").map(Number) as [number, number];
        const ev = x.status === "success" ? decodeFor(x, evaluator) : null;
        if (ev?.eventName === "Confirmed") { colony.recordConfirm({ gen: g, idx: i }, Number(ev.args.score), Number(ev.args.trades)); bus.emit({ type: "confirm", gen: g, idx: i, score: Number(ev.args.score), trades: Number(ev.args.trades), txHash: x.hash }); }
        else bus.emit({ type: "error", scope: "confirm", message: `confirm ${x.job.key} ${x.status} ${x.sendError ?? ""}`.trim() });
      }
    }
    totals();
    o.log(`gen ${gen}/${o.gens}: ${rep.landed}/${N} landed over ${rep.span} block(s), best dev ${end.best.dev}`);
  }

  // freeze champion (chosen on confirm), one sealed look
  if (!stopReason) {
    const ch = colony.champion();
    if (ch && !sealedDone.has(rk(ch.gen, ch.idx)) && owner.has(rk(ch.gen, ch.idx))) {
      const j: TxJob = { key: rk(ch.gen, ch.idx), worker: owner.get(rk(ch.gen, ch.idx))!, to: evaluator, gas: gas.sealed, data: encodeFunctionData({ abi: evaluatorAbi, functionName: "sealedLook", args: [ch.gen, ch.idx, i16(ch.spec) as any] }) };
      const so = await sendJobs([j]); count(so);
      const x = so[0]!;
      const ev = x.status === "success" ? decodeFor(x, evaluator) : null;
      if (ev?.eventName === "Sealed") bus.emit({ type: "sealed", gen: ch.gen, idx: ch.idx, dev: ch.dev, confirm: ch.confirm, score: Number(ev.args.score), trades: Number(ev.args.trades), txHash: x.hash });
      else bus.emit({ type: "error", scope: "sealed", message: `sealed look ${x.status} ${x.sendError ?? ""}`.trim() });
      totals();
    } else if (!ch) bus.emit({ type: "error", scope: "sealed", message: "no champion (no confirms landed); sealed look not spent" });
    stopReason = "done";
  }
  return stopReason;
}
