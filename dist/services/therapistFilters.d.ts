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
/**
 * Fuzzy specialty match — returns therapists who have at least one
 * specialty OR service whose name (Turkish-normalized) contains the query.
 *
 * Services are included because Planda's taxonomy is inconsistent: some
 * therapists have "Çocuk Gelişimi" as a specialty, others only sell
 * "Çocuk Terapisi" as a service without a matching specialty label.
 * A user asking for a "çocuk terapisti" expects both groups to surface.
 *
 *   filterBySpecialtyName(list, "anksiyete")  → matches specialty "Kaygı(Anksiyete) ve Korku"
 *   filterBySpecialtyName(list, "çocuk")      → matches specialty "Çocuk Gelişimi" OR service "Çocuk Terapisi"
 *   filterBySpecialtyName(list, "çift")       → matches specialty "Çift ve Aile" OR service "Çift ve Evlilik Terapisi"
 */
export declare function filterBySpecialtyName(list: Therapist[], query: string): Therapist[];
/**
 * Build a {normalized_name → specialty_id} map from a therapist list.
 * Useful when the model needs to resolve a user-typed specialty phrase
 * ("anksiyete", "kaygı") to an API-recognized specialty_id WITHOUT a
 * separate /specialties endpoint call — the data is already in every
 * find_therapists response under therapist.specialties[].
 */
export declare function buildSpecialtyMap(therapists: Therapist[]): Map<string, number>;
export interface ApplyFiltersParams {
    online?: boolean;
    gender?: "female" | "male";
    max_fee?: number;
    name?: string;
    specialty_name?: string;
    city?: string;
}
/**
 * Apply all configured filters in order. Returns the filtered list.
 * Order matters for composability: specialty and name first (narrowing),
 * then attribute predicates.
 */
export declare function applyAiSideFilters(list: Therapist[], f: ApplyFiltersParams): Therapist[];
//# sourceMappingURL=therapistFilters.d.ts.map