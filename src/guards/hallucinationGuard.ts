/**
 * Hallucination guard — verifies every therapist name / username in a response
 * corresponds to a real therapist from the Planda API.
 *
 * Operates in ANNOTATE mode: never mutates the response, only returns
 * violations. Callers log them; future work can add a retry loop.
 */

import { findTherapists } from "../services/therapistApi.js";
import type { Therapist } from "../types.js";
import type { ChatMessage } from "../sessionStore.js";

export interface HallucinationViolation {
  kind: "unknown_therapist" | "unknown_username" | "specialty_mismatch";
  value: string;
}

// ─── Cached full roster (5 min TTL) — mirrors getCachedTherapists in index.ts ─

const ROSTER_TTL_MS = 5 * 60 * 1000;
let roster: { therapists: Therapist[]; fetchedAt: number } | null = null;

async function getRoster(): Promise<Therapist[]> {
  if (roster && Date.now() - roster.fetchedAt < ROSTER_TTL_MS) {
    return roster.therapists;
  }
  try {
    const raw = await findTherapists({ per_page: 500 });
    const therapists = raw.data ?? raw.therapists ?? raw.results ?? [];
    roster = { therapists, fetchedAt: Date.now() };
    return therapists;
  } catch {
    return roster?.therapists ?? [];
  }
}

function normTR(s: string): string {
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

function fuzzyMatchesAnyTherapist(query: string, therapists: Therapist[]): boolean {
  const normQuery = normTR(query);
  const words = normQuery.split(" ").filter((w) => w.length >= 2);
  if (!words.length) return false;

  for (const t of therapists) {
    const full =
      t.full_name?.trim() || [t.name, t.surname].filter(Boolean).join(" ");
    const normFull = normTR(full);
    if (!normFull) continue;
    if (words.every((w) => normFull.includes(w))) return true;
  }
  return false;
}

/**
 * Safe fallback shown when hallucination is detected with high confidence.
 * Kept generic so it works for any user query without revealing details.
 */
export const HALLUCINATION_FALLBACK =
  "Bu soruda bir aksaklık yaşadım ve doğru bilgi üretemedim. Lütfen mesajını " +
  "tekrar gönderebilir misin? Aradığın terapisti birlikte bulalım.";

/**
 * Shown when specialty-match enforcement prunes every card and none survive.
 * Tone is "we narrowed too far" rather than "we broke" — honest about scope,
 * invites the user to relax a filter instead of reporting a generic error.
 */
export const NO_MATCH_FALLBACK =
  "Aradığın kriterlere tam uyan bir terapist bulamadım. " +
  "İstersen filtreleri biraz genişletelim — farklı bir alan, online seçeneği " +
  "veya başka bir şehir ile tekrar bakabilirim.";

/**
 * Shown when the user asks *how* the previous recommendation was made
 * ("nasıl seçtin", "neye göre") and the model tries to answer without
 * actually re-consulting the API. Previously the model would fabricate
 * methodology ("approaches[] listesine baktım") — NODE-1. This honest
 * fallback invites a live re-verification instead.
 */
export const EXPLANATION_FALLBACK =
  "Önceki önerinin tam dayanağını şu an yeniden doğrulamam gerekiyor. " +
  "İstersen güncel listeye bakıp sana birkaç terapist yeniden öneririm — " +
  "aynı kriterlerle mi devam edelim, yoksa başka bir konu eklemek ister misin?";

/**
 * Phrases the model tends to fabricate when asked for methodology. These
 * describe *internal processes* (API field lookups, database queries,
 * programmatic filtering) that are never grounded in anything the user
 * could verify — and the model reliably invents them even when no tool
 * was called that turn. If one of these appears alongside zero tool calls,
 * we treat the response as meta-hallucinated and replace it.
 */
const META_HALLUCINATION_PHRASES = [
  "approaches[]",
  "approaches listesi",
  "planda veritaban",
  "veritabanında kontrol",
  "veritabanını kontrol",
  "veri tabanı",
  "listesine baktım",
  "listesini kontrol ettim",
  "kriterlerine göre filtreledi",
  "kriterlerine göre filtrelemişti",
];

export function detectMetaHallucination(text: string): boolean {
  const lower = text.toLowerCase();
  return META_HALLUCINATION_PHRASES.some((p) => lower.includes(p));
}

/**
 * Forbidden "permission question" closers. Prompt explicitly bans these,
 * but the model still emits them under pressure. When the response has
 * real recommendations (tag present), we strip a trailing permission
 * question — it makes the user feel pushed back through a needless gate.
 *
 * Matches: "Nasıl istersin?", "İster misin?", "Ayrıca bakmamı ister misin?",
 *   "Genişletmemi ister misin?", "Devam etmek ister misin?"
 *
 * The regex targets ONLY the last sentence; mid-paragraph "istersen"
 * phrases stay untouched.
 */
const PERMISSION_TAIL_PAT =
  /\n+[^\n]*(?:nasıl\s+istersin|ister\s+misin|ister\s+misiniz|öner(?:memi|eyim\s+mi)|bakmamı\s+ister(?:sin)?)[^\n]*\s*$/i;

export function stripPermissionTail(text: string): string {
  // Only strip when the response contains real card content — otherwise
  // a "Nasıl yardımcı olayım?" greeting could lose its question mark.
  const hasCard =
    /\*\*[^*\n]+\*\*\s*—/.test(text) || /\[\[expert:[^\]]+\]\]/.test(text);
  if (!hasCard) return text;
  return text.replace(PERMISSION_TAIL_PAT, "").trimEnd();
}

