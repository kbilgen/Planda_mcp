/**
 * Ladder guard — catches the model skipping a SORU MERDİVENİ rung.
 *
 * The system prompt (prompts.ts, "SORU MERDİVENİ") walks the user up a fixed
 * question ladder before showing results: topic → modality → city. HIZLI KARAR
 * lets the model jump straight to results only when the message already
 * carries enough (city + problem, or an explicit online request).
 *
 * Prod incident this was written for:
 *   user: "Kendim için psikolog arıyorum"
 *   bot:  "Seni en çok zorlayan konu ne?"          ← rung 1, correct
 *   user: "aksiyete"
 *   bot:  "…online ya da İstanbul'da uygun 3 terapist" + cards
 *
 * Rung 2 (online vs yüz yüze) was never asked, and no HIZLI KARAR condition
 * held — so the model invented BOTH the modality and the city. Inventing a
 * city also violates ŞEHİR KURALI ("kullanıcı şehir belirtmediyse ASLA şehir
 * tahmin etme"), and nothing in the guard stack was watching for it:
 * workflow.ts's isClarifyingQuestion checks the mirror case (model asked a
 * question when it should have called a tool), never this direction.
 *
 * This guard is the missing half. It is deliberately conservative — it only
 * fires when the model showed CARDS while the conversation is genuinely
 * missing the location/modality rung, and every ambiguity resolves to
 * letting the response through.
 */
import { mentionsLocation } from "../services/locationNormalizer.js";
/**
 * Asked when the model jumped to results without establishing modality.
 * Ends with "?" so downstream clarifying-question heuristics (workflow.ts's
 * isClarifyingQuestion, which gates the tool-miss retry) read it correctly.
 */
export const LADDER_MODALITY_QUESTION = "Sana en uygun ismi bulabilmem için tek bir şey daha sorayım: " +
    "görüşmeleri online mı yoksa yüz yüze mi yapmayı tercih edersin?";
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
/** Phrases that state a session-modality preference either way. */
const MODALITY_PHRASES = [
    "online", "cevrimici", "cevrim ici", "uzaktan", "goruntulu", "video",
    "yuz yuze", "yuzyuze", "yuz yuze", "fiziksel", "klinik", "ofis", "yerinde",
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
 * Did the assistant's most recent turn already ask the modality question?
 * If so the user has been asked and either answered ambiguously or ignored
 * it — asking again would loop. Let the response through.
 */
function lastTurnAskedModality(history) {
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role !== "assistant")
            continue;
        const n = normTR(history[i].content);
        return n.includes("online") && (n.includes("yuz yuze") || n.includes("yuzyuze"));
    }
    return false;
}
function questionTurnCount(history) {
    return history.filter((m) => m.role === "assistant" && m.content.trim().endsWith("?")).length;
}
/**
 * Decide whether the model skipped a ladder rung it owed the user.
 *
 * Flags only when ALL of these hold:
 *   1. the response shows therapist cards (it committed to an answer)
 *   2. the intent is a search (detail/availability flows answer directly)
 *   3. no user turn ever stated a modality preference
 *   4. no user turn ever named a location (city, district or semt)
 *   5. the user did not ask to skip ahead
 *   6. the ladder has not already burned its 3 question turns
 *   7. the previous assistant turn was not itself the modality question
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
    if (containsAny(conversation, MODALITY_PHRASES)) {
        return { skipped: false, reason: "modality_given" };
    }
    if (userTurns.some((t) => mentionsLocation(t))) {
        return { skipped: false, reason: "location_given" };
    }
    if (containsAny(conversation, SPEED_PHRASES)) {
        return { skipped: false, reason: "user_wants_speed" };
    }
    if (questionTurnCount(history) >= MAX_QUESTION_TURNS) {
        return { skipped: false, reason: "question_budget_spent" };
    }
    if (lastTurnAskedModality(history)) {
        return { skipped: false, reason: "modality_already_asked" };
    }
    return { skipped: true };
}
//# sourceMappingURL=ladderGuard.js.map