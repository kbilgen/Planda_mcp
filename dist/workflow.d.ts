export type WorkflowInput = {
    input_as_text: string;
    history?: {
        role: "user" | "assistant";
        content: string;
    }[];
};
export declare const runWorkflow: (workflow: WorkflowInput) => Promise<{
    output_text: string;
}>;
//# sourceMappingURL=workflow.d.ts.map