/**
 * Does the text contain therapist-card content? True when either card marker
 * is present: a "**Name** —" bold header or an [[expert:slug]] tag. Shared by
 * the response guards here and the Sentry turn reporter (empty-toolcalls
 * monitoring).
 */
export function hasTherapistCardContent(text: string): boolean {
  return /\*\*[^*\n]+\*\*\s*—/.test(text) || /\[\[expert:[^\]]+\]\]/.test(text);
}

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
export function shouldUseFallback(
  violations: HallucinationViolation[],
  toolCallCount: number,
  responseText?: string
): boolean {
  const unknownTherapists = violations.filter(
    (v) => v.kind === "unknown_therapist"
  ).length;
  if (unknownTherapists >= 1 && toolCallCount === 0) return true;
  if (unknownTherapists >= 2) return true;

  // Rule #5 — presenting therapist cards without having consulted the API
  // means the body of each card (fee, approaches, availability) is invented
  // even if the name itself happens to match a real therapist. This is the
  // exact failure mode we saw in Sentry NODE-2.
  if (toolCallCount === 0 && responseText) {
    const hasCard =
      /\*\*[^*\n]+\*\*\s*—/.test(responseText) ||
      /\[\[expert:[^\]]+\]\]/.test(responseText);
    if (hasCard) return true;
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
export async function verifyResponse(text: string): Promise<HallucinationViolation[]> {
  const hasHeaders = /\*\*[^*\n]+\*\*\s*—/.test(text);
  const hasTags = /\[\[expert:[^\]]+\]\]/.test(text);
  if (!hasHeaders && !hasTags) return [];

  const therapists = await getRoster();
  if (therapists.length === 0) return []; // API down → don't false-flag

  const usernames = new Set(therapists.map((t) => t.username).filter(Boolean));
  const violations: HallucinationViolation[] = [];

  // 1. Bold-header name check
  const headerPat = /\*\*([^*\n]+)\*\*\s*—/g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = headerPat.exec(text)) !== null) {
    const name = m[1].trim();
    if (seen.has(name)) continue;
    seen.add(name);
    // Filter out common non-name headers ("Ücret", "Görüşme", etc.)
    if (name.length < 4 || /^(ucret|ücret|görüşme|gorusme|konum|fiyat|not)$/i.test(name)) continue;
    if (!fuzzyMatchesAnyTherapist(name, therapists)) {
      violations.push({ kind: "unknown_therapist", value: name });
    }
  }

  // 2. Expert tag username check
  const tagPat = /\[\[expert:([^\]]+)\]\]/g;
  const seenTags = new Set<string>();
  while ((m = tagPat.exec(text)) !== null) {
    const username = m[1].trim();
    if (seenTags.has(username)) continue;
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
const TOPIC_SPECIALTY_MAP: Record<string, { userWords: string[]; specialtySubstr: string[] }> = {
  iliski:    { userWords: ["iliski", "evlilik", "partner", "esim", "cift", "bosanma", "ayrilik"], specialtySubstr: ["iliskisel"] },
  kaygi:     { userWords: ["kaygi", "anksiyete", "panik", "fobi", "korku"],                       specialtySubstr: ["kaygi", "anksiyete"] },
  depresyon: { userWords: ["depresyon", "mutsuz", "umutsuz"],                                     specialtySubstr: ["depresyon"] },
  travma:    { userWords: ["travma", "travmatik", "taciz", "istismar"],                           specialtySubstr: ["travmatik", "travma"] },
  // "yas" alone would false-match "yaşıyorum". Force explicit grief context.
  yas:       { userWords: ["yasta", "matem", "kayip", "vefat", "olum", "olen"],                   specialtySubstr: ["kayip", "yas"] },
  ergen:     { userWords: ["ergen", "cocuk", "cocugum"],                                          specialtySubstr: ["ergen", "cocuk", "akran"] },
  // "bagimli" (>= 5 chars, prefix) covers "bağımlıyım" / "bağımlılık".
  bagimlilik:{ userWords: ["bagimli", "alkol", "madde", "kumar", "sigara"],                       specialtySubstr: ["bagimlilik"] },
  iletisim:  { userWords: ["iletisim", "iletisemiyorum", "anlasamiyorum"],                        specialtySubstr: ["iletisim"] },
  ofke:      { userWords: ["ofke", "ofkeli", "sinirli", "saldirgan"],                             specialtySubstr: ["duygu yonetimi", "ofke"] },
  yeme:      { userWords: ["yeme", "anoreksi", "bulimi", "beden algisi"],                         specialtySubstr: ["yeme", "beden algisi"] },
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
function hasWordOrPrefix(normalized: string, keywords: string[]): boolean {
  const words = normalized.split(" ").filter(Boolean);
  return keywords.some((k) => {
    if (!k) return false;
    if (k.length < 5) return words.some((w) => w === k);
    return words.some((w) => w === k || w.startsWith(k));
  });
}

// ─── Typo tolerance (fallback layer) ─────────────────────────────────────────
//
// Prod incident: user typed "aksiyete" (missing 'n'). Exact/prefix matching
// found no topic, extractUserTopics returned [], and verifySpecialtyMatch
// bailed on its `topics.length === 0` fail-open guard — so the padding check
// never ran and an off-topic therapist card shipped to the user.
//
// Mobile users typo constantly, so keyword matching cannot be exact-only.
// The fallback below is deliberately narrow, because a FALSE topic prunes
// legitimate cards:
//   • runs ONLY when exact matching found nothing (last resort, never
//     widens an already-successful match)
//   • keywords shorter than 6 chars are excluded — "kaygi"/"saygi" and
//     "yas"/"yasadim" are 1 edit apart, exactly the false-match class the
//     word-boundary rules above were written to prevent
//   • the first character must match — typos rarely hit position 0, and
//     this alone rules out the "saygi" → "kaygi" family
//   • candidate length must sit within the edit budget of the keyword
//
// Residual risk is asymmetric in our favour: a false topic degrades to
// NO_MATCH_FALLBACK (we ask the user again), while the fail-open bug it
// replaces shipped a wrong recommendation.

const FUZZY_MIN_KEYWORD_LEN = 6;

/** Edit budget: 2 for long keywords, 1 for mid-length ones. */
function fuzzyBudget(len: number): number {
  return len >= 8 ? 2 : 1;
}

/** Levenshtein distance, two-row DP. Inputs here are single short words. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,                                  // deletion
        cur[j - 1] + 1,                               // insertion
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1) // substitution
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

function hasTypoMatch(normalized: string, keywords: string[]): boolean {
  const words = normalized.split(" ").filter(Boolean);
  return keywords.some((k) => {
    if (k.length < FUZZY_MIN_KEYWORD_LEN) return false;
    const budget = fuzzyBudget(k.length);
    return words.some(
      (w) =>
        w[0] === k[0] &&
        Math.abs(w.length - k.length) <= budget &&
        editDistance(w, k) <= budget
    );
  });
}

/**
 * Topic keys the user's message points at.
 *
 * Two passes: exact/prefix first (unchanged semantics), then a typo-tolerant
 * fallback that only runs when the first pass came up empty.
 *
 * Exported for unit tests — the typo path is the one that regressed in prod.
 */
export function extractUserTopics(userMessage: string): string[] {
  const n = normTR(userMessage);
  const topics: string[] = [];
  for (const [key, { userWords }] of Object.entries(TOPIC_SPECIALTY_MAP)) {
    if (hasWordOrPrefix(n, userWords)) topics.push(key);
  }
  if (topics.length > 0) return topics;

  for (const [key, { userWords }] of Object.entries(TOPIC_SPECIALTY_MAP)) {
    if (hasTypoMatch(n, userWords)) topics.push(key);
  }
  if (topics.length > 0) {
    console.warn(`[guard] topic matched via typo tolerance: ${topics.join(",")}`);
  }
  return topics;
}

function therapistCoversTopic(t: Therapist, topic: string): boolean {
  const rule = TOPIC_SPECIALTY_MAP[topic];
  if (!rule) return true; // unknown topic → don't flag
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
export async function verifySpecialtyMatch(
  userMessage: string,
  response: string
): Promise<HallucinationViolation[]> {
  const topics = extractUserTopics(userMessage);
  if (topics.length === 0) return []; // no topic inferred → can't evaluate

  const tagPat = /\[\[expert:([^\]]+)\]\]/g;
  const recommended = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = tagPat.exec(response)) !== null) {
    recommended.add(m[1].trim());
  }
  if (recommended.size === 0) return []; // no cards → nothing to validate

  const therapists = await getRoster();
  if (therapists.length === 0) return [];

  const violations: HallucinationViolation[] = [];
  for (const slug of recommended) {
    const t = therapists.find((x) => x.username === slug);
    if (!t) continue; // unknown_username already handled

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

// ─── Specialty-mismatch enforcement (Fix A) ──────────────────────────────────
//
// Previously verifySpecialtyMatch only annotated/logged. This section turns
// the verdict into action: cards whose therapist fails the topic check are
// removed from the response before the user sees them. If every card fails,
// the response is replaced with NO_MATCH_FALLBACK so we don't silently drop
// the turn.

/** Extract the therapist username slug from a violation .value string. */
export function extractMismatchedUsernames(
  violations: HallucinationViolation[]
): Set<string> {
  const set = new Set<string>();
  for (const v of violations) {
    if (v.kind !== "specialty_mismatch") continue;
    // value format: "<slug> (user topic: ...; therapist specialties: ...)"
    const slug = v.value.match(/^([^\s(]+)/)?.[1];
    if (slug) set.add(slug);
  }
  return set;
}

/**
 * Remove therapist cards whose username is in the mismatch set.
 *
 * A "card" is matched by regex as any block starting with a **Bold** — header
 * and ending with its [[expert:slug]] tag (plus trailing whitespace). Non-card
 * prose between cards (intro / outro / separators) is preserved verbatim.
 */
export function pruneMismatchedCards(
  text: string,
  mismatchedUsernames: Set<string>
): { response: string; removedCount: number; keptCount: number } {
  if (mismatchedUsernames.size === 0) {
    return { response: text, removedCount: 0, keptCount: 0 };
  }
  const cardPat = /\*\*[^*\n]+\*\*\s*—[\s\S]*?\[\[expert:([^\]]+)\]\]\s*/g;
  let removed = 0;
  let kept = 0;
  const result = text.replace(cardPat, (match, slug: string) => {
    if (mismatchedUsernames.has(slug)) {
      removed++;
      return "";
    }
    kept++;
    return match;
  });
  return { response: result, removedCount: removed, keptCount: kept };
}

// ─── Prose repair after pruning ──────────────────────────────────────────────
//
// pruneMismatchedCards only touches card blocks. The intro the prompt demands
// above them ("… 3 ismi seçiyorum:", "İlk önerim Ayşenur …") is model prose
// and kept naming the pruned therapist — prod, 2026-09-01: the user saw
// "İlk önerim Ayşenur Coşkun Toker" over two cards for other people, and
// "3 ismi" over two cards. This pass makes the prose agree with the cards:
//   1. every sentence naming a pruned therapist is dropped,
//   2. a card-count phrase that counted the original cards is rewritten to
//      the surviving count (the "12 terapiste baktım" search-size count is
//      left alone — it never equalled the card count),
//   3. if no "ilk önerim" sentence survives, one is rebuilt for the first
//      surviving card from specialties[] / branches[] — never from the model.

export interface ScrubPrunedProseInput {
  pruned: Therapist[];
  kept: Therapist[];
  removedCount: number;
  keptCount: number;
  req: UserRequest;
}

const CARD_BLOCK_PAT = /\*\*[^*\n]+\*\*\s*—[\s\S]*?\[\[expert:[^\]]+\]\]\s*/g;

const COUNT_WORDS: Record<string, number> = { bir: 1, iki: 2, uc: 3, dort: 4, bes: 5 };

/** "3 ismi seçiyorum", "üç terapist öneriyorum" → the number and the phrase. */
const CARD_COUNT_PAT =
  /(\d+|bir|iki|üç|uc|dört|dort|beş|bes)(\s+(?:ismi|isim|isimi|terapist\w*|uzman\w*|psikolog\w*|kişi\w*|kisi\w*|öneri\w*|oneri\w*|seçenek\w*|secenek\w*)[^.!?\n;:\d]{0,60}?\s(?:öner|oner|seç|sec|sun|paylaş|paylas|göster|goster|getir|listel|buldum|seçtim|sectim))/giu;

function therapistFirstName(t: Therapist): string {
  const first = t.name?.trim() || (t.full_name ?? "").trim().split(/\s+/)[0] || "";
  return normTR(first);
}

function therapistFullName(t: Therapist): string {
  return t.full_name?.trim() || [t.name, t.surname].filter(Boolean).join(" ");
}

function sentenceNamesTherapist(
  normSentence: string,
  t: Therapist,
  keptFirstNames: Set<string>
): boolean {
  const full = normTR(therapistFullName(t));
  if (full && normSentence.includes(full)) return true;
  const first = therapistFirstName(t);
  if (first.length < 3 || keptFirstNames.has(first)) return false;
  return normSentence.split(" ").includes(first);
}

/** The data-derived replacement for a dropped "İlk önerim …" sentence. */
function buildFirstPickSentence(t: Therapist, req: UserRequest): string {
  const name = therapistFullName(t);
  const reasons: string[] = [];
  const matched = matchedSpecialtyNames(t, req.topics);
  if (matched.length > 0) reasons.push(`${matched.slice(0, 2).join(" ve ")} alanında çalışıyor`);
  const physical = (t.branches ?? []).filter((b) => b?.type === "physical");
  const hasOnline = (t.branches ?? []).some((b) => b?.type === "online");
  if (req.prefersOnline === false || req.city) {
    const branch = req.city
      ? physical.find((b) => b.city?.name && normTR(b.city.name) === normTR(req.city ?? ""))
      : physical[0];
    if (branch?.name) reasons.push(`${branch.name} şubesinde yüz yüze görüşüyor`);
    else if (hasOnline) reasons.push("online görüşüyor");
  } else if (hasOnline) {
    reasons.push("online görüşüyor");
  }
  return reasons.length > 0
    ? `İlk önerim ${name}; ${reasons.join(" ve ")}.`
    : `İlk önerim ${name}.`;
}

export function scrubPrunedProse(text: string, input: ScrubPrunedProseInput): string {
  const { pruned, kept, removedCount, keptCount, req } = input;
  if (pruned.length === 0 || keptCount === 0) return text;

  const keptFirstNames = new Set(kept.map(therapistFirstName));
  const originalCount = removedCount + keptCount;
  let firstPickSurvives = false;

  const scrubProse = (prose: string): string => {
    // 1. Drop sentences naming a pruned therapist. Sentences end at . ! ?
    //    or a line break, so a "**Name**" header is never inside one.
    let out = prose.replace(/[^.!?\n]+[.!?]*/g, (sentence) => {
      const norm = normTR(sentence);
      if (pruned.some((t) => sentenceNamesTherapist(norm, t, keptFirstNames))) return "";
      // normTR: /i flag doesn't fold Turkish İ, and \b ignores ö.
      if (norm.includes("ilk oner")) firstPickSurvives = true;
      return sentence;
    });
    // 2. Rewrite the card count — only a number that counted the original
    //    cards, so the search-size count ("12 terapiste baktım") stays.
    out = out.replace(CARD_COUNT_PAT, (m, num: string, rest: string) => {
      const n = /^\d+$/.test(num) ? parseInt(num, 10) : COUNT_WORDS[normTR(num)];
      return n === originalCount ? `${keptCount}${rest}` : m;
    });
    // Collapse the whitespace the dropped sentences left behind.
    return out
      .replace(/[ \t]+\n/g, "\n")
      .replace(/^[ \t]+/gm, "")
      .replace(/\n{3,}/g, "\n\n");
  };

  // Walk prose segments between cards; cards pass through untouched.
  const cards = [...text.matchAll(CARD_BLOCK_PAT)];
  let result = "";
  let cursor = 0;
  for (const card of cards) {
    result += scrubProse(text.slice(cursor, card.index));
    result += card[0];
    cursor = card.index + card[0].length;
  }
  result += scrubProse(text.slice(cursor));

  // 3. Rebuild the first-pick sentence above the first surviving card.
  if (!firstPickSurvives && cards.length > 0) {
    const firstCard = result.match(CARD_BLOCK_PAT)?.[0];
    const firstSlug = firstCard?.match(/\[\[expert:([^\]]+)\]\]/)?.[1];
    // Only the therapist of the first card may be called the first pick —
    // an unresolvable slug means no sentence, never a guess.
    const first = kept.find((t) => t.username === firstSlug);
    const idx = firstCard ? result.indexOf(firstCard) : -1;
    if (first && idx >= 0) {
      const intro = result.slice(0, idx).trimEnd();
      const sentence = buildFirstPickSentence(first, req);
      result = (intro ? `${intro}\n\n` : "") + `${sentence}\n\n` + result.slice(idx);
    }
  }
  return result;
}

