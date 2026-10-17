# Jev Trader, read at the code level

Research note, 2026-10-17. Question: how does `jarrodwatts/jev-trader` actually work, and which parts should Blockwise adopt?
Everything below was read from a fresh `git clone` of the repository. Nothing from it was run, installed or built. Line numbers are for the commit named in section 1.

## 1. Identity

| | |
|---|---|
| URL | https://github.com/jarrodwatts/jev-trader (found in `docs/jev.md` and `README.md`; no web search was needed) |
| Commit read | `d6254bf36a7875e009533fb722c1af8977b96e2d`, 2026-10-13 12:21 +0800, "Run the mock model when MODEL=jev has no API key" |
| History | 16 commits, 2026-09-16 to 2026-10-13, complete (not shallow). 12 by Jarrod Watts, 2 by `jarrodwatts`, 1 each by two other contributors; several commits carry AI co-author trailers |
| License | MIT, "Copyright (c) 2026 Jarrod Watts" (`LICENSE`, `package.json:"license"`). Code may be reused with the notice; we plan to reuse design only |
| Size | About 1,660 lines of backend TypeScript (`src/`), 9 probe scripts (`scripts/`), a Next.js dashboard (`web/`). **No tests** (no `*.test.*` file). **No Solidity**: zero `.sol` files |
| Deployed | README names a Railway instance (dry run, mock model) and `CLAUDE.md` names a Vercel dashboard. Neither was visited |
| Issue tracker | **Not read.** The live tracker and PR pages were stated to be unreachable and no attempt was made to get around that. "Open problems" below come from git log, comments, README, SPEC and CLAUDE.md. Commit messages cite PRs #2, #6, #9, whose discussion is unseen |

## 2. Architecture map

One Bun process, one market, one wallet, one loop. No contracts of its own.

```
Monad RPC (HTTP)  ──eth_blockNumber every 150 ms──┐
Monad RPC (WS)    ──newHeads (optional)───────────┴─► startBlockFeed  (src/chain.ts:21)  coalesces to newest block
                                                          │
                                                          ▼
                                         Trader.onBlock(block)  (src/trader.ts:85)  one in flight
   ┌───────────────────────────────────────────┬───────────────────────────────┐
   │ hot path                                  │ off the hot path               │
   │ 1 Market.readBook  eth_call getL2Book     │ confirmPending: receipts       │
   │   (src/book.ts:73, market.ts:112)         │   (trader.ts:134)              │
   │ 2 Model.decide(TradeState)  buy|sell      │ TradeFeed.poll: eth_getLogs    │
   │   (model.ts:59 / :80)                     │   Trade events (trades.ts:80)  │
   │ 3 Market.send: sign + eth_sendRawTx       │ Market.refresh every 200 blocks│
   │   batchUpdate(cancel old, post new)       │   (market.ts:98)               │
   │   (market.ts:135)                         │                                │
   └───────────────────────────────────────────┴───────────────────────────────┘
        │ BlockEvent / quote receipt / fill
        ▼
   server.ts  Bun.serve: GET /, /history, SSE /events        data/events.jsonl (append only, never read back)
        ▼
   web/  Next.js dashboard (EventSource, 45 s stale watchdog)
```

| File | Role |
|---|---|
| `src/config.ts` | All settings from env, one object |
| `src/chain.ts` | Raw JSON-RPC `fetch`, block feed |
| `src/book.ts` | Hand-written decoder for Kuru `getL2Book()` (selector `0x46fdfbb1`), optional AMM vault merge, depth and imbalance |
| `src/market.ts` | Kuru adapter: tick-exact pricing, hand-encoded `batchUpdate`, signing, local nonce, receipts, margin deposits |
| `src/trades.ts` | `Trade` log poller: taker prints for the model, and our own maker fills |
| `src/model.ts` | `Model` interface, `JevModel`, `MockModel`, `createModel` |
| `src/trader.ts` | The loop, position cap, fill accounting, event assembly |
| `src/server.ts` | HTTP and SSE |

