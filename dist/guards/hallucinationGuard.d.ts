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
 * Shown when the user asks *how* the previous recommendation was made
 * ("nasıl seçtin", "neye göre") and the model tries to answer without
 * actually re-consulting the API. Previously the model would fabricate
 * methodology ("approaches[] listesine baktım") — NODE-1. This honest
 * fallback invites a live re-verification instead.
 */
export declare const EXPLANATION_FALLBACK: string;
export declare function detectMetaHallucination(text: string): boolean;
export declare function stripPermissionTail(text: string): string;
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
 * Build the "Uzmanlık:" line from therapist.specialties[] ONLY.
 *
 * The model sometimes conflates specialties[] (what the therapist is
 * specialized in) with services[] (what session types they sell, e.g.
 * "Çift ve Evlilik Terapisi", "Aile Danışmanlığı"). To the user, this
 * looks like the therapist is credentialed in a field they're not.
 * Rewriting the line from specialties[] only eliminates the confusion.
 */
export declare function buildSpecialtyLine(t: Therapist, userTopics: string[]): string;
/**
 * Build the "Görüşme:" line from branches[] ONLY — never from address strings.
 *
 * Addresses are free-text and sometimes contain confusing district layers
 * (e.g. "Dikilitaş Mahallesi ... Beşiktaş Şişli"). The model used to parse
 * these and produce "Yüz yüze (Beşiktaş, Şişli)" — user sees two districts
 * for one branch. Using branches[].name (the canonical short label) plus
 * type markers keeps the card factual.
 */
export declare function buildLocationLine(t: Therapist): string;
/**
 * End-to-end card rewriter:
 *   1. Strip LLM-authored "Neden uygun:" and "Yaklaşım:" narrative lines.
 *   2. Replace "Uzmanlık:" with a specialties[]-only line (kills service-name
 *      mislabeling like "İlişkisel Problemler, Çift ve Evlilik Terapisi").
 *   3. Replace "Görüşme:" with a branches[]-derived line (kills address
 *      parsing hallucinations like "Beşiktaş, Şişli" from "Dikilitaş ...
 *      Beşiktaş Şişli" in a single address string).
 *   4. When the user provided checkable criteria (topic, city, budget,
 *      approach, online), inject an "Eşleşme:" block right before the
 *      [[expert:slug]] tag.
 *
 * Runs as the last pass of postProcessResponse, after card names/slugs are
 * already corrected — so every slug lookup is reliable.
 */
export declare function injectStructuredMatchBlocks(text: string, userMessage: string): Promise<string>;
//# sourceMappingURL=hallucinationGuard.d.ts.map