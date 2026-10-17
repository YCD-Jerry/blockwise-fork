// Plain ANSI helpers. No dependencies. One accent colour, everything else is weight (bold/dim) and glyph shape,
// so the frame reads the same without colour (NO_COLOR, pipes, screenshots in grayscale).

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

export const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");
export const vlen = (s: string): number => [...stripAnsi(s)].length;
export const padR = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - vlen(s)));
export const padL = (s: string, w: number): string => " ".repeat(Math.max(0, w - vlen(s))) + s;

/** Truncate to w visible columns without cutting an escape sequence; closes open styling if it cut. */
export function clip(s: string, w: number): string {
  if (vlen(s) <= w) return s;
  let out = "", seen = 0, i = 0, cut = false;
  while (i < s.length) {
    ANSI_RE.lastIndex = i;
    const m = ANSI_RE.exec(s);
    if (m && m.index === i) { out += m[0]; i += m[0].length; continue; }
    const cp = String.fromCodePoint(s.codePointAt(i)!);
    if (seen >= w) { cut = true; break; }
    out += cp; seen++; i += cp.length;
  }
  return cut && out.includes("\x1b") ? out + "\x1b[0m" + (out.includes("\x1b]8;") ? "\x1b]8;;\x1b\\" : "") : out;
}

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  acc(s: string): string;
  /** accent + bold, for the one thing that matters on screen */
  hot(s: string): string;
  inv(s: string): string;
  link(text: string, url: string): string;
}

const wrap = (on: string, off = "0") => (s: string) => `\x1b[${on}m${s}\x1b[${off}m`;
export const ACCENT_256 = 74; // desaturated steel blue; readable on dark and light backgrounds

export function makeStyle(o: { color: boolean; links: boolean }): Style {
  const id = (s: string) => s;
  return {
    bold: o.color ? wrap("1", "22") : id,
    dim: o.color ? wrap("2", "22") : id,
    acc: o.color ? wrap(`38;5;${ACCENT_256}`, "39") : id,
    hot: o.color ? (s) => `\x1b[1;38;5;${ACCENT_256}m${s}\x1b[0m` : id,
    inv: o.color ? wrap("7", "27") : id,
    link: o.links ? (t, u) => `\x1b]8;;${u}\x1b\\${t}\x1b]8;;\x1b\\` : (t) => t,
  };
}

export interface TermEnv { color: boolean; ascii: boolean; links: boolean }

/** NO_COLOR (https://no-color.org): present and non-empty disables colour. Colour also needs a TTY unless forced. */
export function detectEnv(env: Record<string, string | undefined>, isTTY: boolean, flags: { color?: boolean | "auto"; ascii?: boolean; links?: boolean } = {}): TermEnv {
  const noColor = (env.NO_COLOR ?? "") !== "" || env.TERM === "dumb";
  const color = flags.color === true ? true : flags.color === false ? false : isTTY && !noColor;
  const loc = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  const ascii = flags.ascii ?? (env.BLOCKWISE_ASCII === "1" || (loc !== "" && loc !== "C.UTF-8" && !/utf-?8/i.test(loc)));
  const links = flags.links ?? (color && isTTY);
  return { color, ascii, links };
}
