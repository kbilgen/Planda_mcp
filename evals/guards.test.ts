/**
 * Unit tests for the two guards added after the "aksiyete" prod incident:
 *
 *   1. extractUserTopics  — typo-tolerant topic detection. A single missing
 *      letter used to zero out `topics`, which made verifySpecialtyMatch
 *      fail open and ship an off-topic therapist card.
 *   2. detectLadderSkip   — catches the model jumping to results without
 *      walking the SORU MERDİVENİ rung it owed the user.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractUserTopics } from "../src/guards/hallucinationGuard.js";
import { detectLadderSkip } from "../src/guards/ladderGuard.js";
import { mentionsLocation } from "../src/services/locationNormalizer.js";
import type { ChatMessage } from "../src/sessionStore.js";
import type { IntentResult } from "../src/guards/intentClassifier.js";

// ─── extractUserTopics — exact matching still works ──────────────────────────

test("extractUserTopics: exact keyword", () => {
  assert.deepEqual(extractUserTopics("anksiyete yaşıyorum"), ["kaygi"]);
});

test("extractUserTopics: prefix match on inflected form", () => {
  assert.deepEqual(extractUserTopics("kaygılarım çok arttı"), ["kaygi"]);
});

test("extractUserTopics: İlişkide → iliski (Turkish İ handling)", () => {
  assert.deepEqual(extractUserTopics("İlişkide sorun yaşıyorum"), ["iliski"]);
});

test("extractUserTopics: no topic in a vague request", () => {
  assert.deepEqual(extractUserTopics("terapist arıyorum"), []);
});

// ─── extractUserTopics — typo tolerance (the prod bug) ───────────────────────

test("extractUserTopics: 'aksiyete' (missing n) still resolves to kaygi", () => {
  // Prod: user typed this, topics came back [], verifySpecialtyMatch bailed,
  // and a therapist with no anxiety specialty was recommended.
  assert.deepEqual(extractUserTopics("aksiyete"), ["kaygi"]);
});

test("extractUserTopics: typo inside a longer sentence", () => {
  assert.deepEqual(extractUserTopics("çok kötü bir depresyom içindeyim"), ["depresyon"]);
});

test("extractUserTopics: 'travmaa' typo resolves to travma", () => {
  assert.deepEqual(extractUserTopics("travmaa yaşadım"), ["travma"]);
});

// ─── extractUserTopics — false positives the fuzzy layer must NOT create ─────

test("extractUserTopics: 'saygı' does not become 'kaygı'", () => {
  // 1 edit apart. Guarded by the >= 6 char minimum, which excludes "kaygi".
  assert.deepEqual(extractUserTopics("ona çok saygı duyuyorum"), []);
});

test("extractUserTopics: 'yaşıyorum' does not trigger the grief topic", () => {
  // The original prod regression (Sentry cf8da740) must stay fixed — the
  // fuzzy fallback runs on the same message and must not reintroduce it.
  assert.deepEqual(extractUserTopics("İstanbul'da yaşıyorum"), []);
});

test("extractUserTopics: fuzzy never widens a successful exact match", () => {
  // Exact matching finds "kaygi"; the fuzzy pass must not run and bolt on
  // near-miss topics from the same sentence.
  assert.deepEqual(extractUserTopics("kaygı sorunum var"), ["kaygi"]);
});

// ─── mentionsLocation ────────────────────────────────────────────────────────

test("mentionsLocation: province", () => {
  assert.equal(mentionsLocation("Ankara'da bir terapist arıyorum"), true);
});

test("mentionsLocation: province outside the district map", () => {
  assert.equal(mentionsLocation("Trabzon'dayım"), true);
});

test("mentionsLocation: district", () => {
  assert.equal(mentionsLocation("Kadıköy'de yüz yüze"), true);
});

test("mentionsLocation: multi-word semt", () => {
  assert.equal(mentionsLocation("Bağdat Caddesi civarı olur mu"), true);
});

test("mentionsLocation: no place named", () => {
  assert.equal(mentionsLocation("kaygı için terapist arıyorum"), false);
});

// ─── detectLadderSkip ────────────────────────────────────────────────────────

const CARDS =
  "Kaygı alanında çalışanlara baktım:\n\n" +
  "**Selin Anahar** — Uzman Psikolog [[expert:selin-anahar]]";

const searchIntent: IntentResult = {
  intent: "search_therapist",
  expectedTools: ["find_therapists"],
  matched: ["terapist"],
};

/** The exact prod transcript that motivated this guard. */
const prodHistory: ChatMessage[] = [
  { role: "user", content: "Kendim için psikolog arıyorum" },
  {
    role: "assistant",
    content:
      "Sana uygun terapisti bulmak için biraz daha netleştirelim: " +
      "seni en çok zorlayan konu ne?",
  },
];

test("detectLadderSkip: flags the prod transcript", () => {
  const r = detectLadderSkip({
    userMessage: "aksiyete",
    history: prodHistory,
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, true);
});

test("detectLadderSkip: passes when the user gave a city", () => {
  const r = detectLadderSkip({
    userMessage: "İstanbul'da kaygı için terapist",
    history: [],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, "location_given");
});

test("detectLadderSkip: passes when the user said online", () => {
  const r = detectLadderSkip({
    userMessage: "online terapist arıyorum, kaygı için",
    history: [],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, "modality_given");
});

test("detectLadderSkip: passes when modality came earlier in history", () => {
  const r = detectLadderSkip({
    userMessage: "aksiyete",
    history: [
      { role: "user", content: "yüz yüze görüşmek istiyorum" },
      { role: "assistant", content: "Seni en çok zorlayan konu ne?" },
    ],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, "modality_given");
});

test("detectLadderSkip: passes when the response has no cards", () => {
  const r = detectLadderSkip({
    userMessage: "aksiyete",
    history: prodHistory,
    response: "Online mı yüz yüze mi tercih edersin?",
    intent: searchIntent,
  });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, "no_cards");
});

test("detectLadderSkip: passes on availability intent", () => {
  const r = detectLadderSkip({
    userMessage: "Selin'in müsait günleri neler?",
    history: prodHistory,
    response: CARDS,
    intent: {
      intent: "check_availability",
      expectedTools: ["get_therapist_available_days"],
      matched: ["musait"],
    },
  });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, "exempt_intent:check_availability");
});

test("detectLadderSkip: passes when the user asked to skip ahead", () => {
  const r = detectLadderSkip({
    userMessage: "direkt öner, kaygı için",
    history: [],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, "user_wants_speed");
});

test("detectLadderSkip: passes once the 3-question budget is spent", () => {
  const r = detectLadderSkip({
    userMessage: "bilmiyorum",
    history: [
      { role: "user", content: "psikolog arıyorum" },
      { role: "assistant", content: "Seni en çok zorlayan konu ne?" },
      { role: "user", content: "kaygı" },
      { role: "assistant", content: "Terapi görecek kişi kaç yaşında?" },
      { role: "user", content: "30" },
      { role: "assistant", content: "Bütçen nedir?" },
    ],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, "question_budget_spent");
});

test("detectLadderSkip: does not re-ask when modality was just asked", () => {
  // Loop breaker: the user gave an unparseable answer to the modality
  // question. Asking it again would trap them.
  const r = detectLadderSkip({
    userMessage: "hmm bilmiyorum ki",
    history: [
      { role: "user", content: "psikolog arıyorum" },
      {
        role: "assistant",
        content: "Görüşmeleri online mı yoksa yüz yüze mi tercih edersin?",
      },
    ],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, "modality_already_asked");
});
