import type { Therapist, Approach } from "../types.js";
declare function normTR(s: string): string;
/** Resolve a free-form approach query to the substrings that match. */
declare function approachSubstrings(query: string): string[];
/** Does the therapist's approaches[] satisfy the query? */
declare function approachMatches(approaches: Approach[], query: string): boolean;
/**
 * Filter `candidates` to therapists whose approaches[] contains the requested
 * approach. Concurrency is bounded so we don't hammer the Planda API when
 * there are many candidates; 5 in-flight requests is plenty for a roster of
 * ~60 therapists.
 *
 * Therapists with no approaches[] data (empty or fetch-failed) are EXCLUDED
 * — we never recommend an approach we can't prove. If the user's question
 * was about a specific approach and we can't verify, returning fewer
 * (correct) results is better than padding with unverified ones.
 */
export declare function filterByApproachVerified(candidates: Therapist[], query: string, concurrency?: number): Promise<Therapist[]>;
/** Test-only — exposed for unit tests, not part of the runtime contract. */
export declare const __test__: {
    approachSubstrings: typeof approachSubstrings;
    approachMatches: typeof approachMatches;
    normTR: typeof normTR;
};
export {};
//# sourceMappingURL=approachVerifier.d.ts.map