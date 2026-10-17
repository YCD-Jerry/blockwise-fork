// `report`: a plain-text summary of one recorded run that says what the numbers allow us to claim, and what they do not.
// Everything is derived from the event stream; the only constants are the standing caveats of the repository (stated, not computed).
import { fold, signed, type Ev, type ViewState } from "./state";

export interface Report {
  file: string;
  events: number;
  run: { mode: string | null; model: string | null; chainId: number | null; epoch: string | null; explorer: string | null; generationsPlanned: number | null; generationsComplete: number; perGeneration: number | null };
  champion: { gen: number; idx: number; dev: number | null; confirm: number | null; sealed: number | null; trades: number | null; txHash: string | null; url: string | null } | null;
  evals: { landed: number; success: number; reverted: number; lost: number };
  landing: { blocksSpanned: number; evalsPerBlockMedian: number | null; evalsPerBlockMax: number | null; generationSpanMin: number | null; generationSpanMax: number | null };
  gas: { totalMon: number | null; meanGasUsed: number | null };
  baseline: { bestRandom1x: number; bestRandom2xMedian: number; seeds: number } | null;
  judge: { predictions: number; usd: number; model: string | null; brier: number | null; brierBaseline: number | null; authority: string | null };
  errors: { scope: string; message: string }[];
  claims: string[];
  notClaimed: string[];
}

const median = (xs: number[]) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2; };

export function buildReport(events: Ev[], file: string): Report {
  const s: ViewState = fold(events);
  const perBlock = new Map<number, number>();
  for (const e of events) if (e.type === "tx_landed" && e.status !== "lost" && e.block) perBlock.set(e.block, (perBlock.get(e.block) ?? 0) + 1);
  const counts = [...perBlock.values()];
  const spans = Object.values(s.genBlocks).map((g) => g.span);
  const h = s.hello;
  const c = s.sealed ? { gen: s.sealed.gen, idx: s.sealed.idx, dev: s.sealed.dev, confirm: s.sealed.confirm, sealed: s.sealed.score, trades: s.sealed.trades, txHash: s.sealed.txHash }
    : s.champion ? { gen: s.champion.gen, idx: s.champion.idx, dev: s.champion.dev ?? null, confirm: s.champion.confirm, sealed: null, trades: s.champion.trades, txHash: s.champion.txHash } : null;
  const url = (hash: string | null) => (hash && h?.explorer ? `${h.explorer.replace(/\/$/, "")}/tx/${hash}` : null);
  const r: Report = {
    file, events: s.events,
    run: { mode: h?.mode ?? null, model: h?.model ?? null, chainId: h?.chainId ?? null, epoch: h?.epoch ?? null, explorer: h?.explorer ?? null, generationsPlanned: h?.config.generations ?? null, generationsComplete: s.gensDone.length, perGeneration: h?.config.perGeneration ?? null },
    champion: c ? { ...c, dev: c.dev ?? null, url: url(c.txHash) } : null,
    evals: { landed: s.landed, success: s.success, reverted: s.reverted, lost: s.lost },
    landing: { blocksSpanned: perBlock.size, evalsPerBlockMedian: median(counts), evalsPerBlockMax: counts.length ? Math.max(...counts) : null, generationSpanMin: spans.length ? Math.min(...spans) : null, generationSpanMax: spans.length ? Math.max(...spans) : null },
    gas: { totalMon: s.totalsEvent?.gasMon ?? null, meanGasUsed: s.gasUsedN ? Math.round(s.gasUsedSum / s.gasUsedN) : null },
    baseline: s.baseline ? { bestRandom1x: s.baseline.bestRandom1x, bestRandom2xMedian: s.baseline.bestRandom2xMedian, seeds: s.baseline.seeds } : null,
    judge: { predictions: s.judge.n, usd: s.judge.usd, model: h?.model ?? null, brier: s.calibration?.brier ?? null, brierBaseline: s.calibration?.brierBaseline ?? null, authority: s.calibration?.authority ?? null },
    errors: s.errors, claims: [], notClaimed: [],
  };
  r.claims = claims(r); r.notClaimed = notClaimed(r);
  return r;
}

