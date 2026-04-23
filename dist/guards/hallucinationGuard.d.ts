/**
 * Hallucination guard — verifies every therapist name / username in a response
 * corresponds to a real therapist from the Planda API.
 *
 * Operates in ANNOTATE mode: never mutates the response, only returns
 * violations. Callers log them; future work can add a retry loop.
 */
export interface HallucinationViolation {
    kind: "unknown_therapist" | "unknown_username";
    value: string;
}
/**
 * Scan a response for therapist names (**Name** — headers) and expert tags.
 * Returns any that don't correspond to real therapists.
 *
 * NOTE: This runs AFTER postProcessResponse, which already fixes misspelled
 * names where a fuzzy match exists. Surviving violations are true hallucinations.
 */
export declare function verifyResponse(text: string): Promise<HallucinationViolation[]>;
//# sourceMappingURL=hallucinationGuard.d.ts.map