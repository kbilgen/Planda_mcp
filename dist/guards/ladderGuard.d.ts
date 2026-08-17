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
import type { ChatMessage } from "../sessionStore.js";
import type { IntentResult } from "./intentClassifier.js";
/**
 * Asked when the model jumped to results without establishing modality.
 * Ends with "?" so downstream clarifying-question heuristics (workflow.ts's
 * isClarifyingQuestion, which gates the tool-miss retry) read it correctly.
 */
export declare const LADDER_MODALITY_QUESTION: string;
export interface LadderSkipResult {
    /** True when the model showed cards but owed the user a question first. */
    skipped: boolean;
    /** Why the check passed — for logs when nothing was flagged. */
    reason?: string;
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
export declare function detectLadderSkip(opts: {
    userMessage: string;
    history: ChatMessage[];
    response: string;
    intent?: IntentResult;
}): LadderSkipResult;
//# sourceMappingURL=ladderGuard.d.ts.map