function claims(r: Report): string[] {
  const out: string[] = [];
  const c = r.champion;
  if (c && c.sealed !== null) {
    out.push(`Sealed look: ${signed(c.sealed)} bp on the single recorded look (gen ${c.gen}, idx ${c.idx}, ${c.trades} trades). The champion was chosen on dev and confirm only.`);
    if (c.dev !== null && c.confirm !== null) out.push(`The score at each stage: dev ${signed(c.dev)} -> confirm ${signed(c.confirm)} -> sealed ${signed(c.sealed)}. ${c.dev > c.confirm && c.confirm > c.sealed ? "It falls at every stage, so dev alone overstates." : "Report all three together."}`);
  } else if (c) {
    out.push(`Confirm: ${signed(c.confirm ?? undefined)} bp for the best candidate so far (gen ${c.gen}, idx ${c.idx}); dev ${signed(c.dev ?? undefined)}. Candidates were picked on dev, so confirm is a selected number, not an out-of-sample one.`);
  } else out.push("No candidate reached the confirm stage in this recording.");
  if (c && c.dev !== null && r.baseline) {
    const b = r.baseline;
    out.push(`On dev, the champion (${signed(c.dev)}) vs random: 1x best ${signed(b.bestRandom1x)}, 2x median ${signed(b.bestRandom2xMedian)} over ${b.seeds} seeds. ${c.dev > b.bestRandom1x && c.dev > b.bestRandom2xMedian ? "Ahead of both on dev." : "Not ahead of both on dev."}`);
  }
  const e = r.evals;
  out.push(`${e.landed} evaluations landed (${e.success} scored, ${e.reverted} reverted), ${e.lost} lost with no receipt: counted, not hidden.`);
  const l = r.landing;
  if (l.blocksSpanned) out.push(`They landed in ${l.blocksSpanned} distinct blocks (median ${l.evalsPerBlockMedian} evals per block, max ${l.evalsPerBlockMax})${l.generationSpanMin !== null ? `; a generation spanned ${l.generationSpanMin === l.generationSpanMax ? l.generationSpanMin : `${l.generationSpanMin} to ${l.generationSpanMax}`} blocks` : ""}.`);
  if (r.gas.totalMon !== null) out.push(`Gas: ${r.gas.totalMon.toFixed(2)} test MON (no monetary value)${r.gas.meanGasUsed ? `, mean ${r.gas.meanGasUsed.toLocaleString("en-US")} gas per landed evaluation` : ""}.`);
  return out;
}

function notClaimed(r: Report): string[] {
  const out: string[] = [];
  if (r.run.mode === "replay") out.push("This file is a replay of a recording; it is evidence of what the recorded run printed, not a new run.");
  if (r.run.model === "stand-in") out.push("The judge was a deterministic stand-in, not Jev: nothing here says anything about AI judging.");
  if (r.judge.brier !== null && r.judge.brierBaseline !== null && r.judge.brier >= r.judge.brierBaseline) out.push(`The judge's Brier score (${r.judge.brier.toFixed(4)}) is not below the base rate's (${r.judge.brierBaseline.toFixed(4)}): no skill shown.`);
  if (r.champion && r.champion.sealed === null) out.push("No sealed look was recorded: no out-of-sample claim.");
  if (r.run.generationsPlanned !== null && r.run.generationsComplete < r.run.generationsPlanned) out.push(`Only ${r.run.generationsComplete} of ${r.run.generationsPlanned} planned generations completed.`);
  out.push("One run is one seed: the claim is about this run, not about the method (the benchmark, with many seeds, is what compares methods).");
  out.push("The series is synthetic and fixed, the chain is a testnet, and the sealed segment is public data: one recorded look is enforced, secrecy is not.");
  return out;
}

export function formatReport(r: Report): string {
  const L: string[] = [];
  const kv = (k: string, v: string) => L.push(`  ${k.padEnd(13)}${v}`);
  L.push(`Blockwise run report: ${r.file}`, "");
  const ru = r.run;
  kv("events", String(r.events));
  kv("mode", `${ru.mode ?? "unknown"}${ru.model ? `, judge ${ru.model}` : ""}`);
  kv("chain", `${ru.chainId ?? "unknown"}${ru.epoch ? `, epoch ${ru.epoch.slice(0, 10)}..${ru.epoch.slice(-4)}` : ""}`);
  kv("generations", `${ru.generationsComplete}${ru.generationsPlanned ? ` of ${ru.generationsPlanned}` : ""} complete${ru.perGeneration ? `, ${ru.perGeneration} planned each` : ""}`);
  L.push("");
  L.push("Champion (dev / confirm / sealed, bp)");
  const c = r.champion;
  if (!c) L.push("  none");
  else {
    kv("candidate", `gen ${c.gen}, idx ${c.idx}`);
    kv("dev", signed(c.dev ?? undefined)); kv("confirm", signed(c.confirm ?? undefined)); kv("sealed", c.sealed === null ? "not opened" : signed(c.sealed));
    if (c.url) kv("tx", c.url);
  }
  L.push("", "What we may claim");
  for (const x of r.claims) L.push(`  - ${x}`);
  L.push("", "What we may not claim");
  for (const x of r.notClaimed) L.push(`  - ${x}`);
  if (r.errors.length) { L.push("", `Errors seen (${r.errors.length})`); for (const e of r.errors.slice(0, 5)) L.push(`  - ${e.scope}: ${e.message}`); }
  return L.join("\n") + "\n";
}
