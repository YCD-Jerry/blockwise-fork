# CLI reference

Status: **partly implemented**. What runs today is in the first section; everything after it is the planned interface and is marked as such. Modelled on the
[ants CLI](https://github.com/p-to-q/ants/blob/main/docs/cli.md): read commands first, `--json` everywhere, meaningful exit codes, so a person or another agent can drive it.
When a planned command ships, its row in [surfaces.md](surfaces.md) moves to `experimental` with the test that ran. Why the CLI is built this way: [decision 0009](decisions/0009-surfaces-and-packaging.md).

The binary is `blockwise` ([decision 0007](decisions/0007-name-and-positioning.md)). Run through Bun until packaged: `bun run orch <command>`.

```bash
blockwise <command> [flags]
blockwise              # no command: the terminal interface on a terminal (tui.md), the line shell in a pipe; onboarding the first time
blockwise --version
```

## What runs today (`apps/orchestrator`)

```bash
bun run orch help [command]      # list, or the flags of one command (also: <command> --help)
bun run orch --version
bun run orch watch --replay fixtures/events.sample.jsonl --speed 16     # the terminal instrument, from a recording
bun run orch watch --live http://localhost:8787                         # the same, from a running `run` or `serve`
bun run orch report runs/<file>.jsonl [--json]                          # plain-text summary: what we may and may not claim
bun run orch serve --replay FILE [--port 8787 --speed 1 --loop]         # a recording through the SSE endpoint, labelled replay
bun run orch deploy | smoke | run ...                                   # chain commands, see apps/orchestrator/README.md
```

| command | needs a chain? | spends gas? | output |
|---|---|---|---|
| `help`, `--version` | no | no | stdout |
| `watch` | no | no | full-screen on a TTY, a line log otherwise |
| `report` | no | no | text, or one JSON object with `--json` |
| `serve` | no | no | SSE `/events`, `/history` |
| `deploy`, `smoke`, `run` | yes | yes (`run` needs `--yes` on testnet) | JSON on stdout (`deploy`, `smoke`), JSONL events (`run`); logs on stderr |

### watch

`watch` is a surface over the event stream and nothing else ([architecture](architecture.md) section 5): it never touches a wallet, the chain or `contracts/`, so it cannot spend or print a key.
Source: exactly one of `--replay FILE` (a JSONL recording) or `--live URL` (an orchestrator's SSE endpoint; a late join replays `/history` first, then follows `/events`, and it reconnects with backoff if the server goes away).

| flag | meaning |
|---|---|
| `--speed N` / `--speed max` | replay pace against the recording (default 1; recordings without timestamps use 150 ms per event, as `serve` does). Non-TTY replays are instant unless `--speed` is given |
| `--lines` | force the line log even on a terminal (`BLOCKWISE_NO_TUI=1` does the same) |
| `--frame` | print one frame and exit, for a screenshot or a diff; `--at N` stops after N events, `--width`, `--height` set the size (default 120 x 34) |
| `--no-color` / `--color` | colour is on only for a TTY, and never when `NO_COLOR` is set or `TERM=dumb`; `--color` forces it |
| `--ascii` | ASCII glyphs; automatic when the locale is set and is not UTF-8, or `BLOCKWISE_ASCII=1` |
| `--exit` | leave when a recording ends instead of waiting for `q` |

Keys on a terminal: `q` (or Ctrl-C) quit, `space` pause, `+` `-` change speed (replay only). The screen is drawn on the alternate screen and restored on every exit path.

The screen, left to right and top to bottom: **header** (mode badge `REPLAY` or `LIVE`, a `STAND-IN JUDGE` badge when the judge is not Jev, block, generation, chain); **population** (one cell per candidate in the generation:
`·` queued, `○` sent, `░▒▓█` landed by dev score, `×` reverted, `!` lost); **landing** (`N evals in B blocks`, one bar per block); **champion** (dev, confirm and sealed side by side; the best confirm so far until the sealed look, then the sealed candidate; the random baseline when the stream has one);
**niche map** (3 x 3, each niche's elite dev and label); **totals**; **last transactions** with explorer URLs (the whole URL when it fits, otherwise host plus as much of the hash as fits, with the full URL as a terminal hyperlink where the terminal supports OSC 8).
One accent colour; everything else is weight and glyph shape, so the screen reads the same in grayscale. Numbers are right-aligned in a monospace grid. Below 100 columns the panels stack. Scores are in basis points.

Not a TTY (pipe, file, CI): one `key=value` line per notable event, no escapes, then `end events=... evals=... reverted=... lost=...`. Successful landings, `tx_sent`, `block`, `judge` and `map` are not logged line by line.

```
hello mode=replay model=stand-in chain=10143 epoch=0x5e5e5e5e.. gens=10 per_gen=200
gen 0 start planned=200
gen 0 end best_idx=10 best_dev=+408 blocks=71750001..71750004 span=4
gen 7 sealed idx=182 dev=+604 confirm=+242 sealed=+145 trades=9 tx=https://.../tx/0x384f...
```

### report

`report FILE` reads a recording and prints what the numbers allow us to say: the champion's dev, confirm and sealed scores together, the comparison with the random baseline, evaluations landed and in how many blocks, reverted and lost counts, gas in test MON,
and a list of what we may **not** claim (a replay is not a new run; a stand-in judge says nothing about Jev; no sealed look means no out-of-sample claim; one run is one seed; synthetic series, testnet, public sealed segment). `--json` prints the same as one object with stable keys.
It exits 1 with a message that names the line for a malformed recording and 1 for a missing file.

### Errors and flags

Every error says what happened and what to do next, and exits 1 unless a code below applies. A misspelt command or flag is an error with a suggestion (`unknown flag --gen for run. Did you mean --gens?`), never a silent default. A non-numeric value for a numeric flag is an error.
`--flag value` and `--flag=value` both work; boolean flags (`--json --yes --lines --frame ...`) never swallow the next argument, so `report --json FILE` works. `--judge jev` is not wired yet: `run` says so and uses the labelled stand-in.
`smoke --json` prints only the JSON object (no suggested-row text after it).

## Principles

1. **Reads are free and safe.** `status top best show diff log epochs judge sql export` never send a transaction and never write to the chain; they read the local mirror or the chain.
2. **Anything that spends gas says so first.** `smoke`, `run`, `wallet fund`, `freeze`, `seal` print the budget (`txs × gasLimit × price`), refuse if the wallet cannot cover it (exit 4), and need `--yes` unless run from the interactive interface.
3. **Testnet only.** Every command that signs refuses a chain id other than 10143 unless `BLOCKWISE_ALLOW_OTHER_CHAIN=1` (exit 5).
4. **Secrets are never printed.** Addresses yes, keys and mnemonics no, in output, logs and JSON.
5. **The chain is the source of truth; the mirror is a projection.** A local SQLite file (`mirror.sqlite`) caches events for speed and queries; `blockwise doctor` can rebuild it from the chain.
6. **A failure is a normal outcome.** A revert or a dropped tx is data: it is counted, shown and exits 0 unless the command's goal failed.

## Common flags (planned)

| flag | default | meaning |
|---|---|---|
| `--domain PATH` | resolved | domain contract ([contracts.md](contracts.md) Part B) |
| `--workdir DIR` | resolved | holds `mirror.sqlite`, `blockwise.lock`, `runs/*.jsonl`, `PAUSE` |
| `--chain NAME` | `monad-testnet` | named chain config (chain id 10143) |
| `--epoch HEX` | the deployment's epoch | filter reads to one epoch (never mixed) |
| `--json` | off | machine output on read commands and `doctor`, `judge`, `bench` |
| `--yes` | off | confirm a spending command non-interactively |
| `--seed N` | 0 | used by `run`, `bench` |

## Flag-less resolution (planned)

First match wins; what was filled in is printed to stderr as `using domain=... workdir=... chain=...` (suppressed by `--json`).

| item | 1 | 2 | 3 | fallback |
|---|---|---|---|---|
| domain | `--domain` | `$BLOCKWISE_DOMAIN` | `[run] domain` in `~/.blockwise/config.toml` | `domains/trading-v1.toml`, else exit 1 `no domain found` |
| workdir | `--workdir` | `$BLOCKWISE_WORKDIR` | `[run] workdir` in the config | newest `runs/*/mirror.sqlite`, else `runs/default` |
| secrets | `~/.blockwise/testnet.json` (mode 0600) | `$MNEMONIC` | none | exit 1 `no wallet; run blockwise onboard` |

## Exit codes

| code | when |
|---|---|
| 0 | success (also `run` that stopped for any reason: budget, signal, pause) |
| 1 | reference not found (`show`), no domain, no wallet, other usage error |
| 2 | `doctor`: any FAIL; `status`: mirror disagrees with chain; epoch mismatch with the deployment |
| 3 | `run`: another `run` holds `<workdir>/blockwise.lock` (message names its pid) |
| 4 | a spending command refused: the wallet cannot cover the budget |
| 5 | wrong chain id for a signing command |

Implemented today: 0, 1, 4, 5. Codes 2 and 3 arrive with `doctor`, `status` and the run lock.

## Commands (planned unless listed above)

| command | purpose | writes? | spends gas? |
|---|---|---|---|
| `onboard` | create `~/.blockwise`, generate or import a testnet mnemonic, show the funding address, write `config.toml`, derive worker addresses | `~/.blockwise` | no |
| `doctor` | health check (below) | no | no |
| `wallet` | `status` (balances), `fund` (distribute MON to workers), `sweep` (return it) | chain (`fund`, `sweep`) | yes |
| `deploy` | deploy Ledger, Evaluator, bind, JudgeLog; write `config/deployments.testnet.json` | chain, file | yes |
| `smoke` | N txs from K workers; prints the landing-block histogram, gas used, latency (assumptions A1 to A6) | chain, `runs/` | yes |
| `run` | the generation loop; emits the event stream; `--gens`, `--per-gen`, `--workers`, `--arm portfolio\|random\|mutate…`, `--judge off\|stand-in\|jev` | chain, mirror, `runs/*.jsonl` | yes |
| `status` | counts, epoch, chain head, mirror vs chain check (JSON) | no | no |
| `top` | live dashboard / whole state as JSON (`--once --json`) | no | no |
| `best` | leaderboard with dev, confirm, sealed side by side | no | no |
| `show REF` | one candidate (`GEN:IDX` or tx hash): spec, tx, scores, lineage, judge prediction | no | no |
| `diff A B` | what differs between two candidates (params, scores, lineage) | no | no |
| `log` | recent events (`-n 50`) | no | no |
| `epochs` | every epoch seen: deployment, dates, candidates | no | no |
| `map` | the niche map: elites, labels, discovery rates, diagnostics, ceiling proxy; `--json` | no | no |
| `fund` | `--suggest` prints the suggested split (read-only); `--status` shows allocations. Allocating itself is signed in the web view, not here | no | no |
| `ceiling` | run the offline ceiling-proxy search with the mirror; writes `docs/results/` with `--out` | `--out` | no |
| `judge` | calibration report: Brier vs base rate, reliability table, authority level; `--json` | no | no |
| `bench` | offline equal-budget comparison with the TypeScript mirror: portfolio vs random 1× and 2×, many seeds, medians and IQR | `docs/results/` with `--out` | no |
| `freeze` | freeze the champion (recorded off-chain with its params hash; required before `seal`) | mirror | no |
| `seal` | spend the one sealed look for the frozen champion | chain | yes |
| `replay FILE` | stream a recorded JSONL through the same event path, labelled replay | no | no |
| `serve` | start the SSE endpoint and the web view (`--port`) | no | no |
| `ui` / `home` | the terminal interface / one screen printed and exit ([tui.md](tui.md)) | no | no |
| `sql` (alias `query`) | one read-only SELECT over the mirror; `--format table\|json\|jsonl\|csv`, `--schema` | no | no |
| `export` / `workspace --out DIR` | the mirror as plain files (`candidates.jsonl`, `frontier.json`, `failures.jsonl`, `SKILL.md`) for an agent or `grep` | `--out` | no |
| `hint TEXT` | note for proposers (never changes a gate or a budget) | one local event | no |
| `pause` / `resume` | create / delete `<workdir>/PAUSE`; the loop finishes its step and idles | flag file | no |

### doctor

Checks, each OK / WARN / FAIL, `--json` available, exit 2 on any FAIL:

| check | FAIL when |
|---|---|
| tools | Bun < 1.1 or Foundry missing |
| wallet | secrets file missing, or its mode is not 0600 |
| chain | RPC unreachable, or chain id ≠ 10143 |
| funds | the master wallet cannot cover the configured run budget |
| deployment | addresses missing, no code at an address, or `Ledger.evaluator` is not the Evaluator |
| epoch | the deployment's `epoch()` differs from the one computed from `data/series/v1.json` |
| conformance | `data/golden.json` disagrees with the TypeScript mirror (and, when `forge` is present, with the Solidity test) |
| mirror | `mirror.sqlite` disagrees with chain events (WARN: rebuildable with `blockwise status --rebuild`) |
| judge | `TYPESAFE_AI_API_KEY` set but the model is unreachable (WARN: falls back to `stand-in`, labelled) |
| rpc | one of the configured endpoints errors or exceeds the rate cap in a short probe (WARN) |

### run

```bash
blockwise run --gens 10 --per-gen 200 --workers 20 --arm portfolio --seed 1 --judge stand-in --yes
```

Behaviour (to be verified by tests, not yet true): one `run` per workdir (`flock` on `blockwise.lock`; a second exits 3). Before starting, the budget is printed and checked.
SIGTERM and SIGINT set a stop flag: the current generation's in-flight transactions are awaited and recorded, nothing half-recorded is invented, the next start resumes from chain state.
Stdout is the last step result (`budget`, `idle`, `paused:user`, `done:<gen>`).

### Output conventions

Plain tables, numbers before adjectives, no ANSI colour in pipes or with `NO_COLOR`. `--json` returns one object per command with stable keys; fields added later never change an existing key's meaning.
Reference formats: candidate `GEN:IDX` (proposer implied by the wallet set), tx `0x…`, block `n`.

## For other agents

Every read command has `--json` and meaningful exit codes. `blockwise top --once --json` (whole state), `best --json`, `show REF --json`, `log -n 50 --json`, `judge --json`, `doctor --json`.
`workspace --out DIR` writes the history as files for an agent that prefers `grep` over an API (the Meta-Harness way, see [principles](principles.md)). Controls: `hint`, `pause`, `resume`.
An agent must not write to the mirror directly, and must never be given a key; spending commands need `--yes` and a human-held wallet.
