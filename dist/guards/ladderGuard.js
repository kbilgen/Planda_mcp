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
import { mentionsLocation } from "../services/locationNormalizer.js";
/**
 * Static fallback questions, one per rung. The caller first tries to have
 * the model phrase the rung naturally (a real conversational turn that
 * acknowledges what the user just said); these fire only when that attempt
 * fails. Both end with "?" so clarifying-question heuristics downstream
 * (workflow.ts's isClarifyingQuestion) read them correctly.
 */
export const LADDER_MODALITY_QUESTION = "Sana en uygun ismi bulabilmem için tek bir şey daha sorayım: " +
    "görüşmeleri online mı yoksa yüz yüze mi yapmayı tercih edersin?";
export const LADDER_CITY_QUESTION = "Yüz yüze görüşmek istediğini not ettim. Sana yakın bir terapist " +
    "önerebilmem için hangi şehirde olduğunu söyler misin?";
function normTR(s) {
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
/** The prompt caps the ladder at 3 question turns (prompts.ts "Kurallar"). */
const MAX_QUESTION_TURNS = 3;
function hasExpertCards(response) {
    return /\[\[expert:[^\]]+\]\]/.test(response);
}
function containsAny(normalized, phrases) {
    return phrases.some((p) => normalized.includes(p));
}
/**
 * Did the assistant's most recent turn already ask about this rung? If so
 * the user has been asked and either answered ambiguously or ignored it —
 * asking again would loop. Let the response through.
 */
function lastTurnAsked(history, rung) {
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role !== "assistant")
            continue;
        const n = normTR(history[i].content);
        if (rung === "modality") {
            return n.includes("online") && (n.includes("yuz yuze") || n.includes("yuzyuze"));
        }
        return n.includes("sehir") || n.includes("nerede");
    }
    return false;
}
function questionTurnCount(history) {
    return history.filter((m) => m.role === "assistant" && m.content.trim().endsWith("?")).length;
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
export function detectLadderSkip(opts) {
    const { userMessage, history, response, intent } = opts;
    if (!hasExpertCards(response))
        return { skipped: false, reason: "no_cards" };
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
    const saidOnline = containsAny(conversation, ONLINE_PHRASES);
    const saidInPerson = containsAny(conversation, IN_PERSON_PHRASES);
    const gaveLocation = userTurns.some((t) => mentionsLocation(t));
    if (saidOnline) {
        return { skipped: false, reason: "modality_online" };
    }
    if (saidInPerson) {
        if (gaveLocation)
            return { skipped: false, reason: "in_person_with_location" };
        if (lastTurnAsked(history, "city")) {
            return { skipped: false, reason: "city_already_asked" };
        }
        return { skipped: true, missingRung: "city" };
    }
    if (gaveLocation) {
        // City + problem without an explicit modality is a HIZLI KARAR case —
        // the prompt allows going straight to results.
        return { skipped: false, reason: "location_given" };
    }
    if (lastTurnAsked(history, "modality")) {
        return { skipped: false, reason: "modality_already_asked" };
    }
    return { skipped: true, missingRung: "modality" };
}
//# sourceMappingURL=ladderGuard.js.map