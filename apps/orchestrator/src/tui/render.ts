// Pure frame rendering: ViewState -> lines. No clock, no terminal access, so a frame is a string you can snapshot.
import { clip, makeStyle, padL, padR, vlen, type Style, type TermEnv } from "./ansi";
import { championView, explorerTx, signed, type CellState, type ViewState } from "./state";

export interface RenderOpts extends TermEnv {
  width: number;
  height: number;
  /** right side of the footer, e.g. "event 1523/4225  x16" */
  status?: string;
  /** keys to show in the footer; the source decides which exist */
  keys?: string;
}

const NICHE_LABEL = { young: "yng", leader: "ldr", riser: "ris", stalled: "stl" } as const;
const STYLES = ["reversion", "neutral", "momentum"] as const;
const ACTIVITIES = ["low", "mid", "high"] as const;

const int = (n: number) => Math.round(n).toLocaleString("en-US");

interface Glyphs { rule: string; sep: string; q: string; sent: string; lv: [string, string, string, string]; rev: string; lost: string; bar: string; ell: string }
const G_UNI: Glyphs = { rule: "─", sep: "·", q: "·", sent: "○", lv: ["░", "▒", "▓", "█"], rev: "×", lost: "!", bar: "█", ell: "…" };
const G_ASC: Glyphs = { rule: "-", sep: "|", q: ".", sent: "o", lv: [":", "+", "*", "#"], rev: "x", lost: "!", bar: "#", ell: "~" };

function cellGlyph(st: Style, g: Glyphs, c: CellState, dev: number | undefined, maxDev: number): string {
  switch (c) {
    case 0: return st.dim(g.q);
    case 1: return g.sent;
    case 3: return st.bold(g.rev);
    case 4: return st.bold(g.lost);
    default: {
      if (dev === undefined || dev <= 0 || maxDev <= 0) return st.dim(g.lv[0]);
      const r = dev / maxDev;
      return r <= 0.34 ? g.lv[1] : r <= 0.67 ? st.bold(g.lv[2]) : st.hot(g.lv[3]);
    }
  }
}

function badge(st: Style, color: boolean, text: string, hot = false): string {
  return color ? (hot ? st.hot(st.inv(` ${text} `)) : st.inv(` ${text} `)) : `[${text}]`;
}

/** Join two blocks of lines side by side; the left block is padded to lw columns. */
function columns(left: string[], right: string[], lw: number, gap: number): string[] {
  const n = Math.max(left.length, right.length), out: string[] = [];
  for (let i = 0; i < n; i++) out.push(padR(clip(left[i] ?? "", lw), lw) + " ".repeat(gap) + (right[i] ?? ""));
  return out;
}