## 3. Mechanisms, with file:line

### 3.1 How "agents" are defined

There are no agents in the plural. The only seam is the `Model` interface (`model.ts:37-40`: `name`, `decide(state) -> Decision`) with two implementations. Everything that acts, the `Trader` class, is fixed code. So "sub-agents" and "capital allocation across sub-agents" do not exist in this repo. The one wallet trades one fixed size.

- `JevModel` (`model.ts:59-77`) is a thin call into the AI SDK.
- `MockModel` (`model.ts:80-105`) is a deterministic logistic of 20-block return, book imbalance, taker flow and hash noise, with `Bun.sleep(80)` to imitate inference time.
- `createModel` (`model.ts:112-119`) picks Jev only if `MODEL=jev` **and** `TYPESAFE_AI_API_KEY` is non-empty; otherwise it logs a warning and returns the mock. The dashboard shows the model name as a badge (`web/src/components/Header/Header.tsx:45-80`, amber "stand-in" style for anything not starting with "jev").

### 3.2 How a decision becomes a trade

1. `Trader.onBlock` (`trader.ts:85-131`). If a previous block is still running, it counts a late block and re-emits the last book with `action: "hold"` (`:89-93`). Otherwise it sets `busy` and runs the three hot-path steps.
2. `buildState` (`trader.ts:219-243`) builds a compact numeric `TradeState`: mid, spread bps, imbalance within 1%, depth at 10/25/50 bps, top 5 levels per side as strings, returns over 1/5/20/100 blocks, mids sampled every 5th block over the horizon, taker-flow summary (count, buy/sell volume, CVD, VWAP, last side), last 10 prints, and `allowed.{buy,sell}`. Position and last decision were deliberately removed from the state so the model judges the market only (commit `5c4a128`).
3. `JevModel.decide` (`model.ts:65`) calls `experimental_evaluate({ model, state, questions: QUESTIONS, maxRetries: 0 })`. One question, `direction`, type `choice`, with `instructions` (question, goal, timing, inputs) and per-choice `criteria` for `buy` and `sell` (`model.ts:42-57`). The answer's `probabilities` are mapped to `{buy, sell, hold: 0}` and `upIn10 = buy` (`:67-75`). The prompt text was rewritten in `d9156e0` to describe post-only market making, with adverse selection named as the cost.
4. Side choice (`trader.ts:105-108`): the wanted side is the model's choice; if the cap or margin disallows it, the other side is used and the quote is flagged `capped`. The model's probabilities are still shown.
5. `Market.quotePrice` (`market.ts:121-129`): bid + `quoteInsideTicks` ticks (buy) or ask − ticks (sell), integer tick math, clamped back to the touch if it would cross.
6. `Market.send` (`market.ts:135-152`): build a type-2 tx, sign locally, `eth_sendRawTransaction`, increment the local nonce, remember `{block, quote, gasLimit}` in `pending`. One `batchUpdate(buyPrices, buySizes, sellPrices, sellSizes, orderIdsToCancel, postOnly=true)` both cancels every order we know rests and posts one new post-only order (`:185-190`). Size is fixed at `TRADE_SIZE_MON` (200, the market minimum).

### 3.3 On-chain part

