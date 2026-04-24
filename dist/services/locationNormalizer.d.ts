/**
 * District / semt → parent city resolver.
 *
 * Planda's API `city` field is il-level only. When a user (or the model
 * acting on their behalf) passes an İstanbul ilçe/semt ("Göztepe", "Kartal",
 * "Nişantaşı") as city, the API returns zero rows and the model says
 * "bulunamadı" — even though the therapist exists in that very district.
 *
 * This resolver sits in front of the API call: it looks up the input
 * against a known district map and returns both the parent city (for
 * the API query) and the original district (for a post-filter against
 * branches[].name / branches[].address). Prompt compliance is not required.
 */
import type { Therapist } from "../types.js";
/**
 * Normalized district keyword → parent city display form.
 * Lowercase, diacritic-stripped; matches come from normTR(userInput).
 */
export declare const DISTRICT_TO_CITY: Record<string, string>;
/** Which side of İstanbul is this normalized district on? */
export declare function istanbulSide(district: string): "avrupa" | "anadolu" | null;
export interface ResolvedLocation {
    /** City to pass to the Planda API query (il-level name) */
    city: string;
    /** Original district keyword, normalized — for branches[] post-filter */
    district: string | null;
    /** When the input was already a city, we set this for downstream transparency */
    inputWasCity: boolean;
}
/**
 * Resolve a free-form city / district input against the known map.
 *
 *   "Göztepe"   → { city: "İstanbul", district: "goztepe" }
 *   "Kadıköy"   → { city: "İstanbul", district: "kadikoy" }
 *   "İstanbul"  → { city: "İstanbul", district: null }
 *   "Mersin"    → { city: "Mersin",   district: null }  (unknown → pass through)
 */
export declare function resolveLocation(input: string): ResolvedLocation;
/**
 * Check whether a therapist has a physical branch that matches the given
 * district keyword. Matches both `branches[].name` and `branches[].address`,
 * so "goztepe" resolves whether the branch label is "Göztepe" (as `name`)
 * or the district appears in the free-text address.
 */
export declare function therapistInDistrict(t: Therapist, district: string): boolean;
/**
 * When the user targets a specific İstanbul side, filter out therapists
 * whose ONLY physical presence is on the opposite side. Online-only
 * branches never count against a side match.
 */
export declare function matchesIstanbulSide(t: Therapist, requestedSide: "avrupa" | "anadolu"): boolean;
//# sourceMappingURL=locationNormalizer.d.ts.map