/**
 * Prune off-topic cards AND repair the prose around them. This is what the
 * response guard calls; pruneMismatchedCards stays exported for callers that
 * only need the card surgery.
 */
export async function pruneMismatchedResponse(
  text: string,
  mismatchedUsernames: Set<string>,
  flowUserText: string
): Promise<{ response: string; removedCount: number; keptCount: number }> {
  const pruned = pruneMismatchedCards(text, mismatchedUsernames);
  if (pruned.removedCount === 0 || pruned.keptCount === 0) return pruned;

  const roster = await getRoster();
  const bySlug = new Map(roster.filter((t) => t.username).map((t) => [t.username as string, t]));
  const prunedTherapists = [...mismatchedUsernames]
    .map((slug) => bySlug.get(slug))
    .filter((t): t is Therapist => Boolean(t));
  const keptTherapists = [...pruned.response.matchAll(/\[\[expert:([^\]]+)\]\]/g)]
    .map((m) => bySlug.get(m[1]))
    .filter((t): t is Therapist => Boolean(t));
  if (prunedTherapists.length === 0) return pruned;

  return {
    ...pruned,
    response: scrubPrunedProse(pruned.response, {
      pruned: prunedTherapists,
      kept: keptTherapists,
      removedCount: pruned.removedCount,
      keptCount: pruned.keptCount,
      req: extractUserRequest(flowUserText),
    }),
  };
}