- **Contracts**: none are written here. It talks to Kuru's `OrderBook` at `0x065C…C394` (`config.ts:10`) and Kuru's `MarginAccount` (`:12`). ABIs come from `@kuru-labs/kuru-sdk` (`market.ts:3-4`).
- **State on chain**: the resting order on Kuru's book, and the margin balances. `ensureMargin` (`market.ts:211-245`) tops up the margin account to `MARGIN_MON` / `MARGIN_USDC` at startup, including an **unlimited** USDC `approve` (`:238`).
- **State off chain**: in-memory only: `orders`, `inflight`, `position`, `totals`, 1,000-event history (`trader.ts:57-68`). `data/events.jsonl` is appended every block (`trader.ts:291`) but nothing ever reads it (grep for `readFile` in `src/` finds nothing). A restart forgets its position, PnL and **the ids of its own resting orders**, so orders left on the book are not in the next `cancel` list. This is an inference from the code, not an observed failure.
- **What is parallelized on Monad**: nothing. One transaction per block from one sender, nonce-ordered. The only things the design leans on are Monad's short block time and the fact that a send returns before inclusion, so the nonce is advanced immediately and receipts are polled later (`market.ts:143-144`, `trader.ts:133-138`). Concurrency in the code is limited to off-path receipt polling and `eth_getLogs`.
- **Fills** are not in our own transactions. A taker's order emits `Trade(...)` whose `makerAddress` is us; `TradeFeed.decode` (`trades.ts:113-130`) turns those into maker fills with `updatedSize`.
- **Dry run** (no key, or `DRY_RUN=true`, `config.ts:13`): the order "rests" one block; a real print at or through its price fills it, up to the print's size (`trader.ts:186-200`). It has no queue position, so it is optimistic.

### 3.4 Scoring

- Average-cost position accounting (`trader.ts:245-262`); realized PnL on the closing part; unrealized at mid (`:265`).
- `pnlUsd = realized + unrealized − gasMon × mid` (`:269-271`). Jev spend (`jevUsd`, `:110`, `config.ts:33` at $0.042 per million input tokens) is reported next to it but **not subtracted**.
- Gas is charged on the limit, including for reverts (`trader.ts:142`, `market.ts:174-175` comment).
- **There is no evaluation of the model's probability against the outcome.** `upIn10` is written into events and never compared with the mid 100 blocks later. The field name is also stale: it says 10 but the horizon default is 100 (`config.ts:30`). The README states `upIn10` equals the buy probability.

### 3.5 Capital allocation

- Fixed order size 200 MON; position cap `MAX_POSITION_MON=1000` (`config.ts:15`); margin top-up targets 600 MON and 20 USDC; `BANKROLL_USD=100` only feeds `pnlPct`.
- The cap logic (`trader.ts:202-217`) counts position plus resting plus in-flight sends on that side. Counting unconfirmed sends is the good idea: it stops the cap being exceeded by transactions still in the mempool.
- The cap only steers to the reducing side; it never sizes anything.

### 3.6 LLM call bounds

- Exactly one call per block, serialized by `busy` (`trader.ts:89,94,129`).
- `maxRetries: 0` (`model.ts:65`).
- **No timeout and no abort signal.** The only deadline is the next block arriving while `busy` is still true, which marks that block late. If the call never returned, `busy` would stay true and every later block would be a late hold. Whether the SDK has its own default timeout is unknown (its code is not in the clone).
- Input size is bounded by construction: 5 book levels per side, at most 20 sampled mids, 10 prints, 400 stored mids (`trader.ts:101`), 500 stored prints (`trades.ts:44`). Output is typed, so there is no output-token cap to set.
- Cost is estimated from `usage.inputTokens` times a constant (`trader.ts:110`). There is no spend limit or kill switch.

### 3.7 Failure handling

| Failure | Handling | Where |
|---|---|---|
| Model slower than a block | Block is emitted as late, `hold`, nothing posted, `lateBlocks++` | `trader.ts:89-93` |
| Model or read throws | `console.error`, **no event at all**, `busy` cleared | `trader.ts:126-130` |
| No Jev key | Swap to mock, label it | `model.ts:112-119` |
| WS drop | Reconnect with backoff 1 s to 10 s; polling every 150 ms runs regardless | `chain.ts:21-47` |
| Burst of heads | Coalesced; loop runs once for the newest block | `chain.ts:22-29` |
| `eth_sendRawTransaction` fails | Resync nonce, rethrow | `market.ts:143-148` |
| No receipt after 10 blocks | Mark `lost`, gas not counted, resync nonce | `market.ts:165-171`, `config.ts:28` |
| Nonce resync | Higher of `latest` and `pending`, so a tx still in the mempool is not re-signed (fix `306b50f`) | `market.ts:283-290` |
| Reverted tx | Counted, gas still charged | `trader.ts:140-148` |
| `getLogs` range limit | Chunks of 100 blocks, at most 1,000 behind, cursor advances per chunk, errors swallowed and retried next poll | `trades.ts:46-49,80-111` |
| Concurrent log polls | Dropped while one is in flight | `trades.ts:81` |
| Fee, vault, margin refresh | `Promise.allSettled`, keeps old values on failure | `market.ts:98-109` |
| Dead SSE client | Removed on enqueue error; ping every 15 s | `server.ts:15,17` |
| Browser stream silent | Force reconnect after 45 s, backoff 1 s to 10 s | `web/src/lib/useFeed.ts:11-14` |

