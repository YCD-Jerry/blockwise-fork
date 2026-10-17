# 0009 Surfaces, layering and packaging: TypeScript, one event stream, thin terminal surfaces, one binary

**Status:** accepted (2026-10-17, code freeze 18:00 CST). Supersedes nothing; extends [0005](0005-stack.md).

## Context

Blockwise now has three ways to look at a run (CLI, terminal instrument, web view) and a replay, and it will be handed to people as a package. Four things are already fixed: the integer strategy mirror, the golden vectors and the event types live in TypeScript
(`packages/core`); the engine already emits one JSON event stream ([architecture §5](../architecture.md), `packages/core/src/events.ts`) that the recorder, the SSE endpoint and the web view consume; there is no time before the freeze for a second implementation of anything;
and the interface must read as an instrument, not as a crypto product. [ants](https://github.com/p-to-q/ants) is the prior art for the shape (a library with a thin CLI, a `tui/` split into model, views and a render loop, a surfaces table that records evidence, an npm launcher); it is Python, we are not.

## Decision

### 1. Language: stay in TypeScript, on Bun

Reasons, in order: the mirror, `data/golden.json` and the event types are TypeScript and are the parts that must not drift; the terminal surfaces are I/O and formatting, where a systems language buys nothing measurable; a Rust port of the mirror, the events and the CLI is days, not hours.
No new runtime dependency for the terminal surfaces (plain ANSI, `fetch`, `Bun.serve`).

### 2. Layers, with one rule per layer

| layer | where | may | may not |
|---|---|---|---|
| core | `packages/core` | pure functions: spec, strategy mirror, seeded RNG, search, event *types* | I/O, chain, clock, `Math.random()` |
| chain | `packages/chain` | viem, wallets, fan-out, deploy, reader | know about any surface |
| engine | `apps/orchestrator/src/{run,bus,replay,smoke}.ts` | drive core + chain, **emit events**, record, serve SSE | draw anything |
| surfaces | `apps/orchestrator/src/tui/**`, `apps/web` | **fold events into a view** and draw it | import `@blockwise/chain`, touch a wallet, call the engine, read the chain |
| CLI | `apps/orchestrator/src/cli.ts`, `cli-meta.ts` | parse flags, dispatch, print | hold logic: a command is a call into one of the layers above |

The event stream is the **only** interface between the engine and every surface: live terminal, web, replay, `report`, any future one. Consequences we rely on: replay is free; a surface can be written, tested and replaced without the engine; a recording is a complete test fixture.
Rules for the stream: additive changes only; a surface ignores event types it does not know (counted, never fatal); provenance comes from the stream (`hello.mode`, `hello.model`, `hello.explorer`), not from flags, so `watch --live` pointed at `serve --replay` shows **REPLAY**, not LIVE.
Control (pause, hint) is not an event; it travels through files and CLI commands, so a read-only surface can stay read-only.
Enforced by a test: no file under `src/tui/` may import `@blockwise/chain` or mention a wallet or mnemonic (`apps/orchestrator/test/tui.test.ts`).

### 3. Surfaces are thin

A terminal surface is `source -> fold -> render`. `state.ts` folds events into a view model with no I/O and no clock; `render.ts` turns the model into lines (a pure function, so a frame is a string and can be snapshot-tested); `lines.ts` and `report.ts` are other renderings of the same fold;
`watch.ts` is the only file that touches the terminal. The same fold can serve the web view later (moving `state.ts` to a shared package is a one-file move; not done now because `apps/web` is another owner's).

### 4. Design language: an instrument, not a token

Numbers before adjectives, units stated (bp, test MON). One accent colour (a desaturated steel blue), used for the few things that matter (the leading niche, the sealed value, the landing bars, the top of the dev scale); everything else is weight and glyph shape, so the screen reads the same in grayscale and with `NO_COLOR`.
No emoji, no price styling, no confetti, no animation that is not data. Failures (reverted, lost) are drawn with the same weight as successes. Provenance badges (`REPLAY`, `STAND-IN JUDGE`) are always on and cannot be turned off. Funding surfaces say *test MON, virtual, no payout*. Right-aligned numerals on a monospace grid.

### 5. Command principles

1. **Verbs, not nouns.** A command is an imperative (`watch`, `report`, `run`, `serve`, `deploy`). Reads never spend and never write to the chain; spending commands print the budget first and need `--yes` on testnet.
2. **Exit codes carry meaning:** 0 ok; 1 usage or not found (with a sentence that says what to do next); 4 a spending command refused (budget, missing `--yes`); 5 wrong chain id. 2 and 3 are reserved for `doctor`/`status` and the run lock ([cli.md](../cli.md)).
3. **stdout is data, stderr is talk.** Progress and warnings go to stderr, so `... --json | jq` and `run > file.jsonl` are safe. `--json` prints one object with stable keys; keys are added, never repurposed.
4. **Colour is a privilege of a TTY.** None in pipes; none when `NO_COLOR` is set non-empty or `TERM=dumb`; `--no-color`, `--color`, `--ascii` for the rest. Glyphs fall back to ASCII on a non-UTF-8 locale.
5. **Every full-screen view has a line-log twin.** Not a TTY (or `--lines`, `BLOCKWISE_NO_TUI=1`): one greppable `key=value` line per notable event, then a summary line. The terminal is always restored (alternate screen, cursor, raw mode) on every exit path.
6. **Idempotent resume.** Re-running the same `run` command rebuilds state from chain logs and only does what is missing; `AlreadyRecorded` after a resume means done, not failed ([operations.md](../operations.md)). `watch` and `report` are pure reads and can be re-run freely.
7. **Never print a key.** Addresses yes, keys and mnemonics no, in output, logs, JSON, snapshots. Surfaces cannot, because they cannot import the code that holds one.
8. **Typos are errors.** Unknown command or flag: say so, suggest the nearest, list the valid ones. A non-number where a number is needed is an error, not `NaN`.
9. **Say what may not be claimed.** `report` prints the claims the numbers support and, next to them, the ones they do not (replay, stand-in judge, no sealed look, one seed, synthetic series).

### 6. Packaging

- **Single binary:** `bun build --compile apps/orchestrator/src/cli.ts --outfile blockwise`. **Measured here** (Linux x64, Bun 1.4.2): builds in 0.2 s; 82,040,288 bytes (81,692,128 with `--minify`; 36.8 MB gzipped, the Bun runtime is most of it);
  run from an empty directory with no repository present, `blockwise --version`, `report FILE` and `watch --replay FILE --frame` produce the same output as `bun run orch`. Cross-targets (`--target=bun-darwin-arm64` etc.): Not run.
- **Known gap:** `deploy`, `smoke` and `run` read `data/series/v1.json`, `contracts/out/*.json` and `config/*.json` relative to the repository root (`REPO_ROOT` from `import.meta.dir`). In a compiled binary `REPO_ROOT` resolves to `/`, so these commands **fail outside a checkout**: measured, `deploy --local` against anvil from the compiled binary stops with `ENOENT ... '/data/series/v1.json'`, while the same command through `bun run orch` deploys. Fix when needed: embed the three assets (`import x from "..." with { type: "file" }`) or honour a `BLOCKWISE_HOME`. Until then the binary is the *surface* binary (`watch`, `report`, `serve`, help) and chain commands run from the repository.
- **npm-style `bin`:** `"bin": { "blockwise": "./src/cli.ts" }` in `apps/orchestrator/package.json` (the file already has the `#!/usr/bin/env bun` line), so `bunx` or a linked install gives a `blockwise` command on machines that have Bun. Proposed here, not applied (that file is outside this change's scope); the package is `private` until we choose to publish.
- **Version:** from `apps/orchestrator/package.json`, shown by `--version`, to be stamped into the binary and into each recording's `hello` later.
- **Distribution order:** repository checkout (today) -> binary attached to a tagged release -> npm. Nothing is published without a decision.

### 7. Directory and package map

```
apps/
  orchestrator/
    src/cli.ts            parse flags, dispatch (thin)
    src/cli-meta.ts       help text, per-command flag tables, typo suggestions, UsageError
    src/{run,bus,replay,smoke,gas,judge}.ts    the engine side: loop, event bus (stdout, JSONL, SSE), replay server
    src/tui/
      state.ts            events -> view model (pure fold)          lines.ts   one log line per event (non-TTY)
      render.ts           view model -> frame lines (pure)          report.ts  recording -> claims text / JSON
      ansi.ts             style, clip, NO_COLOR detection           source.ts  JSONL file (paced) and SSE (reconnecting)
      watch.ts            the only terminal I/O                     commands.ts  entry points for watch and report
    test/                 run.test.ts (anvil), tui.test.ts (frames, fallback, sources, report, CLI)
  web/                    browser surface, same event stream
packages/
  core/                   pure: spec, strategy mirror, rng, search, events.ts (the contract)
  chain/                  viem: clients, deploy, fan-out, reader
contracts/  data/  domains/  fixtures/  scripts/  docs/        (unchanged)
```
Dependency direction: `core <- chain <- engine`; `core <- surfaces`; `cli -> engine | surfaces`. Nothing depends on a surface.

## What Rust would buy later, and why not now

| It would buy | Worth it when |
|---|---|
| One deterministic integer mirror shared with a node or validator-side code, with `data/golden.json` as the conformance suite | something that cannot run JavaScript must evaluate specs (a node, a precompile experiment, an independent verifier) |
| A wasm build of the mirror for the browser and for `ceiling` (order 10^6 evals) | the TypeScript mirror is measured to be the bottleneck of `ceiling` or `bench`; it has not been measured |
| A few-megabyte static binary instead of 82 MB | distribution size starts to matter |
| A type system for the integer ranges (no silent float) | the TypeScript guards (`validate`, golden vectors) prove insufficient |

Not now because: a second mirror is a second place to be wrong and the invariant is that the two agree on every vector; the surfaces would be rewritten for no visible gain before the freeze; the event stream is language-neutral JSON, so a Rust surface or a Rust mirror can be added *beside* this code later
without changing the engine's contract (golden vectors for the mirror, the event table for surfaces). The door stays open by keeping those two contracts language-neutral, which they are.

## Consequences

(+) The terminal instrument, the line log and the report exist and are tested without any chain; a recording drives all of them. (+) Surfaces cannot spend or leak a key by construction. (+) One accent, no dependencies, works in grayscale and over SSH.
(+) CLI errors tell the next step.
(−) 82 MB binary, and chain commands are not yet standalone in it (see 6). (−) Frame snapshots depend on `fixtures/events.sample.jsonl`; regenerating that fixture means refreshing `__snapshots__` in the same change.
(−) The view model is not yet shared with the web view, so a counting rule could drift between them; the line log, `report` and the instrument share one fold, the web does not.

## Evidence (2026-10-17)

`bun test apps/orchestrator`: 39 passed (37 new in `tui.test.ts`, 2 existing against anvil). A pty run of the real command (120x34): alternate screen entered and left, cursor restored, `q` quits, `space` pauses, `+` doubles the speed.
`bun run typecheck` reports two errors in `apps/web/src/i18n.ts` that predate this change and are outside it. Not run: the binary on macOS or Windows; `smoke` and `run` from the compiled binary (`deploy` fails as described in 6); `watch` over a real testnet run (the fixture is synthetic, marked so in its explorer URL).
