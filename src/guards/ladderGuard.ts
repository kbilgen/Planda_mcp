/**
 * Ladder guard — catches the model skipping a SORU MERDİVENİ rung.
 *
 * The system prompt (prompts.ts, "SORU MERDİVENİ") walks the user up a fixed
 * question ladder before showing results: topic → modality → city (when the
 * modality is in-person). HIZLI KARAR lets the model jump straight to results
 * only when the message already carries enough (city + problem, or an
 * explicit online request).
 *
 * Prod incidents this covers:
 *
 *   1. user: "aksiyete" (after the topic question)
 *      bot:  "…online ya da İstanbul'da uygun 3 terapist" + cards
 *      → rung 2 (online vs yüz yüze) skipped, modality AND city invented.
 *
 *   2. user: "yüzyüze" (after the modality question)
 *      bot:  cards, no city ever asked
 *      → rung 3a skipped: in-person results are city-bound, so showing them
 *        without knowing the city means the model picked one silently —
 *        the same ŞEHİR KURALI violation dressed differently.
 *
 * Nothing else watches this direction: workflow.ts's isClarifyingQuestion
 * checks the mirror case (model asked a question when a tool call was due).
 *
 * The guard is deliberately conservative — it only fires when the model
 * showed CARDS while the conversation is genuinely missing a rung, and every
 * ambiguity resolves to letting the response through.
 */

import type { ChatMessage } from "../sessionStore.js";
import type { IntentResult } from "./intentClassifier.js";
import { mentionsLocation } from "../services/locationNormalizer.js";
import { extractUserTopics, extractUserRequest } from "./hallucinationGuard.js";

/**
 * Static fallback questions, one per rung. The caller first tries to have
 * the model phrase the rung naturally (a real conversational turn that
 * acknowledges what the user just said); these fire only when that attempt
 * fails. Both end with "?" so clarifying-question heuristics downstream
 * (workflow.ts's isClarifyingQuestion) read them correctly.
 */
export const LADDER_TOPIC_QUESTION =
  "Sana en uygun uzmanı önerebilmem için biraz daha anlamak isterim: " +
  "seni en çok zorlayan konu ne?";

export const LADDER_AGE_QUESTION =
  "Uygun uzmanı belirleyebilmem için önemli: terapi görecek kişi kaç yaşında?";

export const LADDER_MODALITY_QUESTION =
  "Sana en uygun ismi bulabilmem için tek bir şey daha sorayım: " +
  "görüşmeleri online mı yoksa yüz yüze mi yapmayı tercih edersin?";

export const LADDER_CITY_QUESTION =
  "Yüz yüze görüşmek istediğini not ettim. Sana yakın bir terapist " +
  "önerebilmem için hangi şehirde olduğunu söyler misin?";

