/**
 * Planda Assistant — Agent & Workflow
 *
 * OpenAI Agents SDK kullanarak terapist eşleştirme akışını çalıştırır.
 * Guardrails (moderation) input üzerinde uygulanır.
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
export declare function runChat(input: ChatInput): Promise<ChatOutput>;
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