export type WorkflowInput = {
    input_as_text: string;
};
export declare const runWorkflow: (workflow: WorkflowInput) => Promise<{
    output_text: string;
} | Record<string, unknown>>;
//# sourceMappingURL=workflow.d.ts.map