/** The full URL when it fits; else host + /tx/ + as much of the hash as fits (the terminal link, when enabled, still carries the whole URL). */
export function fitUrl(url: string, hash: string, room: number, ell: string): string {
  if (url.length <= room) return url;
  let prefix = url.replace(/^https?:\/\//, "").replace(/\/tx\/.*$/, "");
  if (prefix.length > room - 24) prefix = prefix.split("/")[0]!;
  const keep = Math.max(6, room - prefix.length - 4 - 1 - 4);
  return `${prefix}/tx/${hash.slice(0, Math.min(keep, 66))}${ell}${hash.slice(-4)}`;
}

function title(st: Style, label: string, note = ""): string { return st.dim(label) + (note ? "  " + note : ""); }

function populationPanel(s: ViewState, st: Style, g: Glyphs, perRow: number): string[] {
  const planned = s.cells.length;
  const landed = s.cells.filter((c) => c >= 2).length;
  const out = [title(st, "POPULATION", planned ? `${st.bold(`gen ${s.gen}`)}  ${landed} of ${planned} landed  ${st.dim(`gen best ${signed(s.maxDev)}`)}` : "waiting for the first generation")];
  if (!planned) return out;
  for (let r = 0; r * perRow < planned; r++) {
    const start = r * perRow;
    let line = st.dim(padL(String(start), 3)) + "  ";
    for (let i = start; i < Math.min(planned, start + perRow); i++) {
      if (i > start && (i - start) % 10 === 0) line += " ";
      line += cellGlyph(st, g, s.cells[i]!, s.cellDev[i], s.maxDev);
    }
    out.push(line);
  }
  out.push(st.dim(`     ${g.q} queued  ${g.sent} sent  ${g.lv.join("")} landed, by dev  ${g.rev} reverted  ${g.lost} lost`));
  return out;
}

function landingPanel(s: ViewState, st: Style, g: Glyphs, width: number, maxRows: number): string[] {
  let hist = s.hist, genLabel = s.gen, stale = false;
  if (!Object.keys(hist).length && s.lastHist) { hist = s.lastHist.hist; genLabel = s.lastHist.gen; stale = true; }
  const blocks = Object.keys(hist).map(Number).sort((a, b) => a - b);
  const total = blocks.reduce((a, b) => a + hist[String(b)]!, 0);
  const head = blocks.length ? `${st.bold(`${int(total)} evals in ${blocks.length} block${blocks.length === 1 ? "" : "s"}`)}${stale ? st.dim(`  (gen ${genLabel})`) : ""}` : st.dim("no landings yet");
  const out = [title(st, "LANDING", head)];
  const shown = blocks.slice(-maxRows), max = Math.max(1, ...shown.map((b) => hist[String(b)]!));
  const barW = Math.max(8, width - 8 - 1 - 1 - 4);
  if (blocks.length > shown.length) out.push(st.dim(`${g.ell} ${blocks.length - shown.length} earlier block(s)`));
  for (const b of shown) {
    const n = hist[String(b)]!;
    out.push(`${st.dim(String(b))} ${st.acc(g.bar.repeat(Math.max(1, Math.round((n / max) * barW))))} ${padL(String(n), 4)}`.replace(/ +$/, ""));
  }
  return out;
}

function championPanel(s: ViewState, st: Style): string[] {
  const c = championView(s);
  const out = [title(st, "CHAMPION", c ? `gen ${c.gen} idx ${c.idx}${s.sealed ? "" : st.dim("  best confirm so far")}` : st.dim("no confirm yet"))];
  const row = (k: string, v: string, note = "") => out.push(`  ${padR(st.dim(k), 9)}${padL(v, 6)}${note ? "   " + st.dim(note) : ""}`);
  row("dev", signed(c?.dev), "bp, the score it was searched on");
  row("confirm", signed(c?.confirm), c?.confirm !== undefined && c.dev !== undefined ? `${signed(c.confirm - c.dev)} vs dev` : "");
  const sealedV = s.sealed ? st.hot(signed(s.sealed.score)) : st.dim("unopened");
  out.push(`  ${padR(st.dim("sealed"), 9)}${padL(sealedV, 6)}   ${st.dim(s.sealed ? `one look, ${s.sealed.trades} trades` : "one look, spent once")}`);
  if (s.baseline) out.push(st.dim(`  random, ${s.baseline.seeds} seeds: 1x ${signed(s.baseline.bestRandom1x)}, 2x ${signed(s.baseline.bestRandom2xMedian)}`));
  return out;
}

function mapPanel(s: ViewState, st: Style, g: Glyphs): string[] {
  const out = [title(st, "NICHE MAP", st.dim("dev of each niche elite"))];
  out.push("  " + padR("", 10) + ACTIVITIES.map((a) => padR(st.dim(a), 10)).join(""));
  for (const style of STYLES) {
    let line = "  " + st.dim(padR(style, 10));
    for (const act of ACTIVITIES) {
      const cell = s.map?.cells.find((c) => c.style === style && c.activity === act);
      let txt: string;
      if (!cell?.elite) txt = st.dim(padR(g.q, 10));
      else {
        const body = `${padL(signed(cell.elite.dev), 5)} ${NICHE_LABEL[cell.label]}`;
        txt = cell.label === "leader" ? st.hot(padR(body, 10)) : padR(body, 10);
      }
      line += txt;
    }
    out.push(line);
  }
  if (!s.map) out[0] = title(st, "NICHE MAP", st.dim("no map event yet"));
  return out;
}

function totalsLine(s: ViewState, st: Style, g: Glyphs): string {
  const t = s.totalsEvent;
  const parts = [
    `evals ${st.bold(int(s.landed))}`,
    `reverted ${st.bold(String(s.reverted))}`,
    `lost ${st.bold(String(s.lost))}`,
    `gas ${st.bold(t ? t.gasMon.toFixed(2) : "-")} MON`,
    `blocks ${st.bold(t ? String(t.blocksSpanned) : "-")}`,
    s.hello?.model && s.hello.model !== "none" ? `judge ${s.hello.model}${s.judge.usd ? ` $${s.judge.usd.toFixed(3)}` : ""}` : "",
  ].filter(Boolean);
  return st.dim("TOTALS") + "  " + parts.join(st.dim(`  ${g.sep}  `));
}

function tapePanel(s: ViewState, st: Style, g: Glyphs, o: RenderOpts, width: number, rows: number): string[] {
  const out = [title(st, "LAST TRANSACTIONS", st.dim(s.hello?.explorer ? "explorer links" : ""))];
  const lines = s.tape.slice(-rows);
  if (!lines.length) out.push(st.dim("  none yet"));
  for (const l of lines) {
    let head: string;
    if (l.kind === "error") { out.push(clip(`  ${st.bold("error")}  ${l.message}`, width)); continue; }
    if (l.kind === "landed") {
      const status = l.status === "success" ? "ok" : l.status === "reverted" ? st.bold("reverted") : st.bold("lost");
      head = `${padL(String(l.block ?? "-"), 9)}  ${padR(`${l.gen}:${l.idx}`, 7)} ${padL(signed(l.dev), 6)}  ${padL(l.gasUsed !== undefined ? int(l.gasUsed) : "-", 7)} gas  ${padL(l.latencyMs !== undefined ? (l.latencyMs / 1000).toFixed(1) + " s" : "-", 6)}  ${padR(status, 8)}`;
    } else {
      const tag = l.kind === "sealed" ? st.hot("sealed ") : st.acc("confirm");
      head = `${padL(tag, 9)}  ${padR(`${l.gen}:${l.idx}`, 7)} ${padL(signed(l.score), 6)}  ${padL(String(l.trades ?? "-"), 7)} trades          `;
    }
    const url = l.txHash ? explorerTx(s, l.txHash) : "";
    const room = width - 2 - vlen(head) - 1;
    let tail = "";
    if (url) {
      const text = fitUrl(url, l.txHash!, room, g.ell);
      tail = o.links && text !== url ? st.link(text, url) : text;
    }
    out.push(clip(`  ${head} ${tail}`, width).replace(/\s+$/, ""));
  }
  return out;
}

function header(s: ViewState, st: Style, g: Glyphs, o: RenderOpts, cw: number): string {
  const mode = s.hello?.mode ?? null;
  const left = [
    st.bold("BLOCKWISE"),
    mode ? badge(st, o.color, mode.toUpperCase(), mode === "live") : badge(st, o.color, "WAITING"),
    s.hello?.model === "stand-in" ? badge(st, o.color, "STAND-IN JUDGE") : "",
  ].filter(Boolean).join("  ");
  const done = s.gensDone.length, total = s.hello?.config.generations;
  const right = [
    s.block !== null ? `block ${st.bold(String(s.block))}` : "block -",
    s.gen !== null ? `gen ${st.bold(String(s.gen))}` : "gen -",
    total ? `${done} of ${total} complete` : `${done} complete`,
    s.hello ? `chain ${s.hello.chainId}` : "",
  ].filter(Boolean).join(`  ${st.dim(g.sep)}  `);
  return left + " ".repeat(Math.max(2, cw - vlen(left) - vlen(right))) + right;
}

export function renderFrame(s: ViewState, o: RenderOpts): string[] {
  const st = makeStyle({ color: o.color, links: o.links });
  const g = o.ascii ? G_ASC : G_UNI;
  const W = Math.max(40, o.width);
  const cw = Math.min(W - 2, 130); // content width
  const wide = cw >= 98;
  const out: string[] = [];
  const rule = st.dim(g.rule.repeat(cw));
  out.push(header(s, st, g, o, cw), rule);
  if (wide) {
    const lw = 62, gap = 3, rw = cw - lw - gap;
    const left = [...populationPanel(s, st, g, 50), "", ...championPanel(s, st)];
    const right = [...landingPanel(s, st, g, rw, 7), "", ...mapPanel(s, st, g)];
    out.push(...columns(left, right, lw, gap));
  } else {
    const per = cw >= 62 ? 40 : cw >= 44 ? 20 : 10;
    out.push(...populationPanel(s, st, g, per), "", ...landingPanel(s, st, g, cw, 5), "", ...championPanel(s, st), "", ...mapPanel(s, st, g));
  }
  out.push("", totalsLine(s, st, g), "");
  const budgetRows = Math.max(3, Math.min(12, o.height - out.length - 4));
  out.push(...tapePanel(s, st, g, o, cw, budgetRows));
  const footer = (o.keys ? st.dim(o.keys) : "");
  const stat = o.status ? st.dim(o.status) : "";
  const body = out.slice(0, Math.max(1, o.height - 2)); // keep the footer even when the terminal is short
  while (body.length < o.height - 2) body.push("");
  body.push(rule, footer + " ".repeat(Math.max(2, cw - vlen(footer) - vlen(stat))) + stat);
  return body.map((l) => " " + clip(l, cw)).map((l) => (vlen(l) > W ? clip(l, W) : l));
}
