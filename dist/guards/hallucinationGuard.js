/**
 * Hallucination guard — verifies every therapist name / username in a response
 * corresponds to a real therapist from the Planda API.
 *
 * Operates in ANNOTATE mode: never mutates the response, only returns
 * violations. Callers log them; future work can add a retry loop.
 */
import { findTherapists } from "../services/therapistApi.js";
// ─── Cached full roster (5 min TTL) — mirrors getCachedTherapists in index.ts ─
const ROSTER_TTL_MS = 5 * 60 * 1000;
let roster = null;
async function getRoster() {
    if (roster && Date.now() - roster.fetchedAt < ROSTER_TTL_MS) {
        return roster.therapists;
    }
    try {
        const raw = await findTherapists({ per_page: 500 });
        const therapists = raw.data ?? raw.therapists ?? raw.results ?? [];
        roster = { therapists, fetchedAt: Date.now() };
        return therapists;
    }
    catch {
        return roster?.therapists ?? [];
    }
}
function normTR(s) {
    return s
        // Handle Turkish capital İ BEFORE toLowerCase. JS toLowerCase on İ produces
        // "i̇" (i + combining dot U+0307); the dot later gets stripped to a space
        // by /[^a-z0-9 ]/ which splits "İlişkide" into "i liskide" — breaking any
        // keyword match that starts with "i". Same fix as therapistFilters.normTR.
        .replace(/İ/g, "i")
        .replace(/I/g, "i")
        .toLowerCase()
        .replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u")
        .replace(/ö/g, "o").replace(/ı/g, "i").replace(/ç/g, "c")
        .replace(/[^a-z0-9 ]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function fuzzyMatchesAnyTherapist(query, therapists) {
    const normQuery = normTR(query);
    const words = normQuery.split(" ").filter((w) => w.length >= 2);
    if (!words.length)
        return false;
    for (const t of therapists) {
        const full = t.full_name?.trim() || [t.name, t.surname].filter(Boolean).join(" ");
        const normFull = normTR(full);
        if (!normFull)
            continue;
        if (words.every((w) => normFull.includes(w)))
            return true;
    }
    return false;
}
/**
 * Safe fallback shown when hallucination is detected with high confidence.
 * Kept generic so it works for any user query without revealing details.
 */
export const HALLUCINATION_FALLBACK = "Bu soruda bir aksaklık yaşadım ve doğru bilgi üretemedim. Lütfen mesajını " +
    "tekrar gönderebilir misin? Aradığın terapisti birlikte bulalım.";
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
export function shouldUseFallback(violations, toolCallCount, responseText) {
    const unknownTherapists = violations.filter((v) => v.kind === "unknown_therapist").length;
    if (unknownTherapists >= 1 && toolCallCount === 0)
        return true;
    if (unknownTherapists >= 2)
        return true;
    // Rule #5 — presenting therapist cards without having consulted the API
    // means the body of each card (fee, approaches, availability) is invented
    // even if the name itself happens to match a real therapist. This is the
    // exact failure mode we saw in Sentry NODE-2.
    if (toolCallCount === 0 && responseText) {
        const hasCard = /\*\*[^*\n]+\*\*\s*—/.test(responseText) ||
            /\[\[expert:[^\]]+\]\]/.test(responseText);
        if (hasCard)
            return true;
    }
    return false;
}
/**
 * Scan a response for therapist names (**Name** — headers) and expert tags.
 * Returns any that don't correspond to real therapists.
 *
 * NOTE: This runs AFTER postProcessResponse, which already fixes misspelled
 * names where a fuzzy match exists. Surviving violations are true hallucinations.
 */
export async function verifyResponse(text) {
    const hasHeaders = /\*\*[^*\n]+\*\*\s*—/.test(text);
    const hasTags = /\[\[expert:[^\]]+\]\]/.test(text);
    if (!hasHeaders && !hasTags)
        return [];
    const therapists = await getRoster();
    if (therapists.length === 0)
        return []; // API down → don't false-flag
    const usernames = new Set(therapists.map((t) => t.username).filter(Boolean));
    const violations = [];
    // 1. Bold-header name check
    const headerPat = /\*\*([^*\n]+)\*\*\s*—/g;
    let m;
    const seen = new Set();
    while ((m = headerPat.exec(text)) !== null) {
        const name = m[1].trim();
        if (seen.has(name))
            continue;
        seen.add(name);
        // Filter out common non-name headers ("Ücret", "Görüşme", etc.)
        if (name.length < 4 || /^(ucret|ücret|görüşme|gorusme|konum|fiyat|not)$/i.test(name))
            continue;
        if (!fuzzyMatchesAnyTherapist(name, therapists)) {
            violations.push({ kind: "unknown_therapist", value: name });
        }
    }
    // 2. Expert tag username check
    const tagPat = /\[\[expert:([^\]]+)\]\]/g;
    const seenTags = new Set();
    while ((m = tagPat.exec(text)) !== null) {
        const username = m[1].trim();
        if (seenTags.has(username))
            continue;
        seenTags.add(username);
        if (!usernames.has(username)) {
            violations.push({ kind: "unknown_username", value: username });
        }
    }
    return violations;
}
// ─── Specialty-match verification ─────────────────────────────────────────────
//
// "Padding" hallucination: model recommends a therapist whose specialties[] do
// NOT cover the user's requested topic. The therapist is real, the name is
// real — but the recommendation is wrong. Example seen in prod:
//   User: "ilişkide sorun var" → bot recommends Ekin Alankuş
//   Ekin's specialties[] = [Travmatik Deneyim, Kaygı] — no İlişkisel match
//
// This guard extracts topic keywords from the user message, cross-checks
// each recommended therapist's specialties[], and flags mismatches.
// Topic → substring(s) that should appear in specialties[].name (normTR form).
// userWords are matched with WORD-BOUNDARY awareness: short tokens (< 5 chars)
// must appear as a whole word in the message; longer tokens are allowed as
// prefix matches so "iliskide" (from "İlişkide") still matches "iliski". This
// avoids the "yaşıyorum" → false-match "yas" class of bug seen in prod
// (Sentry cf8da740, 2026-04-23).
const TOPIC_SPECIALTY_MAP = {
    iliski: { userWords: ["iliski", "evlilik", "partner", "esim", "cift", "bosanma", "ayrilik"], specialtySubstr: ["iliskisel"] },
    kaygi: { userWords: ["kaygi", "anksiyete", "panik", "fobi", "korku"], specialtySubstr: ["kaygi", "anksiyete"] },
    depresyon: { userWords: ["depresyon", "mutsuz", "umutsuz"], specialtySubstr: ["depresyon"] },
    travma: { userWords: ["travma", "travmatik", "taciz", "istismar"], specialtySubstr: ["travmatik", "travma"] },
    // "yas" alone would false-match "yaşıyorum". Force explicit grief context.
    yas: { userWords: ["yasta", "matem", "kayip", "vefat", "olum", "olen"], specialtySubstr: ["kayip", "yas"] },
    ergen: { userWords: ["ergen", "cocuk", "cocugum"], specialtySubstr: ["ergen", "cocuk", "akran"] },
    iletisim: { userWords: ["iletisim", "iletisemiyorum", "anlasamiyorum"], specialtySubstr: ["iletisim"] },
    ofke: { userWords: ["ofke", "ofkeli", "sinirli", "saldirgan"], specialtySubstr: ["duygu yonetimi", "ofke"] },
    yeme: { userWords: ["yeme", "anoreksi", "bulimi", "beden algisi"], specialtySubstr: ["yeme", "beden algisi"] },
};
/**
 * Word-aware keyword search.
 *   - Short keywords (< 5 chars): must appear as a whole word.
 *     "yas" matches "yas tutuyorum" but NOT "yasıyorum" / "yaslı".
 *   - Longer keywords (>= 5 chars): prefix match allowed.
 *     "iliski" matches "iliskide", "iliskisel", "iliskim".
 *
 * `normalized` is the already-normTR'd message; `keywords` are normalized
 * lowercase Latin forms.
 */
