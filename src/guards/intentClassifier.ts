/**
 * Lightweight intent classifier — keyword-based, zero latency.
 *
 * Used to annotate conversation logs and detect "tool call expected but missing"
 * regressions (e.g. therapist search intent without find_therapists call).
 */

const NORMALIZE = (s: string): string =>
  s.toLowerCase()
    .replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u")
    .replace(/ö/g, "o").replace(/ı/g, "i").replace(/ç/g, "c")
    .replace(/İ/g, "i").replace(/I/g, "i");

export type Intent =
  | "search_therapist"      // ilk arama / öneri isteği
  | "check_availability"    // müsaitlik / randevu / uygun saat
  | "therapist_detail"      // belirli terapist hakkında detay
  | "list_specialties"      // uzmanlık alanları
  | "greeting"              // selam, merhaba
  | "out_of_scope"          // konu dışı
  | "clarification"         // evet/hayır/emin misin
  | "unknown";

export interface IntentResult {
  intent: Intent;
  expectedTools: string[];
  matched: string[];
}

const SEARCH_KEYS = [
  "terapist", "psikolog", "psikiyatr", "uzman", "danisman", "therapist",
  "ariyorum", "oneri", "onerir", "bul", "yardim", "destek ariyorum",
  "anksiyete", "kaygi", "depresyon", "panik", "travma", "stres", "burnout",
  "iliski", "evlilik", "cift", "ergen", "cocuk", "aile",
  "online terapi", "yuz yuze", "seans",
];

const AVAIL_KEYS = [
  "musait", "musaitlik", "uygun", "saat", "gun", "tarih", "randevu",
  "hafta", "yarin", "pazartesi", "sali", "carsamba", "persembe", "cuma",
  "cumartesi", "pazar", "hangi gun", "ne zaman",
];

const DETAIL_KEYS = [
  "bdt", "emdr", "act", "schema", "sema", "bilissel", "davranisci",
  "yaklasim", "yontem", "hakkinda", "profil", "deneyim", "egitim",
];

const SPECIALTY_KEYS = [
  "uzmanlik alanlari", "hangi konular", "ne tur terapi", "specialties",
];

const GREETING_KEYS = [
  "merhaba", "selam", "hey", "hi", "hello", "iyi gunler", "gunaydin", "iyi aksamlar",
];

const CLARIFY_KEYS = [
  "emin misin", "dogru mu", "gercek mi", "hala musait", "bu dogru",
  "evet", "hayir", "tamam", "peki",
];

function hasAny(haystack: string, keys: string[]): string[] {
  return keys.filter((k) => haystack.includes(k));
}

export function classifyIntent(message: string): IntentResult {
  const n = NORMALIZE(message.trim());
  if (!n) return { intent: "unknown", expectedTools: [], matched: [] };

  const availMatches = hasAny(n, AVAIL_KEYS);
  if (availMatches.length) {
    return {
      intent: "check_availability",
      expectedTools: ["get_therapist_available_days", "get_therapist_hours"],
      matched: availMatches,
    };
  }

  const specialtyMatches = hasAny(n, SPECIALTY_KEYS);
  if (specialtyMatches.length) {
    return {
      intent: "list_specialties",
      expectedTools: ["list_specialties"],
      matched: specialtyMatches,
    };
  }

  // Search vs. detail: if both search+detail keywords present, it's a filtered
  // search ("BDT yapan terapist istiyorum"), not a detail lookup.
  const searchMatches = hasAny(n, SEARCH_KEYS);
  const detailMatches = hasAny(n, DETAIL_KEYS);

  // "Specific enough to search": must contain at least one of
  // specialty / city / approach / service qualifier. Otherwise it's a vague
  // request like "terapi arıyorum" / "kendim için psikolog arıyorum" where
  // the correct behavior is to ask a clarifying question, not call tools.
  const SPECIFICITY_KEYS = [
    "anksiyete", "kaygi", "depresyon", "panik", "travma", "stres", "burnout",
    "iliski", "evlilik", "cift", "ergen", "cocuk", "aile",
    "istanbul", "ankara", "izmir", "bursa", "antalya",
    "online", "yuz yuze",
  ];
  const specificity = hasAny(n, [...SPECIFICITY_KEYS, ...DETAIL_KEYS]);
  const hasEnoughInfo = specificity.length > 0;

  if (searchMatches.length && detailMatches.length) {
    return {
      intent: "search_therapist",
      expectedTools: ["find_therapists", "get_therapist"],
      matched: [...searchMatches, ...detailMatches],
    };
  }

  if (detailMatches.length) {
    return {
      intent: "therapist_detail",
      expectedTools: ["get_therapist"],
      matched: detailMatches,
    };
  }

  if (searchMatches.length) {
    return {
      intent: "search_therapist",
      // Vague searches expect a clarifying question, not a tool call
      expectedTools: hasEnoughInfo ? ["find_therapists"] : [],
      matched: searchMatches,
    };
  }

  const clarify = hasAny(n, CLARIFY_KEYS);
  if (clarify.length) {
    return { intent: "clarification", expectedTools: [], matched: clarify };
  }

  const greet = hasAny(n, GREETING_KEYS);
  if (greet.length && n.length < 30) {
    return { intent: "greeting", expectedTools: [], matched: greet };
  }

  // Out-of-scope heuristic: coding, law, recipes, etc.
  const oosKeys = ["kod yaz", "recete", "tarif", "hukuk", "borsa", "python", "javascript"];
  const oos = hasAny(n, oosKeys);
  if (oos.length) return { intent: "out_of_scope", expectedTools: [], matched: oos };

  return { intent: "unknown", expectedTools: [], matched: [] };
}

/**
 * Returns violations when expected tools were not called.
 *
 * Ignores the mismatch when the assistant responded with a clarifying question
 * (ends with "?" or contains a common Turkish clarifier) — asking for more info
 * before searching is a legitimate flow per the system prompt.
 */
export function detectIntentToolMismatch(
  intent: IntentResult,
  actualToolCalls: string[],
  response?: string
): string[] {
  if (intent.expectedTools.length === 0) return [];
  const called = new Set(actualToolCalls);
  const missing = intent.expectedTools.filter((t) => !called.has(t));
  if (missing.length < intent.expectedTools.length) return [];

  // Clarification heuristic — response asks a question before searching
  if (response) {
    const trimmed = response.trim();
    const lastChar = trimmed.slice(-1);
    const lower = trimmed.toLowerCase();
    const clarifierPhrases = [
      "paylaşabilir misin", "paylasabilir misin",
      "söyleyebilir misin", "soyleyebilir misin",
      "hangi konu", "hangi şehir", "hangi sehir",
      "kimin için", "kimin icin",
      "ne tür", "ne tur",
      "kaç yaş", "kac yas",
      "online mi", "yüz yüze mi", "yuz yuze mi",
    ];
    if (lastChar === "?" || clarifierPhrases.some((p) => lower.includes(p))) {
      return [];
    }
  }

  return [`expected one of [${intent.expectedTools.join(", ")}] but got [${actualToolCalls.join(", ") || "none"}]`];
}
