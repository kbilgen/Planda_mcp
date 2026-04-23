/**
 * Hallucination guard — verifies every therapist name / username in a response
 * corresponds to a real therapist from the Planda API.
 *
 * Operates in ANNOTATE mode: never mutates the response, only returns
 * violations. Callers log them; future work can add a retry loop.
 */

import { findTherapists } from "../services/therapistApi.js";
import type { Therapist } from "../types.js";

export interface HallucinationViolation {
  kind: "unknown_therapist" | "unknown_username";
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
  return s.toLowerCase()
    .replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u")
    .replace(/ö/g, "o").replace(/ı/g, "i").replace(/ç/g, "c")
    .replace(/İ/g, "i").replace(/I/g, "i")
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
