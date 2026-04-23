/**
 * Lightweight intent classifier — keyword-based, zero latency.
 *
 * Used to annotate conversation logs and detect "tool call expected but missing"
 * regressions (e.g. therapist search intent without find_therapists call).
 */
export type Intent = "search_therapist" | "check_availability" | "therapist_detail" | "list_specialties" | "greeting" | "out_of_scope" | "clarification" | "explanation_request" | "unknown";
export interface IntentResult {
    intent: Intent;
    expectedTools: string[];
    matched: string[];
}
export declare function classifyIntent(message: string): IntentResult;
/**
 * Returns true when the classifier is confident a tool call is required —
 * used to flip Runner.modelSettings.toolChoice to "required" for this turn.
 *
 * Only fires for search/availability intents with enough context; vague
 * searches ("terapi arıyorum") are left on auto so the model can ask
 * clarifying questions.
 */
export declare function shouldForceToolCall(intent: IntentResult): boolean;
/**
 * Returns violations when expected tools were not called.
 *
 * Ignores the mismatch when the assistant responded with a clarifying question
 * (ends with "?" or contains a common Turkish clarifier) — asking for more info
 * before searching is a legitimate flow per the system prompt.
 */
export declare function detectIntentToolMismatch(intent: IntentResult, actualToolCalls: string[], response?: string): string[];
//# sourceMappingURL=intentClassifier.d.ts.map