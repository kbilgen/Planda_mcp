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
export interface DiversifyOptions {
    /** Explicit seed for deterministic ordering (tests). */
    seed?: number;
    /** Force enable/disable; defaults to env DIVERSIFY_RANKING !== "0". */
    enabled?: boolean;
    /** Injectable clock for tests; defaults to Date.now(). */
    now?: number;
}
export declare function isDiversifyEnabled(): boolean;
/**
 * Return a re-ranked copy of `therapists`. Priority becomes a soft boost on top
 * of a seeded shuffle. Non-mutating. With 0 or 1 items it's a passthrough.
 */
export declare function diversifyRanking(therapists: Therapist[], opts?: DiversifyOptions): Therapist[];
//# sourceMappingURL=therapistRanker.d.ts.map