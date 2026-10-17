import { mnemonicToAccount, type HDAccount } from "viem/accounts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ANVIL_DEV_MNEMONIC = "test test test test test test test test test test test junk"; // public well-known dev phrase, local only

export function loadMnemonic(opts: { local?: boolean } = {}, env = process.env): string {
  if (env.MNEMONIC) return env.MNEMONIC.trim();
  if (opts.local) return ANVIL_DEV_MNEMONIC; // non-testnet chains never touch the real testnet phrase
  const f = join(homedir(), ".blockwise", "testnet.json");
  if (existsSync(f)) {
    const mode = statSync(f).mode & 0o777;
    if (mode & 0o077) throw new Error(`~/.blockwise/testnet.json must be mode 0600 (is ${mode.toString(8)})`);
    const j = JSON.parse(readFileSync(f, "utf8"));
    if (typeof j.mnemonic === "string") return j.mnemonic.trim();
  }
  if (opts.local) return ANVIL_DEV_MNEMONIC;
  throw new Error("no wallet: set MNEMONIC or create ~/.blockwise/testnet.json (never printed)");
}

/** index 0 = deployer, 1..K = workers. Accounts hold keys: never log them; log `.address` only. */
export class Wallets {
  private cache = new Map<number, HDAccount>();
  constructor(private mnemonic: string) {}
  at(i: number): HDAccount {
    let a = this.cache.get(i);
    if (!a) { a = mnemonicToAccount(this.mnemonic, { addressIndex: i }); this.cache.set(i, a); }
    return a;
  }
  get deployer(): HDAccount { return this.at(0); }
  workers(k: number): HDAccount[] { return Array.from({ length: k }, (_, i) => this.at(i + 1)); }
  toJSON() { return "[Wallets redacted]"; }
  [Symbol.for("nodejs.util.inspect.custom")]() { return "[Wallets redacted]"; }
}
