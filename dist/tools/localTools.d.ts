/**
 * In-process tool definitions for the chat agent (@openai/agents).
 *
 * Why this exists: workflow.ts historically used hostedMcpTool, which makes
 * OpenAI dial back into our own public /mcp endpoint over the internet for
 * every tool call — an extra network round-trip per call, and a hard
 * dependency on our public URL being reachable mid-deploy. These local tools
 * run the exact same handlers (handlers.ts) inside this process instead.
 *
 * Enabled via USE_LOCAL_TOOLS=1 (see workflow.ts). Default stays hosted MCP
 * so production behaviour is unchanged until the flag is flipped.
 *
 * Design notes:
 *   • Tool names/descriptions are identical to the MCP registrations, so the
 *     model, intent classifier (expectedTools) and guards see no difference.
 *   • Parameters are passed as non-strict JSON Schema (derived from the same
 *     Zod schemas). Validation happens in execute() via Zod safeParse — on
 *     invalid input the model receives an actionable error string and can
 *     self-correct, mirroring MCP's validation-error behaviour.
 *   • execute() returns the handler's markdown text — the same text content
 *     the model received through the hosted MCP path.
 *   • All tools are read-only. If a write tool (e.g. create_appointment) is
 *     ever added, route it through an approval flow (needsApproval) — see the
 *     prompt-injection note in workflow.ts.
 */
type JsonObjectSchema = {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: true;
};
/**
 * Build the in-process tool set for the chat agent.
 *
 * Tool list intentionally mirrors the hosted-MCP `allowedTools` allowlist
 * (find_therapists, get_therapist, list_specialties, get_therapist_hours,
 * get_therapist_available_days) so switching modes never changes what the
 * model can do. get_active_cities stays MCP-only, as before.
 */
export declare function buildLocalTools(): import("@openai/agents").FunctionTool<unknown, JsonObjectSchema, string>[];
export {};
//# sourceMappingURL=localTools.d.ts.map