// Thompson-sampling portfolio over operators (architecture 3a).
import { type Rng, normal } from "./rng";

export const DISCOUNT = 0.8;
export const FLOOR = 0.05;
export const CREDIT_DECAY = 0.5;
export const CREDIT_DEPTH = 4;
export const STAGNATION_GENS = 3;
export const BURST_SHARE = 0.3;
export const OPS = 4;

function gamma(rng: Rng, alpha: number): number {
  // Marsaglia-Tsang, alpha >= 1
  const d = alpha - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(rng);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = Math.max(rng(), 1e-12);
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
export function beta(rng: Rng, a: number, b: number): number {
  const x = gamma(rng, a), y = gamma(rng, b);
  return x / (x + y);
}

export class Portfolio {
  n = [0, 0, 0, 0]; // discounted proposals
  s = [0, 0, 0, 0]; // discounted discoveries (incl. descendant credit)

  /** Fold one finished generation in: discount the past, then add this generation's counts. */
  update(proposals: number[], credit: number[]) {
    for (let a = 0; a < OPS; a++) {
      this.n[a] = this.n[a]! * DISCOUNT + proposals[a]!;
      this.s[a] = this.s[a]! * DISCOUNT + credit[a]!;
    }
  }

  /** Thompson draw -> shares with floor 5% per operator. Shares sum to 1. */
  shares(rng: Rng): number[] {
    const th = [0, 1, 2, 3].map((a) => beta(rng, 1 + this.s[a]!, 1 + Math.max(0, this.n[a]! - this.s[a]!)));
    const tot = th.reduce((x, y) => x + y, 0);
    return th.map((t) => FLOOR + (1 - FLOOR * OPS) * (t / tot));
  }

  rates(): number[] { return this.n.map((n, a) => (n > 0 ? Math.min(1, this.s[a]! / n) : 0)); }
}

/** Largest-remainder rounding of shares to integer counts summing to total. */
export function apportion(shares: number[], total: number): number[] {
  const raw = shares.map((s) => s * total);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((x, y) => x + y, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let j = 0; left > 0; j = (j + 1) % order.length, left--) out[order[j]!.i]!++;
  return out;
}