function normTR(s: string): string {
  return s
    .replace(/İ/g, "i")
    .replace(/I/g, "i")
    .toLowerCase()
    .replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u")
    .replace(/ö/g, "o").replace(/ı/g, "i").replace(/ç/g, "c")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Modality phrases, split by direction — the two rungs behave differently:
 * online ends the location branch of the ladder, in-person OPENS it.
 */
const ONLINE_PHRASES = [
  "online", "cevrimici", "cevrim ici", "uzaktan", "goruntulu", "video",
];

const IN_PERSON_PHRASES = [
  "yuz yuze", "yuzyuze", "fiziksel", "klinik", "ofis", "yerinde",
];

/** User signalled "skip the questions, just show me". */
const SPEED_PHRASES = [
  "direkt", "direk", "hemen", "hizli", "fark etmez", "farketmez",
  "onemli degil", "sen sec", "sen bil",
];

/** Intents where jumping straight to an answer is the correct behaviour. */
const EXEMPT_INTENTS = new Set([
  "check_availability",
  "therapist_detail",
  "list_specialties",
  "explanation_request",
  "greeting",
  "out_of_scope",
]);

/** The prompt caps the ladder at 4 question turns (prompts.ts "Kurallar"). */
const MAX_QUESTION_TURNS = 4;

export type LadderRung = "age" | "topic" | "modality" | "city";

export interface LadderSkipResult {
  /** True when the model showed cards but owed the user a question first. */
  skipped: boolean;
  /** Which rung the user was never walked up — set when skipped. */
  missingRung?: LadderRung;
  /** Why the check passed — for logs when nothing was flagged. */
  reason?: string;
}

/**
 * Per-rung "[Sistem notu: …]" steering. Two consumers:
 *   • pre-steer (index.ts ladderSteeringNote): appended to the user turn BEFORE
 *     the model runs when nextOwedRung() says a rung is still owed — an
 *     in-conversation note the model follows far more reliably than a rule
 *     buried in a 34k-char system prompt (live: age answered → cards 5/5 with
 *     prompt-only fixes; the post-hoc guard caught every one).
 *   • rescue (index.ts naturalLadderQuestion): the same note phrases the
 *     guard's replacement question when the model skipped anyway.
 */
export const LADDER_STEERING_NOTES: Record<LadderRung, string> = {
  age:
    "[Sistem notu: Terapi görecek kişinin yaşı henüz belli değil ve yaş " +
    "eleme için kritik. Terapist önerme, kart gösterme, tool çağırma. " +
    "Kullanıcının son mesajını kısaca ve sıcak bir dille kabul ettiğini " +
    "hissettir, sonra TEK soru olarak yaşı sor — kullanıcı kendisi için " +
    "arıyorsa doğal biçimde 'Kaç yaşındasın?', başkası içinse 'Terapi " +
    "görecek kişi kaç yaşında?'.]",
  topic:
    "[Sistem notu: Kullanıcının hangi konuda desteğe ihtiyacı olduğu henüz " +
    "belli değil. Terapist önerme, kart gösterme, tool çağırma. " +
    "Kullanıcının son mesajını kısaca ve sıcak bir dille kabul ettiğini " +
    "hissettir, sonra TEK soru olarak onu en çok zorlayan konunun ne " +
    "olduğunu sor.]",
  modality:
    "[Sistem notu: Kullanıcının görüşme tercihi (online mı yüz yüze mi) " +
    "henüz belli değil. Terapist önerme, kart gösterme, tool çağırma. " +
    "Kullanıcının son mesajını kısaca ve sıcak bir dille kabul ettiğini " +
    "hissettir, sonra TEK soru olarak online mı yüz yüze mi tercih " +
    "ettiğini sor.]",
  city:
    "[Sistem notu: Kullanıcı yüz yüze görüşmek istiyor ama hangi şehirde " +
    "olduğunu henüz söylemedi. Terapist önerme, kart gösterme, tool çağırma. " +
    "Kullanıcının son mesajını kısaca ve sıcak bir dille kabul ettiğini " +
    "hissettir, sonra TEK soru olarak hangi şehirde olduğunu sor.]",
};

function hasExpertCards(response: string): boolean {
  return /\[\[expert:[^\]]+\]\]/.test(response);
}

function containsAny(normalized: string, phrases: string[]): boolean {
  return phrases.some((p) => normalized.includes(p));
}

/**
 * Did the assistant's most recent turn already ask about this rung? If so
 * the user has been asked and either answered ambiguously or ignored it —
 * asking again would loop. Let the response through.
 */
function lastTurnAsked(history: ChatMessage[], rung: LadderRung): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "assistant") continue;
    const n = normTR(history[i].content);
    if (rung === "modality") {
      return n.includes("online") && (n.includes("yuz yuze") || n.includes("yuzyuze"));
    }
    return n.includes("sehir") || n.includes("nerede");
  }
  return false;
}

/**
 * Question turns spent in the CURRENT search flow, not the whole session.
 *
 * The prompt's 3-question cap is per search ("sonuca ulaşana kadar TOPLAMDA
 * en fazla 3 soru turu") — a delivered recommendation ends that flow. Seen
 * live (sid=d93be81f, 16-turn session): counting the whole history let old
 * flows' questions exhaust the budget, and the guard disarmed for the rest
 * of the session's lifetime. Count only after the last card-bearing
 * assistant turn.
 */
/**
 * Was the topic question asked at ANY point in the conversation? Unlike the
 * modality/city loop breakers (which only shield the immediately-dodged
 * question), topic uses the whole history: once the user was asked what's
 * troubling them and moved on without answering, they chose not to share —
 * insisting again later in the flow would be worse than a topicless match.
 */
