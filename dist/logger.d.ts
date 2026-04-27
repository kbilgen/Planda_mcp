/**
 * Planda Assistant — Structured conversation logger
 *
 * Writes one JSON object per turn to `logs/conversations.jsonl`.
 * Also emits a one-line summary to stdout for Railway log capture.
 *
 * Disable with LOG_CONVERSATIONS=0. Override path with CONVERSATION_LOG_PATH.
 */
export interface ToolCallLog {
    name: string;
    arguments: string;
    output?: string;
    durationMs?: number;
}
export interface GuardViolation {
    kind: "unknown_therapist" | "unknown_username" | "intent_mismatch" | "specialty_mismatch" | "other";
    detail: string;
}
export interface TurnLog {
    ts: string;
    sessionId: string;
    /** Planda user id from auth token — only present on authenticated endpoints. */
    userId?: string;
    userMessage: string;
    response: string;
    toolCalls: ToolCallLog[];
    latencyMs: number;
    model?: string;
    endpoint?: string;
    guardrailsBlocked?: boolean;
    intent?: string;
    violations?: GuardViolation[];
    error?: string;
}
export declare function logTurn(turn: TurnLog): Promise<void>;
/**
 * Extract tool calls from @openai/agents Runner result.
 *
 * Defensive: the Runner result exposes tool calls via multiple shapes depending
 * on the tool type (function_call, mcp_call, hosted_tool_call_item, etc) AND
 * multiple locations (newItems, history, state._generatedItems). We probe all
 * of them and match any item that carries `name + arguments` as a tool call.
 *
 * Set DEBUG_TOOL_CALLS=1 to log raw item types to stdout for diagnosis.
 */
export declare function extractToolCalls(result: unknown): ToolCallLog[];
//# sourceMappingURL=logger.d.ts.map