### 3.8 Secrets

- `PRIVATE_KEY` and `TYPESAFE_AI_API_KEY` are read from the environment only (`config.ts:12`, `model.ts:114`). `.env` and `data/` are git-ignored; the Docker image copies only `src/`; `.dockerignore` excludes `.env`, `data`, `scripts`.
- No key is logged; the wallet address is published in `GET /` (`index.ts:15`).
- One hot key in a plain env var. No spend cap, no key separation, no redaction wrapper. The unlimited USDC approval is noted above.

### 3.9 Hot-path engineering worth knowing

- Exactly one `eth_call` read (about 18 ms per the README) and one send. The hand decoder replaces the SDK's two sequential calls (`book.ts:1-13`); `scripts/bench-read.ts` checks it against the SDK.
- No `eth_estimateGas` in the loop. Gas limit is `GAS_LIMIT`, else estimated once at startup (`(est + 90,000) × 1.15`, `market.ts:257-272`), else 350,000. Fees are static: `maxFeePerGas` 400 gwei, priority 2 gwei (`config.ts:26-27`). The README argues a high cap is free because the price paid is base + priority.
- "Two round trips" excludes the model call, which is a third network hop in the same budget.

### 3.10 Open problems visible from the repo (tracker unread)

- No tests anywhere.
- Latency claim and structure conflict: Jev is quoted at about 100 ms (SPEC) or 70 to 500 ms (our `docs/jev.md`, not found in the repo) against a 300 ms block, with no timeout.
- `CLAUDE.md` says "Never decide every N blocks", yet commit `8f99b81` did exactly that; it was reverted in `b587759`. The product constraint is stated after the experiment.
- Stale names (`upIn10`) and a stale comment in `createModel` claiming a failing model gives "late hold" blocks (it gives silence, see 3.7).
- No resume and no cleanup of orphaned orders after restart.
- The README says the model is not trying to be profitable (SPEC footer text); nothing measures whether the calls have signal.
- No `TODO` or `FIXME` markers exist in the code.

## 4. Mechanism to Blockwise

"Already in Blockwise?" was checked against the working tree (uncommitted files included).

