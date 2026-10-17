import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { encodeAbiParameters, encodeDeployData, keccak256, parseAbiParameters, type Abi, type Address, type Hex } from "viem";
import type { HDAccount } from "viem/accounts";
import { evaluatorAbi, ledgerAbi } from "./abi";
import { EXPLORER, networkName, type Ctx } from "./clients";
import { collect, NonceBook, sendSigned, type Signed } from "./fanout";
import { keccak256 as k } from "viem";

export const REPO_ROOT = resolve(import.meta.dir, "../../..");

export interface Series { devEnd: number; confirmEnd: number; returns: number[]; n: number }
export function loadSeries(file = join(REPO_ROOT, "data/series/v1.json")): Series {
  const j = JSON.parse(readFileSync(file, "utf8"));
  return { devEnd: j.devEnd, confirmEnd: j.confirmEnd, returns: j.returns, n: j.returns.length };
}

/** Mirror of Evaluator.epoch: keccak256(abi.encode(uint16 SPEC_VERSION, uint8 COST_BPS, uint16 devEnd, uint16 confirmEnd, int16[] returns)). */
export function computeEpoch(s: Series, specVersion = 1, costBps = 3): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("uint16, uint8, uint16, uint16, int16[]"), [specVersion, costBps, s.devEnd, s.confirmEnd, s.returns]));
}

export function loadArtifact(name: string, outDir = join(REPO_ROOT, "contracts/out")): { abi: Abi; bytecode: Hex } {
  const f = join(outDir, `${name}.sol`, `${name}.json`);
  if (!existsSync(f)) throw new Error(`artifact missing: ${f}. Run: cd contracts && forge build`);
  const j = JSON.parse(readFileSync(f, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
}

export interface Deployment {
  chainId: number; network: string; explorer: string; epoch: Hex; deployer: Address;
  contracts: { ledger: Address; evaluator: Address; judgeLog: Address };
  deployBlock: number; txs: Record<string, Hex>; devEnd: number; confirmEnd: number; specVersion: number; costBps: number; deployedAt: string;
}

export const configRoot = () => process.env.BLOCKWISE_CONFIG_ROOT ?? REPO_ROOT; // tests point this at a temp dir
export function deploymentPath(chainId: number, root = configRoot()): string { return join(root, "config", `deployments.${networkName(chainId)}.json`); }
export function loadDeployment(chainId: number, root = configRoot()): Deployment {
  const f = deploymentPath(chainId, root);
  if (!existsSync(f)) throw new Error(`no deployment file ${f}; run: bun run orch deploy`);
  return JSON.parse(readFileSync(f, "utf8"));
}

async function sendAndWait(ctx: Ctx, acc: HDAccount, book: NonceBook, data: Hex, to: Address | undefined, gasPrice: bigint, gasPad = 1.2) {
  const est = await ctx.client.estimateGas({ account: acc.address, to, data, gasPrice } as any);
  const gas = BigInt(Math.ceil(Number(est) * gasPad));
  const nonce = book.take(acc.address);
  const raw = await acc.signTransaction({ type: "legacy", chainId: ctx.chainId, nonce, gasPrice, gas, to, data, value: 0n });
  const s: Signed = { job: { key: "deploy", worker: 0, to: to as Address, data, gas }, nonce, raw, hash: k(raw), from: acc.address };
  const t = Date.now();
  const sends = await sendSigned(ctx.pool, [s]);
  const [o] = await collect(ctx.pool, [s], sends, t, { timeoutMs: 90_000 });
  if (!o || o.status !== "success") throw new Error(`tx failed (${o?.sendError ?? o?.status}) hash=${s.hash}`);
  const rc = await ctx.pool.request<any>("eth_getTransactionReceipt", [s.hash]);
  return { hash: s.hash, block: o.block!, address: rc.contractAddress as Address | null };
}

export async function deployAll(ctx: Ctx, deployer: HDAccount, gasPrice: bigint, opts: { series?: Series; root?: string; log?: (s: string) => void } = {}): Promise<Deployment> {
  const log = opts.log ?? (() => {});
  const series = opts.series ?? loadSeries();
  const root = opts.root ?? configRoot();
  const book = new NonceBook();
  await book.sync(ctx.pool, [deployer.address]);
  const L = loadArtifact("Ledger"), E = loadArtifact("Evaluator"), J = loadArtifact("JudgeLog");
  const txs: Record<string, Hex> = {};

  const l = await sendAndWait(ctx, deployer, book, encodeDeployData({ abi: L.abi, bytecode: L.bytecode, args: [] }), undefined, gasPrice);
  txs.ledger = l.hash; log(`Ledger ${l.address}`);
  const e = await sendAndWait(ctx, deployer, book, encodeDeployData({ abi: E.abi, bytecode: E.bytecode, args: [l.address, series.returns, series.devEnd, series.confirmEnd] }), undefined, gasPrice);
  txs.evaluator = e.hash; log(`Evaluator ${e.address}`);
  const { encodeFunctionData } = await import("viem");
  const b = await sendAndWait(ctx, deployer, book, encodeFunctionData({ abi: ledgerAbi, functionName: "bind", args: [e.address!] }), l.address!, gasPrice);
  txs.bind = b.hash;
  const j = await sendAndWait(ctx, deployer, book, encodeDeployData({ abi: J.abi, bytecode: J.bytecode, args: [l.address] }), undefined, gasPrice);
  txs.judgeLog = j.hash; log(`JudgeLog ${j.address}`);

  const expected = computeEpoch(series);
  const onchain = (await ctx.client.readContract({ address: e.address!, abi: evaluatorAbi, functionName: "epoch" })) as Hex;
  if (onchain.toLowerCase() !== expected.toLowerCase()) throw new Error(`epoch mismatch: chain ${onchain} vs computed ${expected}`);
  const bound = await ctx.client.readContract({ address: l.address!, abi: ledgerAbi, functionName: "evaluator" });
  if ((bound as string).toLowerCase() !== e.address!.toLowerCase()) throw new Error("ledger.evaluator is not the Evaluator");

  const dep: Deployment = {
    chainId: ctx.chainId, network: networkName(ctx.chainId), explorer: EXPLORER, epoch: onchain, deployer: deployer.address,
    contracts: { ledger: l.address!, evaluator: e.address!, judgeLog: j.address! },
    deployBlock: Math.min(l.block, e.block), txs, devEnd: series.devEnd, confirmEnd: series.confirmEnd, specVersion: 1, costBps: 3, deployedAt: new Date().toISOString(),
  };
  const f = deploymentPath(ctx.chainId, root);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(dep, null, 2) + "\n");
  return dep;
}