// ─── Intro topic drift ───────────────────────────────────────────────────────
//
// The prompt asks for a "how I searched" sentence above the cards. The model
// (gpt-4.1-mini) copies the prompt's worked example — "Kaygı alanında çalışan
// 12 terapiste baktım…" — and keeps its topic: prod, 2026-09-02, user said
// "İlişkimde sorun yaşıyorum", every card was İlişkisel, and the intro read
// "Kaygı tarafında çalışan … terapistlere baktım". The cards are grounded;
// only that one sentence lies about the search. When it names a topic the
// user never raised, it is rebuilt from the user's own answers (topic,
// modality, city) and the number of cards actually shown. The first-pick
// sentence and the cards are never touched.

/** Display label per topic key, for the rebuilt search sentence. */
const TOPIC_DISPLAY: Record<string, string> = {
  iliski: "İlişkisel problemler",
  kaygi: "Kaygı",
  depresyon: "Depresyon",
  travma: "Travma",
  yas: "Kayıp ve yas",
  ergen: "Çocuk ve ergen",
  bagimlilik: "Bağımlılık",
  iletisim: "İletişim problemleri",
  ofke: "Duygu yönetimi",
  yeme: "Yeme problemleri ve beden algısı",
};

/** Locative suffix — vowel harmony and consonant hardening for known cities. */
function cityLocative(city: string): string {
  const table: Record<string, string> = {
    istanbul: "İstanbul’da", ankara: "Ankara’da", izmir: "İzmir’de", bursa: "Bursa’da",
    antalya: "Antalya’da", adana: "Adana’da", konya: "Konya’da", gaziantep: "Gaziantep’te",
    kayseri: "Kayseri’de", eskisehir: "Eskişehir’de", samsun: "Samsun’da", mersin: "Mersin’de",
    kocaeli: "Kocaeli’nde",
  };
  return table[normTR(city)] ?? `${city}’da`;
}