function topicEverAsked(history: ChatMessage[]): boolean {
  return history.some((m) => {
    if (m.role !== "assistant") return false;
    const n = normTR(m.content);
    return (
      n.includes("zorlayan") ||
      n.includes("hangi konu") ||
      (n.includes("konu") && m.content.includes("?"))
    );
  });
}

/**
 * Two capitalized words in a row read as a person's name ("Ekin Alankuş
 * kim?") — name lookups legitimately carry no topic, and the intent
 * classifier files them under search_therapist, so exempt them here.
 */
const NAME_PAIR_RE = /\p{Lu}\p{Ll}+\s+\p{Lu}\p{Ll}+/u;

// ─── Age rung (prompt: "çocuk/ergen sinyalinde YAŞ basamağı en öne geçer") ──
// Therapists have hard accept-age ranges; recommending without the age means
// the server-side age elimination silently never ran for a minor.

const CHILD_PHRASES = [
  "cocugum", "oglum", "kizim", "yegenim", "ogrencim",
  "cocuk icin", "ergen icin", "ergenlik",
];

/** "14 yaşında" / "14 yas" style — an age is on the table. */
const AGE_STATED_RE = /\b\d{1,2}\s*ya[şs]/iu;

function ageEverAsked(history: ChatMessage[]): boolean {
  return history.some((m) => {
    if (m.role !== "assistant") return false;
    const n = normTR(m.content);
    return n.includes("kac yasinda") || n.includes("yasi kac");
  });
}

function questionTurnCount(history: ChatMessage[]): number {
  let lastCardsIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant" && hasExpertCards(history[i].content)) {
      lastCardsIdx = i;
      break;
    }
  }
  return history.filter(
    (m, i) =>
      i > lastCardsIdx && m.role === "assistant" && m.content.trim().endsWith("?")
  ).length;
}

/**
 * Decide whether the model skipped a ladder rung it owed the user.
 *
 * Shared preconditions (all must hold before any rung is considered):
 *   • the response shows therapist cards (it committed to an answer)
 *   • the intent is a search (detail/availability flows answer directly)
 *   • the user did not ask to skip ahead
 *   • the ladder has not already burned its 3 question turns
 *
 * Rung selection on what the USER turns actually established:
 *   • online stated            → no rung owed (city is irrelevant online)
 *   • in-person stated, no location → rung 3a: ask the city
 *   • no modality, no location → rung 2: ask the modality
 *   • location given, no modality  → HIZLI KARAR (şehir + problem) → pass
 *
 * Each rung has its own loop breaker: if the previous assistant turn already
 * asked it, the user dodged the question — re-asking would trap them.
 */
export function detectLadderSkip(opts: {
  userMessage: string;
  history: ChatMessage[];
  response: string;
  intent?: IntentResult;
}): LadderSkipResult {
  const { userMessage, history, response, intent } = opts;

  if (!hasExpertCards(response)) return { skipped: false, reason: "no_cards" };
  return owedRung({ userMessage, history, intent });
}

/**
 * The rung the conversation still owes the user, decided BEFORE the model
 * runs — same analysis as detectLadderSkip minus the cards precondition.
 * Returns `skipped: true, missingRung` when a rung is owed (the caller
 * steers the model toward asking it), `skipped: false, reason` otherwise.
 */
export function nextOwedRung(opts: {
  userMessage: string;
  history: ChatMessage[];
  intent?: IntentResult;
}): LadderSkipResult {
  return owedRung(opts);
}

