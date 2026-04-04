/**
 * Planda workflow — Claude API with direct tool execution
 *
 * Uses Anthropic's Claude model (same as Claude Desktop) so the chat UI
 * gives the same quality results as the MCP integration in Claude Desktop.
 */
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