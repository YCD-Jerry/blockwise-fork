import { createPublicClient, custom, defineChain, type PublicClient } from "viem";
import { RpcPool } from "./rpc";

export const MONAD_TESTNET_ID = 10143;
export const EXPLORER = "https://testnet.monadvision.com";

export const monadTestnet = defineChain({
  id: MONAD_TESTNET_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "MonadVision", url: EXPLORER } },
});

export class ChainGuardError extends Error {}

/** Signing commands call this with the chain id the RPC reports. Anything but 10143 needs BLOCKWISE_ALLOW_OTHER_CHAIN=1. */
export function assertChainAllowed(chainId: number, env = process.env): void {
  if (chainId === MONAD_TESTNET_ID) return;
  if (env.BLOCKWISE_ALLOW_OTHER_CHAIN === "1") return;
  throw new ChainGuardError(`refusing chain id ${chainId}: only ${MONAD_TESTNET_ID} (Monad testnet) is allowed unless BLOCKWISE_ALLOW_OTHER_CHAIN=1`);
}

export function networkName(chainId: number): string {
  return chainId === MONAD_TESTNET_ID ? "testnet" : chainId === 31337 ? "local" : `chain${chainId}`;
}

export interface Ctx { pool: RpcPool; chainId: number; client: PublicClient }

/** Connect, read the chain id from the node, apply the guard. */
export async function connect(pool = new RpcPool(), env = process.env): Promise<Ctx> {
  const chainId = Number(BigInt(await pool.request<string>("eth_chainId")));
  assertChainAllowed(chainId, env);
  const chain = chainId === MONAD_TESTNET_ID ? monadTestnet : defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [pool.url] } } });
  const client = createPublicClient({ chain, transport: custom({ request: ({ method, params }) => pool.request(method, (params as unknown[]) ?? []) }) });
  return { pool, chainId, client: client as PublicClient };
}

export function gasPriceWei(env = process.env): bigint {
  return BigInt(Math.round(Number(env.GAS_PRICE_GWEI ?? "120") * 1e9));
}
