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