| Mechanism (Jev Trader) | Already in Blockwise? | Adopt in 1 hour, or why not |
|---|---|---|
| Typed binary question to Jev, probabilities back | Designed ([jev.md](../jev.md)); only a stand-in exists (`apps/orchestrator/src/judge.ts`) | Adopt for the real judge. Wire `experimental_evaluate` behind `TYPESAFE_AI_API_KEY`; keep `pBps = round(p.yes × 10000)`. 45 min once a key exists; the key is held by the maintainer |
| `maxRetries: 0` | No real call yet | Adopt as is |
| **Hard call deadline** | Not in Jev either | **Do better than Jev.** Wrap each call in `AbortSignal.timeout(~400 ms)`, run the batch with `Promise.allSettled` and an overall deadline, never delay fan-out; an unanswered candidate simply gets no `predict`. 30 min |
| Mock model when key missing, labelled | Yes: `model: "stand-in"` in `hello` (`run.ts:42-48`), `ModelKind` in `events.ts:7` | Add an `auto` judge mode that falls back to stand-in with a warning, as `createModel` does. 10 min |
| Cost counter from `usage.inputTokens × price` | No: `jevUsd: 0` hardcoded in `totals` (`run.ts:66`); `standInJudge` returns `usd: 0` | Adopt. Real judge returns `usd`; sum it into `T.jevUsd`. Shows "AI costs less than gas" with real numbers. 15 min |
| Static gas, no `eth_estimateGas` in the loop | Yes: `loadGas`, `max(gasUsed) × 1.15` rule (`gas.ts`) | Nothing to do |
| Type-2 fees with a high cap (400) and 2 gwei priority | No: legacy tx at a fixed `GAS_PRICE_GWEI` default 120 (`clients.ts:39-41`, `fanout.ts:30`) | Try. On the documented rule "price = base + priority" this pays about 102 instead of 120 gwei and survives base-fee moves. **Unknown** whether Monad testnet needs balance of limit × maxFee at admission; test with one worker before changing `ensureFunds`. 45 min including the test |
| Nonce resync to max(confirmed, pending) | Yes, by construction: `NonceBook.sync(..., "pending")` before every batch (`fanout.ts:19`, `run.ts:87-91`) | Nothing to do |
| Fire, then poll receipts; intent event then receipt event | Yes: `tx_sent` then `tx_landed` (`events.ts:23-29`) | Nothing to do |
| `lost` after N blocks | Yes: `collect` timeout 60 s, `status: "lost"` (`fanout.ts:49-67`) | Nothing to do |
| Count in-flight sends toward the cap | Partly: `ensureFunds` checks balance per generation, ignores earlier `lost` txs that may still land (`run.ts:69-85`) | Optional: subtract unresolved gas from each worker's balance. 30 min, low value |
| Retry/backoff, rate pacing | Yes, stronger: `RpcPool` with per-endpoint pacing, batching, rotation (`rpc.ts`) | Nothing to do. **Caveat**: Jev's 25 rps comment is for **mainnet** `rpc.monad.xyz`; our `profile()` applies 25 rps and batch 50 to the **testnet** host (`rpc.ts:12`) without a source. Mark as assumed (A4) |
| `eth_getLogs` chunking at 100 blocks (public mainnet RPC limit) | Yes, adaptive: `readState` starts at 2,000 blocks and halves on error down to 10 (`reader.ts:12,20-21`) | Nothing to do; Jev's limit is for mainnet and untested on our testnet hosts |
| SSE with `snapshot` on connect, `ping` every 15 s | No: `Bus.serve` sends `retry` and `hello` only, no keepalive, and the web client does `fetch(/history)` then `EventSource` (`bus.ts:45`, `apps/web/src/source.ts:72-81`), so events between the two can be missed | Adopt. Send a `ping` comment every 15 s; on connect stream the history in the same response, or de-duplicate by `t`. 30 min |
| Browser stale watchdog (45 s) and backoff | No: only the browser's built-in `retry: 2000` | Adopt in `source.ts`. 20 min |
| Dry-run and replay as labelled states | Yes: `mode: "live" \| "replay"`, `replay.ts` | Nothing to do |
| Append-only JSONL of every event | Yes: `runs/*.jsonl` | Nothing to do. Blockwise also **reads the chain back** on resume (`run.ts:52-61`), which Jev Trader cannot |
| Secrets in env, `.env` ignored | Yes, stronger: mnemonic, 0600 file check, `Wallets` redacts itself (`wallets.ts`) | Nothing to do. Do not copy the unlimited approval |
| Per-block tick strip (last 60 blocks, amber for late) | No equivalent; UI shows landings only | Demo only: strip of the last N tx outcomes, amber for `lost`/late judge. 45 min in `apps/web` |
| Chain head ticker independent of our txs | No: `block` events exist only for blocks where an eval landed (`run.ts:132`) | Demo only. Needs a new event type in `packages/core/src/events.ts`, which is another owner's file; propose, do not edit |
| Hot-path latency stats (read ms, loop ms) | Partial: `latencyMs` per tx | Add judge latency p50/p90 to `totals`. 20 min |
| Calibration of the model's calls | **Not in Jev Trader.** Blockwise has `calibration.ts` (Brier, base rate, ladder) | Our advantage. Keep |
| Capital allocation across sub-agents | **Not in Jev Trader.** Blockwise has the bandit and `Allocator` | Our advantage. Nothing to adopt |
| Hand-written book decoder, order encoder | n/a | Not relevant: Blockwise reads its own events through ABI |
| Orphan-order cleanup, restart recovery | Not in Jev Trader | Blockwise resumes from chain already |