function owedRung(opts: {
  userMessage: string;
  history: ChatMessage[];
  intent?: IntentResult;
}): LadderSkipResult {
  const { userMessage, history, intent } = opts;

  if (intent && EXEMPT_INTENTS.has(intent.intent)) {
    return { skipped: false, reason: `exempt_intent:${intent.intent}` };
  }

  const userTurns = [
    ...history.filter((m) => m.role === "user").map((m) => m.content),
    userMessage,
  ];
  const conversation = normTR(userTurns.join(" "));

  if (containsAny(conversation, SPEED_PHRASES)) {
    return { skipped: false, reason: "user_wants_speed" };
  }
  if (questionTurnCount(history) >= MAX_QUESTION_TURNS) {
    return { skipped: false, reason: "question_budget_spent" };
  }

  // ── Age rung — age is an elimination criterion for EVERYONE ──────────────
  // Therapists carry hard accept-age ranges in both directions (child-only
  // AND adult caps like 24/30/35), so cards without an age mean the server's
  // age elimination never ran. Child signal puts the rung before topic
  // (prompt: "çocuk/ergen sinyalinde YAŞ en öne geçer"); adult flows get it
  // after topic. Name lookups are exempt; a dodge falls through.
  const rawUserTextForAge = userTurns.join("\n");
  const isNameLookup = NAME_PAIR_RE.test(rawUserTextForAge);
  const ageStated =
    AGE_STATED_RE.test(rawUserTextForAge) ||
    (ageEverAsked(history) && userTurns.some((t) => /\b\d{1,2}\b/.test(t)));
  const ageOwed = !ageStated && !ageEverAsked(history) && !isNameLookup;
  const childSignal = containsAny(conversation, CHILD_PHRASES);
  if (childSignal && ageOwed) {
    return { skipped: true, missingRung: "age" };
  }

  // ── Rung 1: topic ─────────────────────────────────────────────────────────
  // Seen live: model showed cards after modality+city with no topic ever
  // given ("konu belirtmediğin için genel başvuruda öne çıkan 3 isim…") —
  // no topic means no specialty scoring, an empty Eşleşme block and an
  // ungrounded rationale. The guard itself used to institutionalize this:
  // its rung set started at modality, so its own rescue question steered
  // conversations into the topicless route. Topic is checked on the raw
  // (unnormalized) turns — extractUserTopics/extractUserRequest normalize
  // internally, and the name-pair exemption needs original capitalization.
  // "Çocuğum için" maps to the ergen topic in extractUserTopics, but it says
  // WHO the therapy is for, not WHAT it is about — seen live: the ladder
  // treated the child flow's topic as known and jumped to modality.
  const topicsOf = (text: string): string[] =>
    extractUserTopics(text).filter((t) => !(t === "ergen" && childSignal));
  const rawUserText = userTurns.join("\n");
  if (
    topicsOf(rawUserText).length === 0 &&
    !extractUserRequest(rawUserText).approach &&
    !NAME_PAIR_RE.test(rawUserText)
  ) {
    if (!topicEverAsked(history)) {
      return { skipped: true, missingRung: "topic" };
    }
    // Asked and dodged — fall through to the modality/city rungs.
  }

  // ── Rung 2: age for everyone else (adult flows, after topic) ─────────────
  if (ageOwed) {
    return { skipped: true, missingRung: "age" };
  }

  // A name lookup ("Ekin Alankuş kim?") is answered directly — no modality
  // or city is owed. Without this the pre-steer would send the model off to
  // ask "online mı yüz yüze mi?" instead of saying who the person is.
  if (isNameLookup) {
    return { skipped: false, reason: "name_lookup" };
  }

  const saidOnline = containsAny(conversation, ONLINE_PHRASES);
  const saidInPerson = containsAny(conversation, IN_PERSON_PHRASES);
  const gaveLocation = userTurns.some((t) => mentionsLocation(t));

  // The "already asked last turn" loop breakers assume the user dodged the
  // question. If this turn answered a DIFFERENT rung instead (gave the topic
  // or the age), nothing was dodged — the rung is still owed. Seen live in
  // the child flow: modality asked, user supplied the topic, cards shown
  // with no modality.
  const answeredOtherRung =
    topicsOf(userMessage).length > 0 ||
    AGE_STATED_RE.test(userMessage) ||
    /^\s*\d{1,2}\s*$/.test(userMessage);

  if (saidOnline) {
    return { skipped: false, reason: "modality_online" };
  }

  if (saidInPerson) {
    if (gaveLocation) return { skipped: false, reason: "in_person_with_location" };
    if (!answeredOtherRung && lastTurnAsked(history, "city")) {
      return { skipped: false, reason: "city_already_asked" };
    }
    return { skipped: true, missingRung: "city" };
  }

  if (gaveLocation) {
    // City + problem without an explicit modality is a HIZLI KARAR case —
    // the prompt allows going straight to results.
    return { skipped: false, reason: "location_given" };
  }
  if (!answeredOtherRung && lastTurnAsked(history, "modality")) {
    return { skipped: false, reason: "modality_already_asked" };
  }
  return { skipped: true, missingRung: "modality" };
}
