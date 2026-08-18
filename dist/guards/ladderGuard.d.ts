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
/**
 * Static fallback questions, one per rung. The caller first tries to have
 * the model phrase the rung naturally (a real conversational turn that
 * acknowledges what the user just said); these fire only when that attempt
 * fails. Both end with "?" so clarifying-question heuristics downstream
 * (workflow.ts's isClarifyingQuestion) read them correctly.
 */
export declare const LADDER_TOPIC_QUESTION: string;
export declare const LADDER_MODALITY_QUESTION: string;
export declare const LADDER_CITY_QUESTION: string;
export type LadderRung = "topic" | "modality" | "city";
export interface LadderSkipResult {
    /** True when the model showed cards but owed the user a question first. */
    skipped: boolean;
    /** Which rung the user was never walked up — set when skipped. */
    missingRung?: LadderRung;
    /** Why the check passed — for logs when nothing was flagged. */
    reason?: string;
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
export declare function detectLadderSkip(opts: {
    userMessage: string;
    history: ChatMessage[];
    response: string;
    intent?: IntentResult;
}): LadderSkipResult;
//# sourceMappingURL=ladderGuard.d.ts.map