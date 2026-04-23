/**
 * Therapist list filter helpers — applied server-side inside tool handlers
 * so the model's filter intent becomes an authoritative contract instead
 * of a post-hoc AI-side cleanup.
 *
 * All helpers are pure, Turkish-aware, and bound-safe on empty inputs.
 */
import type { Therapist } from "../types.js";
/** Therapist has at least one online branch. */
export declare function matchesOnline(t: Therapist): boolean;
/** Therapist has at least one physical branch (optionally in a specific city). */
export declare function matchesPhysical(t: Therapist, city?: string): boolean;
/** Therapist's lowest priced service is <= maxFee (TL). */
export declare function matchesMaxFee(t: Therapist, maxFee: number): boolean;
/** Therapist's top-level or data.gender equals the requested gender. */
export declare function matchesGender(t: Therapist, gender: "female" | "male"): boolean;
/**
 * Fuzzy name match — returns therapists whose full_name / name+surname /
 * username contains all query words (normalized, Turkish-insensitive).
 *
 *   filterByFuzzyName(list, "Ekin Alankuş")     → matches "Ekin Alankuş"
 *   filterByFuzzyName(list, "ayse demir")       → matches "Ayşe Demir"
 *   filterByFuzzyName(list, "ekin alankus")     → same
 *   filterByFuzzyName(list, "alankus")          → any with "alankus" in name
 */
export declare function filterByFuzzyName(list: Therapist[], query: string): Therapist[];
export interface ApplyFiltersParams {
    online?: boolean;
    gender?: "female" | "male";
    max_fee?: number;
    name?: string;
    city?: string;
}
/**
 * Apply all configured filters in order. Returns the filtered list.
 * Order matters for composability: name first (narrowing), then attributes.
 */
export declare function applyAiSideFilters(list: Therapist[], f: ApplyFiltersParams): Therapist[];
//# sourceMappingURL=therapistFilters.d.ts.map