/** The search sentence is the one that says what was looked at — not the first pick. */
const SEARCH_VERB_PAT = /\b(bakt|arad|incel|tarad|listele|sect|seciyorum|oneriyorum|one cikar|buldum)/;

function sentenceHasTopicDrift(normSentence: string, userTopics: string[]): string | null {
  for (const [key, rule] of Object.entries(TOPIC_SPECIALTY_MAP)) {
    if (userTopics.includes(key)) continue;
    // userWords only: specialtySubstr has short tokens like "yas" that
    // whole-word-match "yaş aralığına" — the grief false-match class.
    if (hasWordOrPrefix(normSentence, rule.userWords)) return key;
  }
  return null;
}

export function buildSearchSentence(req: UserRequest, cardCount: number): string {
  const topics = req.topics.map((k) => TOPIC_DISPLAY[k]).filter(Boolean);
  const topicPart = topics.length > 0 ? `${topics.join(" ve ")} alanında çalışan` : "Sana uygun";
  let modality = "";
  if (req.city) {
    modality = req.prefersOnline === true
      ? ` ve ${cityLocative(req.city)} online görüşen`
      : ` ve ${cityLocative(req.city)} yüz yüze görüşen`;
  } else if (req.prefersOnline === true) {
    modality = " ve online görüşen";
  } else if (req.prefersOnline === false) {
    modality = " ve yüz yüze görüşen";
  }
  return `${topicPart}${modality} terapistlere baktım; sana en uygun görünen ${cardCount} ismi seçiyorum:`;
}

