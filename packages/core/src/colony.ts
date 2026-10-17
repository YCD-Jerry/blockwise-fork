// The facade the orchestrator drives. Pure: no I/O, no chain, no Math.random (seeded rng only).
// THIS FILE IS THE INTERFACE CONTRACT between packages/core (implements) and apps/orchestrator (consumes).
// Docs: architecture.md section 3a (search) and 3b (funding). Do not change a signature without telling the integrator.
import type { BlockwiseEvent, Operator, Ref } from "./events";
import type { Spec } from "./spec";

export interface ColonyConfig {
  seed: number;
  perGeneration: number; // N candidates planned per generation (default 200)
  generations: number;
  confirmTopK: number; // elites sent to a confirm look per generation (default 8)
  roles: { devEnd: number; confirmEnd: number };
  returns: readonly number[]; // only for the offline baseline / ceiling proxy; never for scoring on-chain results
}

export interface Candidate {
  gen: number;
  idx: number;
  spec: Spec;
  operator: Operator;
  parent?: Ref; // lineage; undefined = no parent
}

export interface EvalRecord {
  gen: number;
  idx: number;
  spec: Spec;
  operator: Operator;
  parent?: Ref;
  dev: number;
  trades: number;
}

export interface Colony {
  /** Plan generation `gen`: allocation among operators (Thompson, floor 5%), N valid, de-duplicated specs (never a specId already evaluated this epoch). */
  planGeneration(gen: number): { allocation: { operator: Operator; count: number }[]; candidates: Candidate[] };

  /** Feed one landed dev result (from a receipt/event). Idempotent per (gen, idx). Returns whether it discovered (beat its niche elite or filled an empty niche). */
  recordDev(rec: EvalRecord): { discovered: boolean };

  /** Close a generation: update bandit credit with descendant credit, niche labels, diagnostics. Emits the `generation_end` payload parts and a `map` event. */
  endGeneration(gen: number): {
    best: { idx: number; dev: number; params: number[] };
    archive: { gen: number; idx: number; dev: number; params: number[] }[]; // one elite per non-empty niche
    bandit: Record<string, number>;
    map: Extract<BlockwiseEvent, { type: "map" }>;
  };

  /** Niche elites (up to confirmTopK) that still need their one confirm look. */
  confirmCandidates(): Candidate[];
  recordConfirm(ref: Ref, score: number, trades: number): void;

  /** Champion chosen on CONFIRM (not dev); null until at least one confirm exists. Freezing it is the caller's job (one sealed look). */
  champion(): { gen: number; idx: number; spec: Spec; dev: number; confirm: number } | null;

  /** Funding steering (architecture 3b): allocation by agent key "gen:idx" in test MON. Steered share phi = min(0.25, F/(F+10)). */
  setFunding(byAgent: Record<string, number>): void;
  /** Suggested split (advice only): w_i proportional to max(0, c_i - g_i/2), cap 40%, renormalised. */
  suggestedSplit(): { agent: Ref; weight: number }[];

  /** Rebuild state from chain records (resume, principle 10). Records may repeat or arrive out of order. */
  restore(records: EvalRecord[], confirms: { ref: Ref; score: number; trades: number }[]): void;
}

export { createColony } from "./colony-impl";
