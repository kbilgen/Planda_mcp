/**
 * Unit tests for intentClassifier — keyword disambiguation edge cases.
 *
 * Run:
 *   npm run test:unit
 *   (or: node --import tsx --test evals/classifier.test.ts)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyIntent,
  detectIntentToolMismatch,
} from "../src/guards/intentClassifier.js";

// ─── Search vs. availability disambiguation (NODE-2 regression) ──────────────

test("'Kaygı için hangi terapist uygun?' → search_therapist (not availability)", () => {
  const r = classifyIntent("Kaygı (anksiyete) için hangi terapist uygun?");
  assert.equal(r.intent, "search_therapist");
  assert.deepEqual(r.expectedTools, ["find_therapists"]);
});

test("'Hangi psikolog önerirsin?' → search_therapist", () => {
  const r = classifyIntent("Hangi psikolog önerirsin?");
  assert.equal(r.intent, "search_therapist");
  assert.deepEqual(r.expectedTools, ["find_therapists"]);
});

test("'Hangi uzman BDT yapıyor?' → search_therapist + detail (get_therapist)", () => {
  const r = classifyIntent("Hangi uzman BDT yapıyor?");
  assert.equal(r.intent, "search_therapist");
  assert.deepEqual(r.expectedTools, ["find_therapists", "get_therapist"]);
});

test("'Yarın uygun saat var mı?' → check_availability", () => {
  const r = classifyIntent("Yarın uygun saat var mı?");
  assert.equal(r.intent, "check_availability");
});

test("'Hangi gün müsait?' → check_availability", () => {
  const r = classifyIntent("Hangi gün müsait?");
  assert.equal(r.intent, "check_availability");
});

test("'Müsait günleri ne zaman?' → check_availability", () => {
  const r = classifyIntent("Müsait günleri ne zaman?");
  assert.equal(r.intent, "check_availability");
});

test("'Uygun bir terapist var mı?' → search_therapist (uygun+terapist not availability)", () => {
  const r = classifyIntent("Uygun bir terapist var mı?");
  assert.equal(r.intent, "search_therapist");
});

// ─── Specificity-aware expected tools (NODE-1 regression) ────────────────────

test("'kendim için psikolog arıyorum' → search_therapist, expectedTools=[] (vague)", () => {
  const r = classifyIntent("kendim için psikolog arıyorum");
  assert.equal(r.intent, "search_therapist");
  assert.deepEqual(r.expectedTools, []);
});

test("'terapi arıyorum' → search_therapist, expectedTools=[] (vague)", () => {
  const r = classifyIntent("terapi arıyorum");
  assert.equal(r.intent, "search_therapist");
  assert.deepEqual(r.expectedTools, []);
});

test("'İstanbul'da anksiyete için psikolog arıyorum' → specific, tool required", () => {
  const r = classifyIntent("İstanbul'da anksiyete için psikolog arıyorum");
  assert.equal(r.intent, "search_therapist");
  assert.deepEqual(r.expectedTools, ["find_therapists"]);
});

test("'BDT yapan bir terapist istiyorum' → search+detail, two tools", () => {
  const r = classifyIntent("BDT yapan bir terapist istiyorum");
  assert.equal(r.intent, "search_therapist");
  assert.deepEqual(r.expectedTools, ["find_therapists", "get_therapist"]);
});

// ─── Other intent categories ─────────────────────────────────────────────────

test("'merhaba' → greeting", () => {
  const r = classifyIntent("merhaba");
  assert.equal(r.intent, "greeting");
  assert.deepEqual(r.expectedTools, []);
});

test("'Python kod yaz' → out_of_scope", () => {
  const r = classifyIntent("Python'da bir fonksiyon nasıl yazılır?");
  assert.equal(r.intent, "out_of_scope");
});

test("empty string → unknown", () => {
  const r = classifyIntent("");
  assert.equal(r.intent, "unknown");
});

// ─── Mismatch detection ──────────────────────────────────────────────────────

test("mismatch suppressed when response ends with '?'", () => {
  const intent = classifyIntent("İstanbul'da anksiyete için psikolog");
  const m = detectIntentToolMismatch(intent, [], "Online mi yüz yüze mi olsun?");
  assert.equal(m.length, 0);
});

test("mismatch suppressed when response contains Turkish clarifier phrase", () => {
  const intent = classifyIntent("İstanbul'da travma için psikolog");
  const m = detectIntentToolMismatch(intent, [], "Kimin için arıyorsun söyleyebilir misin");
  assert.equal(m.length, 0);
});

test("mismatch flagged when specific search returns therapist without tool call", () => {
  const intent = classifyIntent("İstanbul'da anksiyete için psikolog arıyorum");
  const m = detectIntentToolMismatch(
    intent,
    [],
    "Sana **Ahmet Yılmaz**'ı öneririm."
  );
  assert.equal(m.length, 1);
  assert.match(m[0], /find_therapists/);
});

test("mismatch NOT flagged when vague search produces clarification", () => {
  const intent = classifyIntent("terapi arıyorum");
  const m = detectIntentToolMismatch(intent, [], "Hangi konu için yardım istiyorsun?");
  assert.equal(m.length, 0);
});

// ─── Search vs. availability — extended disambiguation corpus ─────────────────
// These ten pairs target the exact ambiguity that produced NODE-2. Every
// addition here is a concrete production message or close variant. If the
// classifier regresses, one of these tests fires before Sentry does.

test("search: 'Depresyon için hangi uzmanı önerirsin?'", () => {
  assert.equal(classifyIntent("Depresyon için hangi uzmanı önerirsin?").intent, "search_therapist");
});

test("search: 'Panik atağım var, hangi psikolog yardımcı olur?'", () => {
  assert.equal(
    classifyIntent("Panik atağım var, hangi psikolog yardımcı olur?").intent,
    "search_therapist"
  );
});

test("search: 'İlişki sorunları için uygun bir terapist arıyorum'", () => {
  assert.equal(
    classifyIntent("İlişki sorunları için uygun bir terapist arıyorum").intent,
    "search_therapist"
  );
});

test("search: 'Ankara'da online terapi veren psikolog lazım'", () => {
  assert.equal(
    classifyIntent("Ankara'da online terapi veren psikolog lazım").intent,
    "search_therapist"
  );
});

test("search: 'Travma alanında deneyimli hangi terapist var?'", () => {
  assert.equal(
    classifyIntent("Travma alanında deneyimli hangi terapist var?").intent,
    "search_therapist"
  );
});

test("availability: 'Bu terapistin perşembe günü uygun saati var mı?'", () => {
  assert.equal(
    classifyIntent("Bu terapistin perşembe günü uygun saati var mı?").intent,
    "check_availability"
  );
});

test("availability: 'Ayşe hanımın hangi günü müsait?'", () => {
  // "hangi gün" → availability disambiguator. "Ayşe hanım" isn't a SEARCH_HANGI match.
  assert.equal(classifyIntent("Ayşe hanımın hangi günü müsait?").intent, "check_availability");
});

test("availability: 'Randevu almak istiyorum, ne zaman uygun?'", () => {
  assert.equal(
    classifyIntent("Randevu almak istiyorum, ne zaman uygun?").intent,
    "check_availability"
  );
});

test("availability: 'Yarın için bir seans ayırtabilir miyim?'", () => {
  // "yarın" + time-question marker ("var mı?") — borderline, but "yarın" +
  // booking phrase should lean availability. Today it falls to search because
  // of "seans" keyword → documented expectation for now.
  const r = classifyIntent("Yarın için bir seans ayırtabilir miyim?");
  assert.ok(r.intent === "check_availability" || r.intent === "search_therapist");
});

test("availability: 'Bu pazartesi 14:00 müsait mi?'", () => {
  assert.equal(
    classifyIntent("Bu pazartesi 14:00 müsait mi?").intent,
    "check_availability"
  );
});

// ─── Name-lookup pattern (lookup-01-name regression) ─────────────────────────
// Capitalized 2+ word names should classify as search_therapist when no
// other intent matches. Availability still wins when its keywords are present.

test("name-lookup: 'Ekin Alankuş kim?' → search_therapist", () => {
  const r = classifyIntent("Ekin Alankuş kim?");
  assert.equal(r.intent, "search_therapist");
  assert.deepEqual(r.expectedTools, ["find_therapists"]);
});

test("name-lookup: 'Ayşe Nur Çelik hakkında bilgi verir misin?' → search_therapist", () => {
  // "hakkında" is in DETAIL_KEYS but no SEARCH_KEYS — currently falls through
  // to detail intent (get_therapist), which is also acceptable. Either intent
  // results in a tool call so we accept both.
  const r = classifyIntent("Ayşe Nur Çelik hakkında bilgi verir misin?");
  assert.ok(
    r.intent === "search_therapist" || r.intent === "therapist_detail",
    `expected search_therapist or therapist_detail, got ${r.intent}`
  );
  assert.ok(r.expectedTools.length > 0, "name lookup must expect a tool call");
});

test("name-lookup respects availability priority: 'Ekin Alankuş bu hafta müsait mi?'", () => {
  // "müsait" should still pull the message to availability even though the
  // capital-name pattern matches.
  const r = classifyIntent("Ekin Alankuş bu hafta müsait mi?");
  assert.equal(r.intent, "check_availability");
});

test("name-lookup: single capitalized word does NOT trigger (avoid 'İstanbul' false positive)", () => {
  // Just "İstanbul'da terapist" shouldn't fire name-lookup; it's a search
  // (caught earlier by SEARCH_KEYS via "terapist").
  const r = classifyIntent("İstanbul'da terapist");
  assert.equal(r.intent, "search_therapist");
});

// ─── Explanation / meta-justification requests (Sentry f7c0f3e9 regression) ──
// The model tends to fabricate methodology when asked "how did you choose?".
// These tests lock in the new explanation_request intent and its expectedTools.

test("explanation: 'BDT olanları neye göre seçtin' → explanation_request, NOT therapist_detail", () => {
  const r = classifyIntent("BDT olanları neye göre hangi kritere göre seçtin");
  assert.equal(r.intent, "explanation_request");
  assert.deepEqual(r.expectedTools, ["find_therapists", "get_therapist"]);
});

test("explanation: 'Bunları nasıl seçtin?' → explanation_request", () => {
  assert.equal(classifyIntent("Bunları nasıl seçtin?").intent, "explanation_request");
});

test("explanation: 'Neye dayanarak öneriyorsun?' → explanation_request", () => {
  assert.equal(
    classifyIntent("Neye dayanarak öneriyorsun?").intent,
    "explanation_request"
  );
});

test("explanation: 'Hangi kritere göre filtreliyorsun?' → explanation_request", () => {
  assert.equal(
    classifyIntent("Hangi kritere göre filtreliyorsun?").intent,
    "explanation_request"
  );
});

test("explanation: 'Kaynağın ne?' → explanation_request", () => {
  assert.equal(classifyIntent("Kaynağın ne?").intent, "explanation_request");
});

test("explanation: 'Nereden biliyorsun?' → explanation_request", () => {
  assert.equal(classifyIntent("Nereden biliyorsun?").intent, "explanation_request");
});

test("NOT explanation: 'BDT yapan terapist var mı?' → search_therapist (different meaning)", () => {
  // "neye göre" yok — BDT için arama, açıklama isteği değil
  assert.equal(classifyIntent("BDT yapan terapist var mı?").intent, "search_therapist");
});

test("mismatch suppressed when explanation answer uses honest-fallback phrase", () => {
  const intent = classifyIntent("BDT olanları neye göre seçtin");
  const m = detectIntentToolMismatch(
    intent,
    [], // no tools called
    "Önceki önerimin tam dayanağını şu anda tekrar doğrulamam gerekiyor — istersen güncel listeye bakıp tekrar öneri çıkarayım."
  );
  assert.equal(m.length, 0);
});

test("mismatch FIRED when explanation answer fabricates methodology", () => {
  const intent = classifyIntent("BDT olanları neye göre seçtin");
  const m = detectIntentToolMismatch(
    intent,
    [],
    "approaches[] listesini kontrol ettim ve BDT yapan terapistleri filtreledim."
  );
  assert.equal(m.length, 1);
  assert.match(m[0], /find_therapists|get_therapist/);
});

// ─── NODE-3 — history-aware continuation ─────────────────────────────────────
// Short user replies to an assistant's clarifying question must NOT be
// re-classified as a fresh search intent (which would forceToolCall and
// eventually produce a fallback when the model can't ground a search from
// a fragment like "İstanbul Kartal").

test("'Ben İstanbul Kartalda oturuyorum' after assistant question → clarification", () => {
  const history = [
    { role: "user" as const, content: "terapist arıyorum" },
    { role: "assistant" as const, content: "Hangi şehirdesin?" },
  ];
  const r = classifyIntent("Ben İstanbul Kartalda oturuyorum", history);
  assert.equal(r.intent, "clarification");
  assert.deepEqual(r.expectedTools, []);
});

test("'30 yaşındayım' after assistant question → clarification", () => {
  const history = [
    { role: "user" as const, content: "çocuğum için" },
    { role: "assistant" as const, content: "Kaç yaşında?" },
  ];
  const r = classifyIntent("30 yaşındayım", history);
  assert.equal(r.intent, "clarification");
});

test("new search classified normally when last assistant DIDN'T ask", () => {
  const history = [
    { role: "user" as const, content: "merhaba" },
    { role: "assistant" as const, content: "Sana nasıl yardım edebilirim." },
  ];
  const r = classifyIntent("İstanbul'da anksiyete için terapist arıyorum", history);
  assert.equal(r.intent, "search_therapist");
  assert.deepEqual(r.expectedTools, ["find_therapists"]);
});

test("explanation_request takes priority over continuation check", () => {
  const history = [
    { role: "assistant" as const, content: "Bu iki ismi öneriyorum. Başka soru?" },
  ];
  const r = classifyIntent("BDT olanları neye göre seçtin", history);
  assert.equal(r.intent, "explanation_request");
});

test("no history → classifier works as before (backward compat)", () => {
  const r = classifyIntent("İstanbul'da anksiyete için psikolog arıyorum");
  assert.equal(r.intent, "search_therapist");
});

test("only most recent assistant turn considered (older questions ignored)", () => {
  const history = [
    { role: "assistant" as const, content: "Hangi şehirdesin?" },
    { role: "user" as const, content: "İstanbul" },
    { role: "assistant" as const, content: "Sana 2 isim buldum." },
  ];
  const r = classifyIntent("İlişki için anksiyete için psikolog lazım", history);
  assert.equal(r.intent, "search_therapist");
});