export function repairIntroTopicDrift(
  text: string,
  flowUserText: string
): { response: string; drifted: boolean; driftTopic?: string } {
  const req = extractUserRequest(flowUserText);
  if (req.topics.length === 0) return { response: text, drifted: false };
  const cards = [...text.matchAll(CARD_BLOCK_PAT)];
  if (cards.length === 0) return { response: text, drifted: false };
  const introEnd = cards[0].index ?? 0;
  const intro = text.slice(0, introEnd);

  let driftTopic: string | undefined;
  const repaired = intro.replace(/[^.!?:\n]+[.!?:]*/g, (sentence) => {
    if (driftTopic) return sentence;
    const norm = normTR(sentence);
    if (norm.includes("ilk oner")) return sentence;       // first pick is grounded
    if (!SEARCH_VERB_PAT.test(norm)) return sentence;      // not the search sentence
    const drift = sentenceHasTopicDrift(norm, req.topics);
    if (!drift) return sentence;
    driftTopic = drift;
    return buildSearchSentence(req, cards.length);
  });
  if (!driftTopic) return { response: text, drifted: false };
  return { response: repaired + text.slice(introEnd), drifted: true, driftTopic };
}

// ─── Structured "Eşleşme" block (Fix D) ──────────────────────────────────────
//
// Replaces the LLM-written "Neden uygun: ..." narrative with a data-derived
// block that shows ✓ / ✗ / — against each criterion the user actually asked
// about. This removes the surface where the model previously fabricated
// credentials ("BDT eğitimi mevcut", "8 yıl deneyimli", etc.) because the
// match block is built from therapist object fields, not model text.

export interface UserRequest {
  topics: string[];
  city: string | null;
  maxFee: number | null;
  approach: string | null;
  prefersOnline: boolean | null;
}

// Canonical approach labels — each has a set of user-side keywords (normalized
// Turkish) and a substring to match against therapist.approaches[].name.
const APPROACH_KEYWORDS: Array<{
  canonical: string;
  userKeys: string[];
  therapistSubstr: string[];
}> = [
  { canonical: "BDT / Bilişsel Davranışçı Terapi", userKeys: ["bdt", "cbt", "bilissel"], therapistSubstr: ["bilissel", "bilisel", "bdt", "cbt"] },
  { canonical: "EMDR", userKeys: ["emdr"], therapistSubstr: ["emdr"] },
  { canonical: "ACT", userKeys: ["act", "kabul ve kararlilik"], therapistSubstr: ["act", "kabul"] },
  { canonical: "DBT", userKeys: ["dbt", "dialektik"], therapistSubstr: ["dbt", "dialektik"] },
  { canonical: "Şema Terapisi", userKeys: ["sema", "schema"], therapistSubstr: ["sema", "schema"] },
  { canonical: "Gestalt", userKeys: ["gestalt"], therapistSubstr: ["gestalt"] },
  { canonical: "Psikanaliz", userKeys: ["psikanaliz", "psikodinamik"], therapistSubstr: ["psikanaliz", "psikodinamik"] },
  { canonical: "Mindfulness", userKeys: ["mindfulness"], therapistSubstr: ["mindfulness", "farkindalik"] },
];

// Cities with active Planda presence — used to pull the user's city out of
// their message. Capital letters preserved for display, matching uses normTR.
const KNOWN_CITIES_DISPLAY: Record<string, string> = {
  istanbul: "İstanbul",
  ankara: "Ankara",
  izmir: "İzmir",
  bursa: "Bursa",
  antalya: "Antalya",
  adana: "Adana",
  konya: "Konya",
  gaziantep: "Gaziantep",
  kayseri: "Kayseri",
  eskisehir: "Eskişehir",
  samsun: "Samsun",
  mersin: "Mersin",
  kocaeli: "Kocaeli",
};

/** How many trailing user turns feed the guard context. */
const FLOW_TEXT_MAX_USER_TURNS = 10;

