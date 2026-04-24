/**
 * Hallucination guard — verifies every therapist name / username in a response
 * corresponds to a real therapist from the Planda API.
 *
 * Operates in ANNOTATE mode: never mutates the response, only returns
 * violations. Callers log them; future work can add a retry loop.
 */
import type { Therapist } from "../types.js";
export interface HallucinationViolation {
    kind: "unknown_therapist" | "unknown_username" | "specialty_mismatch";
    value: string;
}
/**
 * Safe fallback shown when hallucination is detected with high confidence.
 * Kept generic so it works for any user query without revealing details.
 */
export declare const HALLUCINATION_FALLBACK: string;
/**
 * Shown when specialty-match enforcement prunes every card and none survive.
 * Tone is "we narrowed too far" rather than "we broke" — honest about scope,
 * invites the user to relax a filter instead of reporting a generic error.
 */
export declare const NO_MATCH_FALLBACK: string;
/**
 * Decides whether a response should be replaced with the safe fallback based
 * on verification output. Logic (intentionally conservative):
 *
 *   1. No violations                           → keep response
 *   2. Any unknown_therapist AND no tool call  → strong hallucination signal,
 *                                                  model answered from memory
 *                                                  → REPLACE
 *   3. >= 2 unknown_therapist violations       → multiple fabricated names,
 *                                                  unreliable → REPLACE
 *   4. Single unknown (tool WAS called)        → could be fuzzy-match edge
 *                                                  case → keep, log only
 *   5. Response presents therapist cards (bold
 *      header OR expert tag) AND no tool call  → even if every name happens to
 *                                                  exist in the roster, the fee
 *                                                  / specialty / location
 *                                                  details are fabricated
 *                                                  (NODE-2 class) → REPLACE
 *
 *   Optional `responseText` enables rule #5; if omitted, falls back to #1–4.
 */
export declare function shouldUseFallback(violations: HallucinationViolation[], toolCallCount: number, responseText?: string): boolean;
/**
 * Scan a response for therapist names (**Name** — headers) and expert tags.
 * Returns any that don't correspond to real therapists.
 *
 * NOTE: This runs AFTER postProcessResponse, which already fixes misspelled
 * names where a fuzzy match exists. Surviving violations are true hallucinations.
 */
export declare function verifyResponse(text: string): Promise<HallucinationViolation[]>;
/**
 * Check that every therapist recommended in the response actually covers at
 * least one topic the user asked about. Returns violations for mismatches.
 *
 * Runs only when the user message carries a detectable topic — vague queries
 * like "terapist arıyorum" skip this check.
 */
export declare function verifySpecialtyMatch(userMessage: string, response: string): Promise<HallucinationViolation[]>;
/** Extract the therapist username slug from a violation .value string. */
export declare function extractMismatchedUsernames(violations: HallucinationViolation[]): Set<string>;
/**
 * Remove therapist cards whose username is in the mismatch set.
 *
 * A "card" is matched by regex as any block starting with a **Bold** — header
 * and ending with its [[expert:slug]] tag (plus trailing whitespace). Non-card
 * prose between cards (intro / outro / separators) is preserved verbatim.
 */
export declare function pruneMismatchedCards(text: string, mismatchedUsernames: Set<string>): {
    response: string;
    removedCount: number;
    keptCount: number;
};
export interface UserRequest {
    topics: string[];
    city: string | null;
    maxFee: number | null;
    approach: string | null;
    prefersOnline: boolean | null;
}
/** Pull structured request attributes out of a free-form user message. */
export declare function extractUserRequest(userMessage: string): UserRequest;
/**
 * Build the "Eşleşme" multi-line block for one therapist, given the user's
 * request. Returns empty string if the user asked nothing checkable.
 *
 *   Eşleşme:
 *   ✓ Uzmanlık: İlişkisel Problemler
 *   ✓ Şehir: İstanbul — Nişantaşı
 *   ✓ Bütçe: 6.000 TL (talebin: 7.000 TL altı)
 *   — Yaklaşım (BDT): profilde henüz doğrulanmadı
 */
export declare function buildMatchBlock(t: Therapist, req: UserRequest): string;
/**
 * Strip the LLM's free-form "Neden uygun:" narrative line from every card,
 * then inject the data-derived Eşleşme block right before each [[expert:slug]]
 * tag. No-op when the user didn't ask for anything checkable.
 *
 * Runs as the last pass of postProcessResponse, after card names/slugs are
 * already corrected — so by the time we look up each slug, it's reliable.
 */
export declare function injectStructuredMatchBlocks(text: string, userMessage: string): Promise<string>;
//# sourceMappingURL=hallucinationGuard.d.ts.map