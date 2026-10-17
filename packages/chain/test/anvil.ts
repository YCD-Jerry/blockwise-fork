// Test helper: spawn a local anvil (skip when missing).
import { spawn, type Subprocess } from "bun";

export const hasAnvil = Bun.which("anvil") !== null;

export async function startAnvil(port: number, blockTime?: number): Promise<{ url: string; stop: () => void }> {
  const args = ["--chain-id", "31337", "--port", String(port), "--silent"];
  if (blockTime) args.push("--block-time", String(blockTime));
  const p: Subprocess = spawn(["anvil", ...args], { stdout: "ignore", stderr: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
      if (r.ok) return { url, stop: () => p.kill() };
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  p.kill();
  throw new Error("anvil did not start");
}
