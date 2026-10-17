# Product and visual design: the Assay Plate

Status: v2 of the web screen (`apps/web`). Supersedes the dark/purple tokens in `presentation.md` section 5; the layout, event wiring and honesty rules there still hold.

## 1. Positioning

**Blockwise is a lab bench for trading strategies: it evaluates hundreds of candidates in parallel inside a few Monad blocks, scored by a contract the searcher cannot touch, and reports the held-out result even when it is bad.**

- For: ~100 students and engineers watching a TV for 90 seconds, then judges who open the page and click a tx.
- Proves two things, nothing else: (1) **parallel on-chain evaluation is real** (N evals in B blocks, with block numbers); (2) **the scoring is honest** (dev, confirm and sealed side by side; random baseline on the same chart; reverts counted).
- Is not: a trading terminal, a yield product, a token, a price feed.

The viewer's one-line takeaway: "200 experiments ran in 4 blocks, and the number that counts is the one it only got to look at once."

## 2. Design concept: "Assay Plate"

A candidate strategy is a **sample**; the screen is the **plate reader's printout**. The hero is a 20 x 10 microplate: 200 round wells, rows A to J, columns 1 to 20, exactly like a lab assay plate. A well is empty until its transaction lands, then it fills with ink. Darker ink means a higher dev score. Nothing else on the screen competes with that.

Visual metaphor sources, in order of weight:

1. **Lab notebook / printed figure.** Warm paper, near-black ink, hairline rules, figure captions ("Fig. 1  200 candidates, generation 10"), numbered panels. Panels are separated by rules, not boxes with shadows.
2. **Instrument readout.** Tabular mono numerals for every measured value; units and sources in small caps captions.
3. **Tufte data-ink.** Direct labels instead of legends where possible, no chart junk, small multiples (the 3 x 3 niche map; the dev / confirm / sealed bars share one scale).
4. **Editorial typography.** A serif for the claim and the big numbers, mono for evidence, a plain sans only for tiny captions.

Why this and not a dashboard: a dashboard asserts "live, urgent, money". A lab figure asserts "measured, reproducible, here is how to check". That is the claim of the project.

## 3. Typography (offline, zero requests)

| Role | Stack | Used for |
|---|---|---|
| Display / claim | `"Iowan Old Style","Palatino Linotype",Palatino,Charter,"Source Serif Pro",Georgia,"Songti SC","Noto Serif CJK SC",serif` | the "N evals in B blocks" line, the three champion numbers, panel titles |
| Evidence | `ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace` | block numbers, hashes, tape, axis ticks, spec |
| Caption | `system-ui,-apple-system,"Segoe UI","PingFang SC","Noto Sans CJK SC",sans-serif` | tiny uppercase labels, buttons |

No web fonts, no embedded fonts. Everything stays `tabular-nums`. Root font size scales with the viewport (`1rem = 16px` at 1920 wide), so a 4K TV is the same layout, larger.

## 4. Palette

Warm paper, one ink accent, three semantic colours that appear only when they mean something.

| Token | Hex | Use |
|---|---|---|
| `--paper` | `#f3eee3` | page |
| `--sheet` | `#faf7f0` | panels (barely lighter; rules do the separating) |
| `--ink` | `#1b1a17` | text, rules at 100% |
| `--ink-2` | `#5b574d` | secondary text (contrast 6.3:1 on paper) |
| `--rule` | `#cfc7b4` | hairlines, empty wells |
| `--accent` | `#1c3aa9` | links, the portfolio line, the high end of the score scale ("blue-black ink") |
| `--pass` | `#1d6b44` | sealed result held up (> 0) |
| `--overfit` | `#a35200` | sealed collapsed (<= 0), stand-in model, replay/synthetic warnings |
| `--revert` | `#b3261e` | reverted / lost tx, error banners |

Score scale (dev): 7 steps from paper-tint to blue-black ink, varying in **lightness** so it survives colour-blindness, projectors and phone video compression: `#e4dcc8 #c9cfe0 #9fb0d6 #7088c4 #4562b3 #2a45a6 #14246b`. High score is dark, so the best wells are the heaviest marks on the page.

No gradients, no glow, no dark-mode purple, no shadows deeper than a 1px rule.

## 5. Motion: only evidence moves

- A well **fills** (opacity and scale, 260 ms) when its tx lands. That is the only per-event animation.
- The big "landed this block" number cross-fades when a new block arrives.
- Histogram bars grow with `transform`. The tape row fades in (opacity only).
- Not animated: backgrounds, borders, badges, numbers that did not change, anything on idle. No blinking dots, no pulsing, no confetti on a champion. `prefers-reduced-motion` removes all of it.

## 6. Information hierarchy (16:9 TV, 6 m)

Minimum sizes at 1080p: claim 56 px, hero numbers 64 px, grid wells 44 px, panel numbers 28 px, body 18 px, hashes and captions 14 px (reference only; the audience reads the top three tiers).

1. **The claim** (top left, serif, largest): "200 evals landed in 4 blocks", with the block numbers under it.
2. **The plate** (hero, about 55% of the area): 200 wells filling.
3. **Dev / confirm / sealed** (right, top): three big numbers on one shared scale with proportional bars, and "kept X% of dev" as the plain-language result. Sealed shows `unseen` until the one look happens.
4. **Search vs random** (right, middle): best dev per generation with the random baselines on the same axes.
5. **Evidence strip** (bottom): blocks histogram, tx tape (every hash a link), niche map, counters, judge calibration, funding.
6. **Header**: source badge (REPLAY / DEMO / LIVE), block, epoch, generation, language, speed controls (small, top right).

## 7. Copy tone

Plain, precise, past tense for facts ("landed", "held out"), no hype words, no exclamation marks, no emoji. Numbers carry units or a noun. Failures are stated at the same size as successes ("1 reverted, 1 lost"). English is the source; `?lang=zh` swaps every visible label (numbers, hashes and contract names stay as is). The toggle in the header sets the same parameter.

| EN | ZH |
|---|---|
| dev (picked on this) | 开发集(据此选出) |
| confirm (held out) | 确认集(留出) |
| sealed (one look only) | 封存集(仅看一次) |
| replay | 回放 |

## 8. Honesty rules for the screen

- Source badge is always visible and says what the data is: `REPLAY: recorded events, not live chain data` (fixture builds add `synthetic`), `DEMO: generated in the browser`, or `LIVE`.
- Stand-in judge shown as such. If the judge's Brier score is worse than the no-skill baseline, the panel says so in words.
- If the search line is below a random baseline, it is drawn and labelled as it is.
- Sealed value is hidden until it exists; no placeholder number.
- Tx links go to the explorer base the stream declares; in a fixture that base is not a real explorer and the footer says so.

## 9. What we deliberately do not show

- Prices, candles, tickers, PnL in dollars as a headline, APY, "returns", "rewards", leaderboards of wallets.
- Coin, rocket, chain-link, shield or "web3" imagery; neon, glow, glassmorphism, purple-on-black gradients.
- Counters whose only job is to impress (TPS vanity, "total value locked").
- A sealed number before the sealed look; a success animation for a champion; a green/red "buy/sell" colouring.
- A wallet-connect button or any call to action. (Funding appears only as a read-only panel, labelled test MON, virtual return, no payout.)
- Any claim that a replay is live.