/**
 * User-request context for the guards and card rewriter: the session's
 * recent user turns joined with the message of this turn.
 *
 * Motivation (prod, ladder flow): the user gives the topic ("aksiyetem
 * var"), modality and city over four turns. Passing only the final turn
 * ("istanbul") to extractUserRequest left topics empty — so the Uzmanlık
 * line never surfaced the anxiety specialty, the Eşleşme block had no
 * "✓ Uzmanlık" row, and specialty-mismatch pruning was silently disabled
 * for exactly the multi-turn flow the prompt now steers users into.
 *
 * Deliberately NOT scoped to "since the last card-bearing reply": the
 * loop-breaker lets cards appear mid-ladder (e.g. right after the topic
 * answer), which would put the topic before the boundary and lose it
 * again. Including every recent user turn fails SOFT instead — a topic
 * from an earlier search widens the accepted-specialty set rather than
 * disabling the check — and the 30-minute session TTL plus the reset
 * endpoint bound how stale that context can get.
 */
export function buildFlowUserText(history: ChatMessage[], message: string): string {
  const turns = history
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .slice(-FLOW_TEXT_MAX_USER_TURNS);
  return [...turns, message].join("\n");
}

/** Pull structured request attributes out of a free-form user message. */
export function extractUserRequest(userMessage: string): UserRequest {
  const n = normTR(userMessage);
  const topics = extractUserTopics(userMessage);

  // City — first known city that appears in the normalized message
  let city: string | null = null;
  for (const [key, display] of Object.entries(KNOWN_CITIES_DISPLAY)) {
    if (n.includes(key)) { city = display; break; }
  }

  // Budget — "X TL altı", "bütçem X", "X TL", but bound to reasonable range.
  // Two-pass: explicit budget phrasing first, then standalone fee number.
  let maxFee: number | null = null;
  const budgetMatch =
    n.match(/b(?:u|ue)tce(?:m)?\s*(\d{3,6})/) ||
    n.match(/(\d{3,6})\s*tl\s*(?:alti|alta|altinda|altın)/);
  if (budgetMatch) {
    const v = parseInt(budgetMatch[1], 10);
    if (v >= 500 && v <= 20000) maxFee = v;
  }

  // Approach — first canonical match wins
  let approach: string | null = null;
  for (const a of APPROACH_KEYWORDS) {
    if (a.userKeys.some((k) => n.includes(k))) { approach = a.canonical; break; }
  }

  // Online vs. physical preference
  let prefersOnline: boolean | null = null;
  if (/\bonline\b/.test(n)) prefersOnline = true;
  else if (/\byuz\s*yuze\b|\byuzyuze\b/.test(n)) prefersOnline = false;

  return { topics, city, maxFee, approach, prefersOnline };
}

/** Resolve user topics to the specialty names that cover them for this therapist. */
function matchedSpecialtyNames(t: Therapist, topics: string[]): string[] {
  const names = (t.specialties ?? []).map((s) => s?.name ?? "").filter(Boolean);
  const out = new Set<string>();
  for (const topic of topics) {
    const rule = TOPIC_SPECIALTY_MAP[topic];
    if (!rule) continue;
    for (const name of names) {
      const n = normTR(name);
      if (rule.specialtySubstr.some((sub) => n.includes(sub))) out.add(name);
    }
  }
  return [...out];
}

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
export function buildMatchBlock(t: Therapist, req: UserRequest): string {
  const lines: string[] = [];

  // Uzmanlık
  if (req.topics.length > 0) {
    const matched = matchedSpecialtyNames(t, req.topics);
    if (matched.length > 0) {
      lines.push(`✓ Uzmanlık: ${matched.join(", ")}`);
    }
    // Note: a ✗ on specialty would be pruned by Fix A before reaching here,
    // so we only render the positive case.
  }

  // Şehir / görüşme tipi
  if (req.city) {
    const reqCityNorm = normTR(req.city);
    const physical = (t.branches ?? []).filter((b) => b.type === "physical");
    const cityBranch = physical.find(
      (b) => b.city?.name && normTR(b.city.name) === reqCityNorm
    );
    if (cityBranch) {
      const label = [cityBranch.city?.name, cityBranch.name]
        .filter(Boolean)
        .join(" — ");
      lines.push(`✓ Şehir: ${label}`);
    } else {
      const hasOnline = (t.branches ?? []).some((b) => b.type === "online");
      if (hasOnline) {
        lines.push(`— Şehir: ${req.city}'da şube yok, online görüşme mümkün`);
      } else {
        lines.push(`✗ Şehir: ${req.city}'da şube yok`);
      }
    }
  } else if (req.prefersOnline === true) {
    const hasOnline = (t.branches ?? []).some((b) => b.type === "online");
    lines.push(hasOnline ? `✓ Görüşme: Online` : `✗ Görüşme: Online seçenek yok`);
  }

  // Bütçe
  if (req.maxFee !== null) {
    const fees = (t.services ?? [])
      .map((s) => {
        const raw = s.custom_fee ?? s.fee;
        if (!raw) return null;
        const f = parseFloat(raw);
        return Number.isFinite(f) ? Math.round(f) : null;
      })
      .filter((n): n is number => n !== null);
    if (fees.length > 0) {
      const minFee = Math.min(...fees);
      const tl = (n: number) => n.toLocaleString("tr-TR");
      const ok = minFee <= req.maxFee;
      lines.push(
        `${ok ? "✓" : "✗"} Bütçe: ${tl(minFee)} TL` +
        ` (talebin: ${tl(req.maxFee)} TL altı)`
      );
    }
  }

  // Yaklaşım — only reliable if get_therapist has populated approaches[]
  if (req.approach) {
    const rule = APPROACH_KEYWORDS.find((a) => a.canonical === req.approach);
    const approachNames = (t.approaches ?? [])
      .map((a) => a?.name ?? "")
      .filter(Boolean);
    if (approachNames.length === 0) {
      lines.push(`— Yaklaşım (${req.approach}): profil detayından doğrulanabilir`);
    } else if (rule) {
      const hasIt = approachNames.some((name) => {
        const n = normTR(name);
        return rule.therapistSubstr.some((sub) => n.includes(sub));
      });
      lines.push(
        hasIt
          ? `✓ Yaklaşım: ${req.approach} (onaylandı)`
          : `✗ Yaklaşım: ${req.approach} profilde görünmüyor`
      );
    }
  }

  if (lines.length === 0) return "";
  return `Eşleşme:\n${lines.join("\n")}`;
}

