/**
 * Planda Assistant — Workflow
 *
 * ANTHROPIC_API_KEY set → Claude (claude-haiku-4-5-20251001 default)
 * Otherwise            → OpenAI Agents SDK (gpt-4.1-mini default)
 */
import type { ChatMessage } from "./sessionStore.js";
export interface ChatInput {
    message: string;
    history: ChatMessage[];
}
export interface ChatOutput {
    response: string;
    updatedHistory: ChatMessage[];
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
};
export declare const runWorkflow: (workflow: WorkflowInput) => Promise<{
    output_text: string;
}>;
//# sourceMappingURL=workflow.d.ts.map