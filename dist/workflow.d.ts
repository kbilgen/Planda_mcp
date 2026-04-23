/**
 * Planda Assistant — Workflow (OpenAI Agents SDK)
 */
import type { ChatMessage } from "./sessionStore.js";
import type { ToolCallLog } from "./logger.js";
export interface ChatInput {
    message: string;
    history: ChatMessage[];
    /**
     * When true, the orchestrator will retry once (with a corrective hint)
     * if the model produced a response without calling any tools. Set by
     * callers when the intent classifier detects a specific search where
     * a tool call is required for a grounded answer.
     *
     * Note: this does NOT force toolChoice="required" on the model —
     * that option causes tool-loop hangs because it applies to every
     * step, not just the first. We instead verify post-hoc and retry.
     */
    forceToolCall?: boolean;
}
export interface ChatOutput {
    response: string;
    updatedHistory: ChatMessage[];
    toolCalls?: ToolCallLog[];
    model?: string;
}
export interface ChatStreamCallbacks {
    onStatus?: (message: string) => void;
    onDelta?: (delta: string) => void;
}
export declare function runChat(input: ChatInput): Promise<ChatOutput>;
export declare function runChatStream(input: ChatInput, callbacks: ChatStreamCallbacks): Promise<ChatOutput>;
export type WorkflowInput = {
    input_as_text: string;
    history?: {
        role: "user" | "assistant";
        content: string;
    }[];
    forceToolCall?: boolean;
};
export declare const runWorkflow: (workflow: WorkflowInput) => Promise<{
    output_text: string;
    toolCalls: ToolCallLog[] | undefined;
    model: string | undefined;
}>;
//# sourceMappingURL=workflow.d.ts.map