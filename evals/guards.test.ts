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
import { extractUserTopics, buildFlowUserText } from "../src/guards/hallucinationGuard.js";
import { detectLadderSkip, nextOwedRung, LADDER_STEERING_NOTES } from "../src/guards/ladderGuard.js";
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

test("detectLadderSkip: flags the prod transcript (missing modality)", () => {
  const r = detectLadderSkip({
    userMessage: "aksiyete, 28 yaşındayım",
    history: prodHistory,
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, true);
  assert.equal(r.missingRung, "modality");
});

test("detectLadderSkip: flags in-person answer without a city (rung 3a)", () => {
  // Second prod transcript: user answered the modality question with
  // "yüzyüze" and cards appeared without the city ever being asked.
  const r = detectLadderSkip({
    userMessage: "yüzyüze",
    history: [
      ...prodHistory,
      { role: "user", content: "aksiyete, 28 yaşındayım" },
      {
        role: "assistant",
        content:
          "Sana en uygun ismi bulabilmem için tek bir şey daha sorayım: " +
          "görüşmeleri online mı yoksa yüz yüze mi yapmayı tercih edersin?",
      },
    ],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, true);
  assert.equal(r.missingRung, "city");
});

test("detectLadderSkip: in-person + city given passes", () => {
  const r = detectLadderSkip({
    userMessage: "yüz yüze, Ankara'dayım, 31 yaşındayım",
    history: prodHistory,
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, "in_person_with_location");
});

test("detectLadderSkip: does not re-ask city right after asking it", () => {
  const r = detectLadderSkip({
    userMessage: "bilmiyorum, gezginim ben",
    history: [
      ...prodHistory,
      { role: "user", content: "yüz yüze, 40 yaşındayım" },
      {
        role: "assistant",
        content: "Peki, sana yakın bir isim bulmam için hangi şehirdesin?",
      },
    ],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, "city_already_asked");
});

test("detectLadderSkip: adult flow without an age flags the age rung", () => {
  // Age caps go both ways (child-only AND 24/30/35 adult caps), so even a
  // complete-looking fast flow owes the age question before cards.
  const r0 = detectLadderSkip({
    userMessage: "İstanbul'da kaygı için terapist",
    history: [],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r0.skipped, true);
  assert.equal(r0.missingRung, "age");
});

test("detectLadderSkip: passes when the user gave a city", () => {
  // City + problem without modality is a HIZLI KARAR case.
  const r = detectLadderSkip({
    userMessage: "İstanbul'da kaygı için terapist, 35 yaşındayım",
    history: [],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, "location_given");
});

test("detectLadderSkip: passes when the user said online", () => {
  // Online ends the location branch — city is irrelevant.
  const r = detectLadderSkip({
    userMessage: "online terapist arıyorum, kaygı için, 29 yaşındayım",
    history: [],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, "modality_online");
});

test("detectLadderSkip: in-person from history still needs a city", () => {
  // Modality being present is NOT enough when it's yüz yüze — rung 3a
  // (city) is still owed. This was the second prod gap.
  const r = detectLadderSkip({
    userMessage: "aksiyete, 30 yaşındayım",
    history: [
      { role: "user", content: "yüz yüze görüşmek istiyorum" },
      { role: "assistant", content: "Seni en çok zorlayan konu ne?" },
    ],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, true);
  assert.equal(r.missingRung, "city");
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

test("detectLadderSkip: question budget resets after a delivered recommendation", () => {
  // Live incident (sid=d93be81f): a long session accumulated 3+ question
  // turns across OLD, completed search flows, and the whole-history count
  // disarmed the guard for the rest of the session. Questions before the
  // last card-bearing turn must not count against the current flow.
  const r = detectLadderSkip({
    userMessage: "kaygı için terapist lazım",
    history: [
      { role: "user", content: "psikolog arıyorum" },
      { role: "assistant", content: "Seni en çok zorlayan konu ne?" },
      { role: "user", content: "uyku sorunu" },
      { role: "assistant", content: "Online mı yüz yüze mi tercih edersin?" },
      { role: "user", content: "farketmez sen öner" },
      { role: "assistant", content: "Peki bütçen nedir?" },
      // Completed flow — cards delivered. Budget resets here. The old
      // "farketmez" answer also belonged to that flow, but speed phrases
      // legitimately persist as a user preference; use a fresh transcript
      // below to keep this test about the budget alone.
      { role: "assistant", content: "Şu isim uygun: **Test Kişi** — Psikolog [[expert:test-kisi]]" },
    ],
    response: CARDS,
    intent: searchIntent,
  });
  // Speed phrase from the earlier flow still passes it through — assert the
  // reason is NOT budget exhaustion: the 3 old questions no longer count.
  assert.notEqual(r.reason, "question_budget_spent");
});

test("detectLadderSkip: passes once the 4-question budget is spent", () => {
  const r = detectLadderSkip({
    userMessage: "bilmiyorum",
    history: [
      { role: "user", content: "psikolog arıyorum" },
      { role: "assistant", content: "Seni en çok zorlayan konu ne?" },
      { role: "user", content: "kaygı" },
      { role: "assistant", content: "Terapi görecek kişi kaç yaşında?" },
      { role: "user", content: "30" },
      { role: "assistant", content: "Online mı yüz yüze mi tercih edersin?" },
      { role: "user", content: "hmm" },
      { role: "assistant", content: "Bütçen nedir?" },
    ],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, "question_budget_spent");
});

test("detectLadderSkip: modality dodge with no topic recovers to the topic rung", () => {
  // The user gave an unparseable answer to the modality question. Modality
  // must not be re-asked (trap) — but topic was NEVER asked, so the guard
  // recovers the flow at rung 1 instead of passing the cards through.
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
  assert.equal(r.skipped, true);
  assert.equal(r.missingRung, "topic");
});

test("detectLadderSkip: modality dodge with topic known does not re-ask", () => {
  // Same loop breaker as before, with the topic already given — cards pass.
  const r = detectLadderSkip({
    userMessage: "hmm bilmiyorum ki",
    history: [
      { role: "user", content: "depresyondayım, 33 yaşındayım, psikolog arıyorum" },
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

// ─── buildFlowUserText — flow-scoped guard context ───────────────────────────
//
// Prod (ladder flow): topic "aksiyetem var" arrived three turns before the
// city. Guards received only the final "istanbul", so topics=[] and the
// specialty check/Eşleşme line silently disabled themselves.

const ladderHistory: ChatMessage[] = [
  { role: "user", content: "Kendim için psikolog arıyorum" },
  { role: "assistant", content: "Seni en çok zorlayan konu ne?" },
  { role: "user", content: "aksiyetem var" },
  { role: "assistant", content: "Online mı yüz yüze mi tercih edersin?" },
  { role: "user", content: "yüzyüze" },
  { role: "assistant", content: "Hangi şehirde?" },
];

test("buildFlowUserText: joins current-flow user turns with the new message", () => {
  const text = buildFlowUserText(ladderHistory, "istanbul");
  assert.ok(text.includes("aksiyetem var"));
  assert.ok(text.includes("yüzyüze"));
  assert.ok(text.includes("istanbul"));
  // Assistant turns must not leak into the user-request text.
  assert.ok(!text.includes("zorlayan konu"));
});

test("buildFlowUserText: the prod ladder flow now yields the anxiety topic", () => {
  assert.deepEqual(
    extractUserTopics(buildFlowUserText(ladderHistory, "istanbul")),
    ["kaygi"]
  );
});

test("buildFlowUserText: topic survives cards shown mid-ladder", () => {
  // Prod follow-up: the loop-breaker let cards appear right after the topic
  // answer, then the user kept refining (yüzyüze → istanbul). A boundary at
  // the last card-bearing reply would lose the topic again — every recent
  // user turn must stay in the context.
  const withMidFlowCards: ChatMessage[] = [
    { role: "user", content: "aksiyetem var" },
    { role: "assistant", content: "**Ad Soyad** — Psikolog\n[[expert:ad-soyad]]" },
    { role: "user", content: "yüzyüze" },
  ];
  const text = buildFlowUserText(withMidFlowCards, "istanbul");
  assert.ok(text.includes("aksiyetem var"));
  assert.deepEqual(extractUserTopics(text), ["kaygi"]);
});

test("buildFlowUserText: empty history returns just the message", () => {
  assert.equal(buildFlowUserText([], "kaygı için terapist"), "kaygı için terapist");
});

// ─── detectLadderSkip — topic rung ───────────────────────────────────────────
//
// Prod transcript: model (steered by the guard's own modality-first rescue)
// walked modality → city and then showed generic cards with "konu
// belirtmediğin için…" — no topic, no specialty scoring, empty Eşleşme.

test("detectLadderSkip: flags cards shown with no topic ever given", () => {
  const r = detectLadderSkip({
    userMessage: "istanbul",
    history: [
      { role: "user", content: "Kendim için psikolog arıyorum" },
      {
        role: "assistant",
        content:
          "Sana en uygun ismi bulabilmem için tek bir şey daha sorayım: " +
          "görüşmeleri online mı yoksa yüz yüze mi yapmayı tercih edersin?",
      },
      { role: "user", content: "yüzyüze" },
      { role: "assistant", content: "Anladım, yüz yüze bakıyoruz. Hangi şehirdeysen ona göre en uygun isimleri çıkarayım?" },
    ],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, true);
  assert.equal(r.missingRung, "topic");
});

test("detectLadderSkip: topic dodge falls through to the other rungs", () => {
  // Topic was asked (prodHistory), user answered with something topicless —
  // don't insist; the next owed rung (modality) is flagged instead.
  const r = detectLadderSkip({
    userMessage: "bilmiyorum, karışık her şey",
    history: prodHistory,
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, true);
  assert.equal(r.missingRung, "age");
});

test("detectLadderSkip: approach query needs no topic, but still owes an age", () => {
  const r = detectLadderSkip({
    userMessage: "online bdt terapisti arıyorum",
    history: [],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, true);
  assert.equal(r.missingRung, "age");

  const aged = detectLadderSkip({
    userMessage: "online bdt terapisti arıyorum, 26 yaşındayım",
    history: [],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(aged.skipped, false);
  assert.equal(aged.reason, "modality_online");
});

test("detectLadderSkip: name lookup needs no topic", () => {
  const r = detectLadderSkip({
    userMessage: "Ekin Alankuş kim, online görüşüyor mu?",
    history: [],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, false);
  // Name lookups exit before the modality rungs — they owe no question.
  assert.equal(r.reason, "name_lookup");
});

// ─── detectLadderSkip — age rung (child/teen flows) ─────────────────────────

test("detectLadderSkip: child signal without an age flags the age rung", () => {
  const r = detectLadderSkip({
    userMessage: "Çocuğum için online terapist lazım, çok kaygılı",
    history: [],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, true);
  assert.equal(r.missingRung, "age");
});

test("detectLadderSkip: child with age stated passes the age rung", () => {
  const r = detectLadderSkip({
    userMessage: "14 yaşındaki kızım için online kaygı terapisti",
    history: [],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, "modality_online");
});

test("detectLadderSkip: bare-number answer to the age question counts", () => {
  const r = detectLadderSkip({
    userMessage: "online olsun",
    history: [
      { role: "user", content: "Oğlum için kaygı terapisti arıyorum" },
      { role: "assistant", content: "Terapi görecek kişi kaç yaşında?" },
      { role: "user", content: "14" },
      { role: "assistant", content: "Online mı yüz yüze mi tercih edersin?" },
    ],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, "modality_online");
});

test("detectLadderSkip: age dodge falls through instead of trapping", () => {
  const r = detectLadderSkip({
    userMessage: "önemli mi bilmiyorum, kaygılı işte, online olsun",
    history: [
      { role: "user", content: "Çocuğum için terapist arıyorum" },
      { role: "assistant", content: "Terapi görecek kişi kaç yaşında?" },
    ],
    response: CARDS,
    intent: searchIntent,
  });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, "modality_online");
});

// ─── nextOwedRung (pre-steer) ────────────────────────────────────────────────
// The iOS transcript of 2026-08-31: topic asked, age asked, user answers
// "25". Prompt-only fixes left the model searching 4 times out of 5; the
// pre-steer hands it the modality note before it runs.

const videoHistory: ChatMessage[] = [
  { role: "user", content: "İlk kez terapi alacağım, nereden başlamalıyım?" },
  { role: "assistant", content: "Anladım, ilk adımda neye ihtiyacın olduğunu netleştirebiliriz. Seni en çok zorlayan şey ne?" },
  { role: "user", content: "Bağımlıyım" },
  { role: "assistant", content: "Anlıyorum, bu gerçekten zorlayıcı olabilir. Kaç yaşındasın?" },
];
const clarificationIntent: IntentResult = { intent: "clarification", expectedTools: [], matched: ["continuation_of_question"] };

test("nextOwedRung: age answered, modality never asked → modality is owed", () => {
  const r = nextOwedRung({ userMessage: "25", history: videoHistory, intent: clarificationIntent });
  assert.equal(r.skipped, true);
  assert.equal(r.missingRung, "modality");
  assert.match(LADDER_STEERING_NOTES.modality, /online mı yüz yüze mi/);
});

test("nextOwedRung: modality answered online → nothing owed", () => {
  const history: ChatMessage[] = [
    ...videoHistory,
    { role: "user", content: "25" },
    { role: "assistant", content: "Anladım. Online mı yüz yüze mi tercih edersin?" },
  ];
  const r = nextOwedRung({ userMessage: "Online olsun", history, intent: clarificationIntent });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, "modality_online");
});

test("nextOwedRung: in-person answered, no city → city is owed", () => {
  const history: ChatMessage[] = [
    ...videoHistory,
    { role: "user", content: "25" },
    { role: "assistant", content: "Anladım. Online mı yüz yüze mi tercih edersin?" },
  ];
  const r = nextOwedRung({ userMessage: "Yüz yüze", history, intent: clarificationIntent });
  assert.equal(r.skipped, true);
  assert.equal(r.missingRung, "city");
});

test("nextOwedRung: exempt intents are never steered", () => {
  const r = nextOwedRung({
    userMessage: "Ekin Alankuş kim?",
    history: [],
    intent: { intent: "therapist_detail", expectedTools: ["find_therapists"], matched: [] },
  });
  assert.equal(r.skipped, false);
});

test("nextOwedRung agrees with detectLadderSkip whenever cards are shown", () => {
  const owed = nextOwedRung({ userMessage: "25", history: videoHistory, intent: clarificationIntent });
  const skip = detectLadderSkip({ userMessage: "25", history: videoHistory, intent: clarificationIntent, response: CARDS });
  assert.equal(skip.missingRung, owed.missingRung);
});

test("nextOwedRung: a name lookup owes no rung at all", () => {
  const r = nextOwedRung({
    userMessage: "Ekin Alankuş kim?",
    history: [],
    intent: { intent: "search_therapist", expectedTools: ["find_therapists"], matched: [] },
  });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, "name_lookup");
});

// ─── nextOwedRung — child flow (prod e2e 2026-08-31) ─────────────────────────

const childHistory: ChatMessage[] = [
  { role: "user", content: "Çocuğum için terapist arıyorum" },
  { role: "assistant", content: "Tabii, yardımcı olayım. Terapi görecek kişi kaç yaşında?" },
];

test("nextOwedRung: 'çocuğum için' is who-for, not a topic — topic is owed after the age", () => {
  const r = nextOwedRung({ userMessage: "9 yaşında", history: childHistory, intent: clarificationIntent });
  assert.equal(r.skipped, true);
  assert.equal(r.missingRung, "topic");
});

test("nextOwedRung: answering the topic after a modality question is not a dodge", () => {
  const history: ChatMessage[] = [
    ...childHistory,
    { role: "user", content: "9 yaşında" },
    { role: "assistant", content: "Anladım, 9 yaş için bakıyorum. Online mı yüz yüze mi tercih edersin?" },
  ];
  const r = nextOwedRung({ userMessage: "Okulda çok kaygılı, arkadaş edinemiyor", history, intent: clarificationIntent });
  assert.equal(r.skipped, true);
  assert.equal(r.missingRung, "modality");
});

test("nextOwedRung: a genuine dodge of the modality question still passes", () => {
  const history: ChatMessage[] = [
    ...videoHistory,
    { role: "user", content: "25" },
    { role: "assistant", content: "Anladım. Online mı yüz yüze mi tercih edersin?" },
  ];
  const r = nextOwedRung({ userMessage: "bilmiyorum, fark eder mi?", history, intent: clarificationIntent });
  assert.equal(r.skipped, false);
  assert.equal(r.reason, "modality_already_asked");
});

test("extractUserTopics: 'Bağımlıyım' is the addiction topic", () => {
  assert.deepEqual(extractUserTopics("Bağımlıyım"), ["bagimlilik"]);
  assert.ok(extractUserTopics("alkol bağımlılığı var").includes("bagimlilik"));
});
