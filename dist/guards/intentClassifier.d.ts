/**
 * Lightweight intent classifier — keyword-based, zero latency.
 *
 * Used to annotate conversation logs and detect "tool call expected but missing"
 * regressions (e.g. therapist search intent without find_therapists call).
 */
export type Intent = "search_therapist" | "check_availability" | "therapist_detail" | "list_specialties" | "greeting" | "out_of_scope" | "clarification" | "unknown";
export interface IntentResult {
    intent: Intent;
    expectedTools: string[];
    matched: string[];
}
export declare function classifyIntent(message: string): IntentResult;
/** Returns violations when expected tools were not called. */
export declare function detectIntentToolMismatch(intent: IntentResult, actualToolCalls: string[]): string[];
//# sourceMappingURL=intentClassifier.d.ts.map