import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { configRoot, networkName } from "@blockwise/chain";

export interface GasLimits { evaluate: bigint; confirm: bigint; sealed: bigint }
const DEFAULT = 350_000n; // conservative until smoke measures; Monad charges the limit

export function gasFile(chainId: number) { return join(configRoot(), "config", `gas.${networkName(chainId)}.json`); }

export function loadGas(chainId: number, env = process.env): GasLimits {
  const f = gasFile(chainId);
  let j: any = {};
  if (existsSync(f)) j = JSON.parse(readFileSync(f, "utf8"));
  const e = env.GAS_LIMIT ? BigInt(env.GAS_LIMIT) : undefined;
  const pick = (k: string) => e ?? (j[k] ? BigInt(j[k]) : DEFAULT);
  return { evaluate: pick("evaluate"), confirm: pick("confirm"), sealed: pick("sealed") };
}

export function saveGas(chainId: number, g: { evaluate: number; confirm: number; sealed: number }) {
  mkdirSync(join(configRoot(), "config"), { recursive: true });
  writeFileSync(gasFile(chainId), JSON.stringify({ ...g, measuredAt: new Date().toISOString(), rule: "max(gasUsed) x 1.15" }, null, 2) + "\n");
}