## 5. Ranked ideas to adopt

**For algorithm robustness**

1. **Fail-open judge call with a hard deadline** (do better than Jev). Time-box each Jev call, never let it gate fan-out, treat a miss as "no prediction". Misses must be counted and shown, not hidden, because skipped predictions bias calibration. This is the one place Jev Trader is weakest and the cost of copying it blindly is a stalled demo.
2. **SSE keepalive plus snapshot-on-connect plus a client watchdog.** Without them a viewer who opens the page mid-run, or on a flaky venue network, can see a frozen UI that looks like a hang.
3. **Type-2 fees with a high cap**, after one worker-level test of Monad's balance check. Cuts reserved gas and avoids stuck transactions if the base fee moves.
4. **Subtract unresolved sends from the per-worker budget.** Jev's cap counts in-flight orders; our funding check does not count lost-but-possibly-landing txs.
5. **Score every prediction against the realized result and show it.** This is the step Jev Trader never takes (`upIn10` is never scored), and Blockwise already has the pieces (`JudgeLog`, `brier`); the work is wiring `calibration` events into the run and the UI meter.

**For the demo**

1. **Real Jev spend next to gas spend** in the counters row (the "AI costs less than gas" line). Uses a number already in `totals`.
2. **Honest labels**: `stand-in` badge, `replay` mode, and the shadow level in words, as Jev Trader does. Mostly in place; keep.
3. **Late/lost tick strip** (amber squares) so a missed judge call or lost tx looks like data, not a bug.
4. **Chain head ticker** so the page moves every block even between generations (needs an event-contract change, not ours to make).
5. **Say "paper" and "testnet" in the same breath as the model name.** Jev Trader trades real money on mainnet; Blockwise must not blur that line.

## 6. Fact, interpretation, unknown

**Fact** (read directly in code at the commit above)
- Mechanisms in 3.1 to 3.9, with the line numbers given.
- The repo has no contracts, no tests, no agent plurality, no allocation across agents, no calibration.
- `maxRetries: 0` is set; no timeout or abort signal is passed (`model.ts:65`).
- A thrown model or read error produces no event (`trader.ts:126-128`).
- Nothing reads `data/events.jsonl` back.
- The git history shows the design changed from decide-every-10-blocks with hysteresis to one post-only order per block (`8f99b81`, `645a641`, `b587759`).
- Blockwise currently signs legacy transactions at a fixed gas price (`fanout.ts:30`, `clients.ts:39`).

**Interpretation** (reasoned from the code, not observed)
- A hung model call would stall the loop forever, because `busy` is only cleared in `finally` after `await decide`.
- After a restart, orders left on the Kuru book would not be cancelled, because the cancel list is built from an in-memory map.
- Dry-run fills are optimistic, because there is no queue position and they fill at our own price.
- Type-2 with a high cap would pay about 102 instead of 120 gwei effective, if Monad prices as the README says.
- The "two round trips" claim leaves out the inference hop.
- Our `profile()` numbers for the testnet host may have been borrowed from a mainnet comment.

**Unknown** (not found, not tested)
- Whether Jev's probabilities carry any signal, and its real latency. No results are recorded in the repo; the "70 to 500 ms" in our `docs/jev.md` is not in the repo.
- Behaviour of `experimental_evaluate` on timeouts and errors (SDK not installed, deliberately).
- Kuru contract source and behaviour (not in the repo).
- Whether Monad requires `gasLimit × maxFeePerGas` in the sender's balance at admission.
- Anything in the issue tracker or PR threads; the deployed Railway and Vercel instances.
- Whether the live deployment runs the mock or Jev, and whether it is dry run.
