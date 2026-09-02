/**
 * Therapist list filter helpers — applied server-side inside tool handlers
 * so the model's filter intent becomes an authoritative contract instead
 * of a post-hoc AI-side cleanup.
 *
 * All helpers are pure, Turkish-aware, and bound-safe on empty inputs.
 */

import type { Therapist } from "../types.js";

/** Lower-case + strip Turkish diacritics + trim to ASCII alnum + spaces. */
function normTR(s: string): string {
  return s
    // Turkish uppercase İ (U+0130) → "i" BEFORE default toLowerCase,
    // because JS toLowerCase on İ yields "i̇" (combining dot) which
    // later gets stripped to "i " (space) breaking match.
    .replace(/İ/g, "i")
    .replace(/I/g, "i")
    .toLowerCase()
    .replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u")
    .replace(/ö/g, "o").replace(/ı/g, "i").replace(/ç/g, "c")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Therapist has at least one online branch. */
export function matchesOnline(t: Therapist): boolean {
  return (t.branches ?? []).some((b) => b.type === "online");
}

/** Therapist has at least one physical branch (optionally in a specific city). */
export function matchesPhysical(t: Therapist, city?: string): boolean {
  const branches = (t.branches ?? []).filter((b) => b.type === "physical");
  if (!branches.length) return false;
  if (!city) return true;
  const target = normTR(city);
  return branches.some((b) => b.city?.name && normTR(b.city.name) === target);
}

/** Therapist's lowest priced service is <= maxFee (TL). */
export function matchesMaxFee(t: Therapist, maxFee: number): boolean {
  const fees = (t.services ?? [])
    .map((s) => {
      const raw = s.custom_fee ?? s.fee;
      if (!raw) return null;
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : null;
    })
    .filter((n): n is number => n !== null);
  if (!fees.length) return false;
  return Math.min(...fees) <= maxFee;
}

/** Therapist's top-level or data.gender equals the requested gender. */
export function matchesGender(t: Therapist, gender: "female" | "male"): boolean {
  const g = t.gender ?? t.data?.gender;
  return g === gender;
}

/** Parse an age field that may arrive as number, numeric string, or null. */
function parseAge(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Therapist accepts a client of the given age.
 *   - accept_all_ages === true                     → always matches
 *   - otherwise within [min_client_age, max_client_age] (open-ended if a
 *     bound is missing)
 *   - no age data at all                           → treated as accepting
 *     (we don't exclude a therapist for a field they never filled in)
 */
export function matchesAge(t: Therapist, age: number): boolean {
  const other = t.data?.other;
  if (!other) return true;
  if (other.accept_all_ages) return true;
  const min = parseAge(other.min_client_age);
  const max = parseAge(other.max_client_age);
  if (min === null && max === null) return true;
  if (min !== null && age < min) return false;
  if (max !== null && age > max) return false;
  return true;
}

/**
 * Fuzzy name match — returns therapists whose full_name / name+surname /
 * username contains all query words (normalized, Turkish-insensitive).
 *
 *   filterByFuzzyName(list, "Ekin Alankuş")     → matches "Ekin Alankuş"
 *   filterByFuzzyName(list, "ayse demir")       → matches "Ayşe Demir"
 *   filterByFuzzyName(list, "ekin alankus")     → same
 *   filterByFuzzyName(list, "alankus")          → any with "alankus" in name
 */
export function filterByFuzzyName(list: Therapist[], query: string): Therapist[] {
  const words = normTR(query).split(" ").filter((w) => w.length >= 2);
  if (!words.length) return list;
  return list.filter((t) => {
    const full = t.full_name?.trim() || [t.name, t.surname].filter(Boolean).join(" ");
    const haystack = normTR(`${full} ${t.username ?? ""}`);
    return words.every((w) => haystack.includes(w));
  });
}

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
/**
 * Generic role words — "uzman", "terapist", "psikolog" name the profession
 * itself, not a specialty area. No specialty is called "Uzman", so using one
 * of these as a specialty filter would eliminate the entire roster
 * (prod bug: "bakırköyde uzman bul" → specialty_name="uzman" → 0 results).
 * A query made up solely of these words is treated as "no specialty filter";
 * mixed queries ("çocuk terapisti") keep only their meaningful words.
 */
const GENERIC_ROLE_WORDS = new Set([
  "uzman", "uzmani", "uzmanlar", "uzmanlari",
  "terapist", "terapisti", "terapistler", "terapistleri",
  "psikolog", "psikologu", "psikologlar", "psikologlari",
  "psikoterapist", "psikoterapisti",
  "psikiyatr", "psikiyatrist", "psikiyatristi",
  "danisman", "danismani", "danismanlar",
  "doktor", "hekim", "hoca",
]);

/**
 * User-language → catalogue-language synonyms. Planda's specialty taxonomy
 * has no entry literally named "stres", "tükenmişlik" or "panik" — users say
 * those words constantly (prod, 2026-08-11: "online" + "tükenmişlik" → two
 * consecutive "bulunamadı" replies while kaygı therapists sat unused).
 * Keys and values are normTR'd. Values are substrings expected to appear in
 * specialties[].name / services[].name.
 */
const SPECIALTY_SYNONYMS: Record<string, string[]> = {
  stres: ["kaygi", "duygu yonetimi"],
  tukenmislik: ["kaygi", "kariyer", "duygu yonetimi"],
  burnout: ["kaygi", "kariyer", "duygu yonetimi"],
  panik: ["kaygi"],
  okb: ["kaygi"],
  obsesif: ["kaygi"],
  takinti: ["kaygi"],
  ofke: ["duygu yonetimi"],
  sinir: ["duygu yonetimi"],
  ozguven: ["kisisel farkindalik"],
  degersizlik: ["kisisel farkindalik", "depresyon"],
  mukemmeliyetcilik: ["kisisel farkindalik", "kaygi"],
  motivasyon: ["kariyer", "kisisel farkindalik"],
  erteleme: ["kariyer", "kisisel farkindalik"],
  sosyofobi: ["fobi", "kaygi"],
  ayrilik: ["iliskisel", "kayip"],
  bosanma: ["iliskisel"],
  kiskanclik: ["iliskisel", "baglanma"],
  dehb: ["dikkat"],
};

/**
 * Words whose plain substring is too loose for the catalogue. "ilişki" is
 * the user's word for relationship trouble, but as a substring it also hits
 * "Akran İlişkileri" — a child/teen specialty (prod, 2026-09-01: the tool
 * returned a child therapist for an adult relationship query, the model led
 * with her, and the response guard — which requires "İlişkisel" — pruned the
 * card). Keys and values are normTR'd; a matching word is replaced by its
 * catalogue form instead of being used verbatim.
 */
const SPECIALTY_NARROWING: Record<string, string> = {
  iliski: "iliskisel",
  iliskiler: "iliskisel",
  iliskim: "iliskisel",
  iliskimiz: "iliskisel",
};

export function filterBySpecialtyName(list: Therapist[], query: string): Therapist[] {
  let norm = normTR(query);
  if (norm.length < 3) return list;

  // Strip generic role words. All-generic query → no-op (return unfiltered);
  // mixed query → match on the meaningful remainder ("çocuk terapisti" → "çocuk").
  const words = norm.split(" ").filter(Boolean);
  const meaningful = words.filter((w) => !GENERIC_ROLE_WORDS.has(w));
  if (meaningful.length === 0) return list;
  if (meaningful.length < words.length) {
    norm = meaningful.join(" ");
    if (norm.length < 3) return list;
  }

  // Expand with synonyms: the original phrase always stays first; each
  // meaningful word (and the whole phrase) may add catalogue substrings.
  // Narrowed words are swapped for their catalogue form first, so "ilişki"
  // enters as "iliskisel" and never matches as a bare substring.
  norm = meaningful.map((w) => SPECIALTY_NARROWING[w] ?? w).join(" ");
  const targets = new Set<string>([norm]);
  for (const t of SPECIALTY_SYNONYMS[norm] ?? []) targets.add(t);
  for (const w of meaningful) {
    for (const t of SPECIALTY_SYNONYMS[w] ?? []) targets.add(t);
  }

  const matchesAnyTarget = (name: string | undefined): boolean => {
    const n = normTR(name ?? "");
    if (!n) return false;
    for (const target of targets) {
      if (n.includes(target)) return true;
    }
    return false;
  };

  return list.filter((t) => {
    const specMatch = (t.specialties ?? []).some((s) => matchesAnyTarget(s?.name));
    if (specMatch) return true;
    // Fallback — some therapists expose the relevant domain only via
    // services[] (e.g. "Çocuk Terapisi" without a Çocuk specialty tag).
    return (t.services ?? []).some((s) => matchesAnyTarget(s?.name));
  });
}

/**
 * Build a {normalized_name → specialty_id} map from a therapist list.
 * Useful when the model needs to resolve a user-typed specialty phrase
 * ("anksiyete", "kaygı") to an API-recognized specialty_id WITHOUT a
 * separate /specialties endpoint call — the data is already in every
 * find_therapists response under therapist.specialties[].
 */
export function buildSpecialtyMap(therapists: Therapist[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of therapists) {
    for (const s of t.specialties ?? []) {
      if (s?.id && s?.name) {
        const key = normTR(s.name);
        if (key && !map.has(key)) map.set(key, s.id);
      }
    }
  }
  return map;
}

export interface ApplyFiltersParams {
  online?: boolean;
  gender?: "female" | "male";
  max_fee?: number;
  name?: string;
  specialty_name?: string;
  age?: number; // keeps only therapists whose accepted age range covers it
  city?: string; // used only to enforce physical-branch city match when online===false
}

/**
 * Apply all configured filters in order. Returns the filtered list.
 * Order matters for composability: specialty and name first (narrowing),
 * then attribute predicates.
 */
export function applyAiSideFilters(list: Therapist[], f: ApplyFiltersParams): Therapist[] {
  let out = list;
  if (f.name) out = filterByFuzzyName(out, f.name);
  if (f.specialty_name) out = filterBySpecialtyName(out, f.specialty_name);
  if (f.online === true) out = out.filter(matchesOnline);
  if (f.online === false) out = out.filter((t) => matchesPhysical(t, f.city));
  if (f.gender) out = out.filter((t) => matchesGender(t, f.gender!));
  if (typeof f.max_fee === "number") out = out.filter((t) => matchesMaxFee(t, f.max_fee!));
  if (typeof f.age === "number") out = out.filter((t) => matchesAge(t, f.age!));
  return out;
}
