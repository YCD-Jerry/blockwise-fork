// Drawing helpers shared by the pages: glyph sets, bars, a table that drops its least important columns instead of garbling.
import { clip, padL, padR, vlen, type Style } from "./ansi";

export interface Glyphs { rule: string; sep: string; q: string; sent: string; lv: [string, string, string, string]; rev: string; lost: string; bar: string; ell: string; eighths: string[]; up: string; down: string; sel: string; tex: [string, string, string, string]; spark: string[] }
export const G_UNI: Glyphs = {
  rule: "─", sep: "·", q: "·", sent: "○", lv: ["░", "▒", "▓", "█"], rev: "×", lost: "!", bar: "█", ell: "…",
  eighths: ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"], up: "▲", down: "▼", sel: "▸", tex: ["░", "▒", "▓", "█"], spark: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
};
export const G_ASC: Glyphs = {
  rule: "-", sep: "|", q: ".", sent: "o", lv: [":", "+", "*", "#"], rev: "x", lost: "!", bar: "#", ell: "~",
  eighths: ["", "", "", "", "", "", "", ""], up: "^", down: "v", sel: ">", tex: [".", ":", "+", "#"], spark: ["_", ".", "-", "~", "=", "+", "*", "#"],
};

export const int = (n: number) => Math.round(n).toLocaleString("en-US");
export const pct = (x: number | null | undefined, d = 0) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : `${(x * 100).toFixed(d)}%`);
export const trimNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, ""));

/** A horizontal bar of `frac` (0..1) in `width` columns; eighth-blocks on UTF-8 terminals, whole cells in ASCII. */
export function hbar(g: Glyphs, frac: number, width: number): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
  if (width <= 0) return "";
  const eighths = Math.round(f * width * 8);
  const full = Math.floor(eighths / 8), part = eighths % 8;
  const useEighths = g.eighths[1] !== "";
  if (!useEighths) return g.bar.repeat(Math.max(f > 0 ? 1 : 0, Math.round(f * width)));
  return g.bar.repeat(full) + (part ? g.eighths[part]! : "");
}

export function sparkline(g: Glyphs, vals: (number | undefined)[], lo?: number, hi?: number): string {
  const nums = vals.filter((v): v is number => v !== undefined);
  if (!nums.length) return "";
  const a = lo ?? Math.min(...nums), b = hi ?? Math.max(...nums);
  return vals.map((v) => (v === undefined ? " " : g.spark[b === a ? 3 : Math.max(0, Math.min(7, Math.round(((v - a) / (b - a)) * 7)))]!)).join("");
}

export interface Col {
  key: string; title: string;
  /** natural width; ignored for the flex column */
  w: number;
  align?: "l" | "r";
  /** lower is more important; the highest prio goes first when the row does not fit */
  prio: number;
  flex?: boolean; minFlex?: number; maxFlex?: number;
}
export type Cell = string | ((width: number) => string);
export interface TableOut { head: string; rows: string[]; hidden: string[]; widths: Record<string, number> }

/** Lay out columns into `width`: drop whole columns from the least important until it fits; the flex column absorbs the rest. */
export function table(cols: Col[], rows: Record<string, Cell>[], width: number, st: Style, opts: { sortKey?: string; sortMark?: string; gap?: number } = {}): TableOut {
  const gap = opts.gap ?? 2;
  let use = [...cols];
  const need = (cs: Col[]) => cs.reduce((a, c) => a + (c.flex ? (c.minFlex ?? 8) : c.w), 0) + gap * Math.max(0, cs.length - 1);
  const hidden: string[] = [];
  while (use.length > 1 && need(use) > width) {
    let worst = -1;
    for (let i = 0; i < use.length; i++) if (worst < 0 || use[i]!.prio >= use[worst]!.prio) worst = i;
    hidden.push(use[worst]!.title || use[worst]!.key);
    use = use.filter((_, i) => i !== worst);
  }
  const fixed = use.reduce((a, c) => a + (c.flex ? 0 : c.w), 0) + gap * Math.max(0, use.length - 1);
  const widths: Record<string, number> = {};
  for (const c of use) widths[c.key] = c.flex ? Math.max(c.minFlex ?? 8, Math.min(c.maxFlex ?? 1000, width - fixed)) : c.w;
  const cell = (c: Col, txt: string) => { const t = clip(txt, widths[c.key]!); return c.align === "r" ? padL(t, widths[c.key]!) : padR(t, widths[c.key]!); };
  const sep = " ".repeat(gap);
  const head = use.map((c) => cell(c, c.title + (opts.sortKey === c.key ? (opts.sortMark ?? "") : ""))).join(sep);
  const out = rows.map((r) => use.map((c) => { const v = r[c.key] ?? ""; return cell(c, typeof v === "function" ? v(widths[c.key]!) : v); }).join(sep).replace(/\s+$/, ""));
  return { head: st.dim(head.replace(/\s+$/, "")), rows: out, hidden, widths };
}

/** Section title: dim caps, then free text. */
export const title = (st: Style, label: string, note = ""): string => st.dim(label) + (note ? "  " + note : "");

/** Pad or cut `lines` to exactly n rows. */
export function fit(lines: string[], n: number, fill = ""): string[] { const o = lines.slice(0, Math.max(0, n)); while (o.length < n) o.push(fill); return o; }

/** Join two blocks of lines side by side; the left block is padded to lw columns. */
export function columns(left: string[], right: string[], lw: number, gap: number): string[] {
  const n = Math.max(left.length, right.length), out: string[] = [];
  for (let i = 0; i < n; i++) out.push(padR(clip(left[i] ?? "", lw), lw) + " ".repeat(gap) + (right[i] ?? ""));
  return out;
}

/** "rows 5-24 of 80" with arrows, for a windowed list. */
export function windowNote(g: Glyphs, from: number, to: number, total: number): string {
  if (total <= to - from) return "";
  return `${from > 0 ? g.up : " "}${g.down === "" ? "" : to < total ? g.down : " "} rows ${from + 1}-${to} of ${total}`;
}

export { vlen };
