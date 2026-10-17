# apps/orchestrator

CLI: `bun run orch <command>`. Secrets: `MNEMONIC` env or `~/.blockwise/testnet.json` (mode 0600), index 0 = deployer, 1..K = workers. Never printed.
RPC: `RPC_URL` or comma-separated `RPC_URLS` (default: testnet-rpc.monad.xyz, Ankr, monadinfra, round-robin, paced, batched). `GAS_PRICE_GWEI` (default 120, legacy type 0 txs).
Chain guard: chain id other than 10143 is refused (exit 5) unless `--local` / `BLOCKWISE_ALLOW_OTHER_CHAIN=1`.

## Testnet run order (after the deployer is funded; ~20+ MON)

```bash
cd contracts && forge build && cd ..            # artifacts in contracts/out
bun run orch deploy                              # Ledger, Evaluator, bind, JudgeLog; verifies epoch(); writes config/deployments.testnet.json
bun run orch smoke --txs 20 --workers 10 --write # measures gasUsed; writes config/gas.testnet.json (limit = max used x 1.15); prints a docs/monad-notes.md row
bun run orch smoke --txs 100 --workers 20        # then scale (A1); paste the printed row into docs/monad-notes.md
bun run orch run --gens 10 --per-gen 200 --workers 20 --confirm-k 8 --seed 1 --yes --hold
```
`run` prints the budget first and refuses (exit 4) if the deployer holds less than half of it; each generation also checks it can fund its workers and stops with an `error` event (scope `budget`) otherwise.
Events: stdout JSONL, `runs/<timestamp>.jsonl` (each line has an extra `t` ms offset for replay pacing), SSE `http://localhost:8787/events`, `GET /history`. `--hold` keeps the server up after the run.
Resume: re-run the same command with the same `--workers`; state is rebuilt from `Evaluated`/`Confirmed`/`Sealed` logs and only missing generations run. Generations are 1-based; smoke uses gen 900000+.
Replay: `bun run orch serve --replay runs/<file>.jsonl --port 8787 --speed 1 [--loop]` (hello is relabelled `mode: "replay"`).
Judge: `--judge stand-in` (default) emits `judge` events with model `stand-in`, a deterministic heuristic mock; it is not Jev, writes nothing on-chain and changes no score. `--judge off` disables.
Local rehearsal: `anvil --chain-id 31337 --block-time 1`, then `RPC_URL=http://127.0.0.1:8545 GAS_PRICE_GWEI=2 bun run orch deploy --local` (uses anvil's public dev mnemonic, never the testnet phrase).
Tests: `bun test packages/chain apps/orchestrator` (skip when `anvil` is missing).
