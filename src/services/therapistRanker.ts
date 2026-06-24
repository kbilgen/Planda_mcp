/**
 * Result diversification — keeps `priority` as a soft boost instead of a hard
 * sort key.
 *
 * Problem (reported 2026-06-24): the Planda API returns therapists ordered by
 * `priority` descending. A handful of generalists carry a high priority
 * (9.2–9.98) and match almost every specialty, so "kaygı online" and
 * "depresyon online" both surfaced the exact same top names every time. The
 * other ~33 therapists (priority 0) effectively never appeared.
 *
 * Fix: re-rank the filtered candidates with a weighted shuffle —
 *   score = random[0,1) + priorityNorm * BOOST_WEIGHT
 * Priority therapists still get a meaningful edge (they cluster in the upper
 * half) but the edge is beatable, so:
 *   • the order rotates between calls (different faces surface), and
 *   • priority-0 therapists can reach the top 2-3 the model picks from.
 *
 * Determinism: a seed can be injected (tests). At runtime the seed rotates on
 * a time bucket so repeated identical queries diversify, while a single
 * request — including its tool-miss retry — stays stable within the bucket.
 *
 * Reversible: set DIVERSIFY_RANKING=0 to fall back to the API's raw
 * priority-descending order.
 */

import type { Therapist } from "../types.js";

/**
 * How much a max-priority therapist is boosted over a priority-0 one, on top
 * of the [0,1) random base. Higher → priority dominates more; lower → flatter
 * rotation across the whole roster. Tunable via PRIORITY_BOOST_WEIGHT without
 * a code change. Default 0.5 keeps promoted therapists favoured but beatable.
 */
function boostWeight(): number {
  const raw = parseFloat(process.env.PRIORITY_BOOST_WEIGHT ?? "");
  return Number.isFinite(raw) && raw >= 0 ? raw : 0.5;
}

/** Priority is roughly 0–10 in the data; normalise into [0,1]. */
const PRIORITY_SCALE = 10;

/** Rotation window — within this many ms the seed (and thus order) is stable. */
const ROTATION_WINDOW_MS = 60 * 1000;

/** Mulberry32 — small, fast, seedable PRNG. Returns a fn yielding [0,1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function priorityNorm(t: Therapist): number {
  const p = typeof t.priority === "number" ? t.priority : 0;
  if (!Number.isFinite(p) || p <= 0) return 0;
  return Math.min(p, PRIORITY_SCALE) / PRIORITY_SCALE;
}

export interface DiversifyOptions {
  /** Explicit seed for deterministic ordering (tests). */
  seed?: number;
  /** Force enable/disable; defaults to env DIVERSIFY_RANKING !== "0". */
  enabled?: boolean;
  /** Injectable clock for tests; defaults to Date.now(). */
  now?: number;
}

export function isDiversifyEnabled(): boolean {
  return process.env.DIVERSIFY_RANKING !== "0";
}

/**
 * Return a re-ranked copy of `therapists`. Priority becomes a soft boost on top
 * of a seeded shuffle. Non-mutating. With 0 or 1 items it's a passthrough.
 */
export function diversifyRanking(
  therapists: Therapist[],
  opts: DiversifyOptions = {}
): Therapist[] {
  const enabled = opts.enabled ?? isDiversifyEnabled();
  if (!enabled || therapists.length <= 1) return therapists;

  const now = opts.now ?? Date.now();
  const seed = opts.seed ?? Math.floor(now / ROTATION_WINDOW_MS) + therapists.length;
  const rand = mulberry32(seed);
  const w = boostWeight();

  return therapists
    .map((t, i) => ({
      t,
      i,
      score: rand() + priorityNorm(t) * w,
    }))
    // Higher score first; original index as a stable final tiebreaker.
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.t);
}
