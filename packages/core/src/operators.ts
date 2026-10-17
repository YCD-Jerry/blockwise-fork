// Proposal operators (architecture 3a). Pure and seeded. Every output passes validate().
import { type Rng, int, normal } from "./rng";
import { LAGS, PARAMS, THR_MAX, W_MAX, W_MIN, clampSpec, validate } from "./spec";

export const OP_RANDOM = 0, OP_MUTATE = 1, OP_CROSSOVER = 2, OP_SWEEP = 3;

function check(p: number[]): number[] {
  const bad = validate(p);
  if (bad) throw new Error(`operator produced invalid spec: ${bad}`);
  return p;
}

/** Uniform weights; threshold skewed low so most specs trade (same shape as the golden generator). */
export function randomSpec(rng: Rng): number[] {
  const p = Array.from({ length: LAGS }, () => int(rng, W_MIN, W_MAX));
  const band = rng() < 0.7 ? 3000 : THR_MAX;
  p.push(Math.floor(rng() * rng() * band));
  return check(p);
}

function jitter(rng: Rng, parent: readonly number[], k: number, scaleW: number): number {
  if (k < LAGS) {
    const d = Math.round(normal(rng) * scaleW);
    return parent[k]! + (d === 0 ? (rng() < 0.5 ? -1 : 1) : d);
  }
  const f = Math.exp(normal(rng) * 0.35);
  const base = parent[k]!;
  return Math.round(base * f + (base < 20 ? normal(rng) * 20 : 0));
}

/** Perturb 1 to 3 coordinates. Guaranteed different from the parent when the grammar allows. */
export function mutate(parent: readonly number[], rng: Rng): number[] {
  for (let attempt = 0; attempt < 8; attempt++) {
    const q = [...parent];
    const m = int(rng, 1, 3);
    for (let j = 0; j < m; j++) {
      const k = int(rng, 0, PARAMS - 1);
      q[k] = jitter(rng, parent, k, 8);
    }
    const c = clampSpec(q);
    if (c.some((v, k) => v !== parent[k])) return check(c);
  }
  const c = clampSpec(parent.map((v, k) => (k === 0 ? v + (v < W_MAX ? 1 : -1) : v)));
  return check(c);
}

/** Per-coordinate pick from either parent, plus uniform-blend of the threshold half of the time. */
export function crossover(a: readonly number[], b: readonly number[], rng: Rng): number[] {
  const q = a.map((v, k) => (rng() < 0.5 ? v : b[k]!));
  if (rng() < 0.5) q[LAGS] = Math.round((a[LAGS]! + b[LAGS]!) / 2);
  return check(clampSpec(q));
}

const STEPS = [1, 2, 3, 5, 8, 12, 20];

/** Single-coordinate step along a ladder. `blocked(k)` marks coordinates that are tabu for this parent. Returns the coordinate too. */
export function sweep(parent: readonly number[], rng: Rng, blocked: (k: number) => boolean = () => false): { spec: number[]; coord: number } {
  const open: number[] = [];
  for (let k = 0; k < PARAMS; k++) if (!blocked(k)) open.push(k);
  const pool = open.length ? open : Array.from({ length: PARAMS }, (_, k) => k);
  for (let attempt = 0; attempt < 8; attempt++) {
    const k = pool[int(rng, 0, pool.length - 1)]!;
    const dir = rng() < 0.5 ? -1 : 1;
    const q = [...parent];
    if (k < LAGS) q[k] = parent[k]! + dir * STEPS[int(rng, 0, STEPS.length - 1)]!;
    else q[k] = Math.round(parent[k]! * (1 + dir * 0.25 * int(rng, 1, 4) / 2)) + dir * int(rng, 1, 40);
    const c = clampSpec(q);
    if (c[k] !== parent[k]) return { spec: check(c), coord: k };
  }
  return { spec: mutate(parent, rng), coord: 0 };
}