function hasWordOrPrefix(normalized, keywords) {
    const words = normalized.split(" ").filter(Boolean);
    return keywords.some((k) => {
        if (!k)
            return false;
        if (k.length < 5)
            return words.some((w) => w === k);
        return words.some((w) => w === k || w.startsWith(k));
    });
}
function extractUserTopics(userMessage) {
    const n = normTR(userMessage);
    const topics = [];
    for (const [key, { userWords }] of Object.entries(TOPIC_SPECIALTY_MAP)) {
        if (hasWordOrPrefix(n, userWords))
            topics.push(key);
    }
    return topics;
}
function therapistCoversTopic(t, topic) {
    const rule = TOPIC_SPECIALTY_MAP[topic];
    if (!rule)
        return true; // unknown topic → don't flag
    const specialtyText = (t.specialties ?? [])
        .map((s) => normTR(s?.name ?? ""))
        .join(" ");
    return rule.specialtySubstr.some((sub) => specialtyText.includes(sub));
}
/**
 * Check that every therapist recommended in the response actually covers at
 * least one topic the user asked about. Returns violations for mismatches.
 *
 * Runs only when the user message carries a detectable topic — vague queries
 * like "terapist arıyorum" skip this check.
 */
export async function verifySpecialtyMatch(userMessage, response) {
    const topics = extractUserTopics(userMessage);
    if (topics.length === 0)
        return []; // no topic inferred → can't evaluate
    const tagPat = /\[\[expert:([^\]]+)\]\]/g;
    const recommended = new Set();
    let m;
    while ((m = tagPat.exec(response)) !== null) {
        recommended.add(m[1].trim());
    }
    if (recommended.size === 0)
        return []; // no cards → nothing to validate
    const therapists = await getRoster();
    if (therapists.length === 0)
        return [];
    const violations = [];
    for (const slug of recommended) {
        const t = therapists.find((x) => x.username === slug);
        if (!t)
            continue; // unknown_username already handled
        const covers = topics.some((topic) => therapistCoversTopic(t, topic));
        if (!covers) {
            violations.push({
                kind: "specialty_mismatch",
                value: `${slug} (user topic: ${topics.join(",")}; therapist specialties: ${(t.specialties ?? []).map((s) => s.name).join(", ") || "none"})`,
            });
        }
    }
    return violations;
}
//# sourceMappingURL=hallucinationGuard.js.map