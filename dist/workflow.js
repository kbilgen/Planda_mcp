/**
 * Planda Assistant — Workflow (OpenAI Agents SDK)
 */
import { OpenAI } from "openai";
import { runGuardrails } from "@openai/guardrails";
import { hostedMcpTool, Agent, Runner, withTrace } from "@openai/agents";
import { SYSTEM_PROMPT } from "./prompts.js";
import { extractToolCalls } from "./logger.js";
// ─── Guardrails (optional — skipped if OPENAI_API_KEY missing) ───────────────
let _guardrailsClient = null;
function getGuardrailsClient() {
    if (!_guardrailsClient)
        _guardrailsClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _guardrailsClient;
}
const GUARDRAILS_CONFIG = {
    guardrails: [
        {
            name: "Moderation",
            config: {
                categories: [
                    "sexual/minors",
                    "hate/threatening",
                    "harassment/threatening",
                    "self-harm/instructions",
                    "violence/graphic",
                    "illicit/violent",
                ],
            },
        },
    ],
};
async function checkGuardrails(text) {
    if (!process.env.OPENAI_API_KEY)
        return { blocked: false };
    try {
        const results = (await runGuardrails(text, GUARDRAILS_CONFIG, { guardrailLlm: getGuardrailsClient() }, true));
        const blocked = results.some((r) => r.tripwireTriggered === true);
        if (!blocked)
            return { blocked: false };
        const flagged = results.flatMap((r) => r.info?.flagged_categories ?? []).join(", ");
        return { blocked: true, reason: flagged || "content policy violation" };
    }
    catch {
        return { blocked: false };
    }
}
const SAFE_RESPONSE = "Bu konuda sana yardımcı olamıyorum. Uygun bir terapist bulmak için buradayım — devam edelim mi?";
const CHAT_TIMEOUT_MS = parseInt(process.env.CHAT_TIMEOUT_MS ?? "90000", 10);
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Chat timed out after ${ms}ms`)), ms)),
    ]);
}
// ─── OpenAI Agents path ───────────────────────────────────────────────────────
let _openaiAgent = null;
let _openaiRunner = null;
function getOpenAIAgent() {
    if (!_openaiAgent) {
        const mcp = hostedMcpTool({
            serverLabel: "Kaan_mcp",
            allowedTools: ["find_therapists", "get_therapist", "list_specialties", "get_therapist_hours", "get_therapist_available_days"],
            requireApproval: "never",
            serverUrl: process.env.MCP_SERVER_URL ?? "https://plandamcp-production.up.railway.app/mcp",
        });
        _openaiAgent = new Agent({
            name: "PlandaAssistant",
            instructions: SYSTEM_PROMPT,
            model: (process.env.OPENAI_MODEL ?? "gpt-4.1-mini"),
            tools: [mcp],
            modelSettings: { store: true },
        });
    }
    return _openaiAgent;
}
function getOpenAIRunner() {
    if (!_openaiRunner)
        _openaiRunner = new Runner();
    return _openaiRunner;
}
// Forced runner — used when the intent classifier signals that the current
// message REQUIRES a tool call (e.g. specific therapist search with city +
// specialty). Prevents the model from answering from memory/context.
let _openaiRunnerForced = null;
function getOpenAIRunnerForced() {
    if (!_openaiRunnerForced) {
        _openaiRunnerForced = new Runner({
            modelSettings: { toolChoice: "required" },
        });
    }
    return _openaiRunnerForced;
}
async function runOpenAIChat(input) {
    return withTrace("PlandaChat", async () => {
        const items = [
            ...input.history.map((m) => m.role === "user"
                ? { role: "user", content: m.content }
                : { role: "assistant", status: "completed", content: [{ type: "output_text", text: m.content }] }),
            { role: "user", content: [{ type: "input_text", text: input.message }] },
        ];
        const runner = input.forceToolCall ? getOpenAIRunnerForced() : getOpenAIRunner();
        const result = await runner.run(getOpenAIAgent(), items);
        const text = String(result.finalOutput ?? "");
        const toolCalls = extractToolCalls(result);
        // Diagnostic: full key dump of raw items to identify hosted MCP tool name
        // field. Toggle via DEBUG_TOOL_CALLS=1.
        if (process.env.DEBUG_TOOL_CALLS === "1") {
            const probe = {
                extracted: toolCalls.length,
                newItems: Array.isArray(result.newItems)
                    ? result.newItems.slice(0, 6).map((i) => {
                        const w = i;
                        const r = w.rawItem ?? {};
                        return {
                            wType: w.type,
                            rType: r.type,
                            rName: r.name,
                            rKeys: Object.keys(r),
                            rSample: JSON.stringify(r).slice(0, 400),
                        };
                    })
                    : null,
            };
            console.log("[workflow] raw probe:", JSON.stringify(probe));
        }
        const model = (process.env.OPENAI_MODEL ?? "gpt-4.1-mini");
        return {
            response: text,
            updatedHistory: [...input.history, { role: "user", content: input.message }, { role: "assistant", content: text }],
            toolCalls,
            model,
        };
    });
}
// ─── Public API ───────────────────────────────────────────────────────────────
export async function runChat(input) {
    const guard = await checkGuardrails(input.message);
    if (guard.blocked) {
        return {
            response: SAFE_RESPONSE,
            updatedHistory: [...input.history, { role: "user", content: input.message }, { role: "assistant", content: SAFE_RESPONSE }],
        };
    }
    return withTimeout(runOpenAIChat(input), CHAT_TIMEOUT_MS);
}
export async function runChatStream(input, callbacks) {
    const guard = await checkGuardrails(input.message);
    if (guard.blocked) {
        callbacks.onDelta?.(SAFE_RESPONSE);
        return {
            response: SAFE_RESPONSE,
            updatedHistory: [...input.history, { role: "user", content: input.message }, { role: "assistant", content: SAFE_RESPONSE }],
        };
    }
    const result = await withTimeout(runOpenAIChat(input), CHAT_TIMEOUT_MS);
    callbacks.onDelta?.(result.response);
    return result;
}
export const runWorkflow = async (workflow) => {
    const all = workflow.history ?? [];
    const last = all[all.length - 1];
    const history = last?.role === "user" && last?.content === workflow.input_as_text ? all.slice(0, -1) : all;
    const result = await runChat({
        message: workflow.input_as_text,
        history,
        forceToolCall: workflow.forceToolCall,
    });
    return {
        output_text: result.response,
        toolCalls: result.toolCalls,
        model: result.model,
    };
};
//# sourceMappingURL=workflow.js.map