export type WorkflowInput = {
    input_as_text: string;
    history?: {
        role: "user" | "assistant";
        content: string;
    }[];
};
export declare const runWorkflow: (workflow: WorkflowInput) => Promise<{
    pii: {
        failed: boolean;
        detected_counts: string[];
    };
    moderation: {
        failed: boolean;
        flagged_categories: unknown[] | undefined;
    };
    jailbreak: {
        failed: boolean;
    };
    hallucination: {
        failed: boolean;
        reasoning: unknown;
        hallucination_type: unknown;
        hallucinated_statements: unknown;
        verified_statements: unknown;
    };
    nsfw: {
        failed: boolean;
    };
    url_filter: {
        failed: boolean;
    };
    custom_prompt_check: {
        failed: boolean;
    };
    prompt_injection: {
        failed: boolean;
    };
} | {
    output_text: string;
}>;
//# sourceMappingURL=workflow.d.ts.map