/**
 * Build the "Uzmanlık:" line from therapist.specialties[] ONLY.
 *
 * The model sometimes conflates specialties[] (what the therapist is
 * specialized in) with services[] (what session types they sell, e.g.
 * "Çift ve Evlilik Terapisi", "Aile Danışmanlığı"). To the user, this
 * looks like the therapist is credentialed in a field they're not.
 * Rewriting the line from specialties[] only eliminates the confusion.
 */
export function buildSpecialtyLine(t: Therapist, userTopics: string[]): string {
  const all = (t.specialties ?? [])
    .map((s) => s?.name?.trim())
    .filter((n): n is string => Boolean(n));
  if (all.length === 0) return "";
  const matched = userTopics.length > 0 ? matchedSpecialtyNames(t, userTopics) : [];
  const rest = all.filter((n) => !matched.includes(n));
  // Surface user-relevant specialties first; cap at 4 for readability.
  const display = [...matched, ...rest].slice(0, 4);
  return `Uzmanlık: ${display.join(", ")}`;
}

/**
 * Build the "Görüşme:" line from branches[] ONLY — never from address strings.
 *
 * Addresses are free-text and sometimes contain confusing district layers
 * (e.g. "Dikilitaş Mahallesi ... Beşiktaş Şişli"). The model used to parse
 * these and produce "Yüz yüze (Beşiktaş, Şişli)" — user sees two districts
 * for one branch. Using branches[].name (the canonical short label) plus
 * type markers keeps the card factual.
 */
export function buildLocationLine(t: Therapist): string {
  const physical = (t.branches ?? []).filter((b) => b?.type === "physical");
  const hasOnline = (t.branches ?? []).some((b) => b?.type === "online");
  const physLabels: string[] = [];
  for (const b of physical) {
    const name = (b?.name || "").trim();
    if (name) physLabels.push(name);
  }
  const parts: string[] = [];
  if (hasOnline) parts.push("Online");
  if (physLabels.length > 0) parts.push(`Yüz yüze (${physLabels.join(" / ")})`);
  if (parts.length === 0) return "";
  return `Görüşme: ${parts.join(" / ")}`;
}

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
export async function injectStructuredMatchBlocks(
  text: string,
  userMessage: string
): Promise<string> {
  if (!/\[\[expert:[^\]]+\]\]/.test(text)) return text;

  const req = extractUserRequest(userMessage);
  const hasCriteria =
    req.topics.length > 0 ||
    req.city !== null ||
    req.maxFee !== null ||
    req.approach !== null ||
    req.prefersOnline !== null;

  const therapists = await getRoster();
  if (therapists.length === 0) return text;
  const byUsername = new Map<string, Therapist>();
  for (const t of therapists) {
    if (t.username) byUsername.set(t.username, t);
  }

  // Operate on whole-card blocks so Uzmanlık/Görüşme rewrites stay scoped to
  // the correct therapist. Pattern matches from a **Bold** — header through
  // the trailing [[expert:slug]] tag.
  const cardPat = /(\*\*[^*\n]+\*\*\s*—[\s\S]*?)(\[\[expert:([^\]]+)\]\])/g;

  return text.replace(cardPat, (_m, body: string, tag: string, slug: string) => {
    const t = byUsername.get(slug);
    if (!t) return body + tag;

    // 1. Strip free-form narrative lines
    let rewritten = body
      .replace(/^[ \t]*Neden uygun:[^\n]*\n?/gim, "")
      .replace(/^[ \t]*Yaklaşım:[^\n]*\n?/gim, "");

    // 2. Rewrite Uzmanlık from specialties[] only (if line exists)
    const specLine = buildSpecialtyLine(t, req.topics);
    if (specLine && /^[ \t]*Uzmanlık:/m.test(rewritten)) {
      rewritten = rewritten.replace(/^[ \t]*Uzmanlık:[^\n]*$/m, specLine);
    }

    // 3. Rewrite Görüşme from branches[] only (if line exists)
    const locLine = buildLocationLine(t);
    if (locLine && /^[ \t]*Görüşme:/m.test(rewritten)) {
      rewritten = rewritten.replace(/^[ \t]*Görüşme:[^\n]*$/m, locLine);
    }

    // 4. Inject Eşleşme block (only when user had checkable criteria)
    if (hasCriteria) {
      const block = buildMatchBlock(t, req);
      if (block) {
        return rewritten + block + "\n" + tag;
      }
    }
    return rewritten + tag;
  });
}
