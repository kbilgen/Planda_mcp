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
        // requireApproval: "never" yalnızca tüm allowedTools read-only olduğu
        // için güvenli. Yan etkili bir tool eklenirse (ör. create_appointment,
        // cancel_appointment) object-form'a geçirin ki yazma çağrıları kullanıcı
        // onayı gerektirsin — aksi hâlde prompt injection ile onaysız tetiklenebilir:
        //   requireApproval: {
        //     always: { tool_names: ["create_appointment", "cancel_appointment"] },
        //     never:  { tool_names: ["find_therapists", "get_therapist", ...] },
        //   }
        const mcp = hostedMcpTool({
            serverLabel: "Kaan_mcp",
            allowedTools: ["find_therapists", "get_therapist", "get_therapist_by_username", "list_specialties", "get_therapist_hours", "get_therapist_available_days"],
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
const MAX_TURNS = parseInt(process.env.AGENT_MAX_TURNS ?? "8", 10);
/**
 * Heuristic — did the model respond with a clarifying question rather than
 * an answer? Used to decide whether a "no tool called" response is a real
 * miss (retry) or an expected flow (ask for more info).
 */
function isClarifyingQuestion(text) {
    const trimmed = text.trim();
    if (trimmed.endsWith("?"))
        return true;
    const lower = trimmed.toLowerCase();
    const clarifiers = [
        "paylaşabilir", "paylasabilir",
        "söyleyebilir", "soyleyebilir",
        "hangi konu", "hangi şehir", "hangi sehir",
        "kimin için", "kimin icin",
        "kaç yaş", "kac yas",
        "online mi", "yüz yüze mi", "yuz yuze mi",
    ];
    return clarifiers.some((p) => lower.includes(p));
}
function buildAgentInput(history, userMessage) {
    return [
        ...history.map((m) => m.role === "user"
            ? { role: "user", content: m.content }
            : { role: "assistant", status: "completed", content: [{ type: "output_text", text: m.content }] }),
        { role: "user", content: [{ type: "input_text", text: userMessage }] },
    ];
}
function debugProbe(result, extractedCount) {
    if (process.env.DEBUG_TOOL_CALLS !== "1")
        return;
    const probe = {
        extracted: extractedCount,
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
async function runOpenAIChat(input) {
    return withTrace("PlandaChat", async () => {
        const runner = getOpenAIRunner();
        const agent = getOpenAIAgent();
        const model = (process.env.OPENAI_MODEL ?? "gpt-4.1-mini");
        // ── First pass ────────────────────────────────────────────────────────────
        const firstItems = buildAgentInput(input.history, input.message);
        const firstResult = await runner.run(agent, firstItems, { maxTurns: MAX_TURNS });
        const firstText = String(firstResult.finalOutput ?? "");
        const firstToolCalls = extractToolCalls(firstResult);
        debugProbe(firstResult, firstToolCalls.length);
        // ── Tool-miss retry (1-shot, bounded) ────────────────────────────────────
        // Trigger conditions (all must hold):
        //   1. Caller signalled forceToolCall (classifier saw a specific search)
        //   2. Model did not call any tools
        //   3. Response isn't a clarifying question (those are legitimate)
        //
        // Retry injects a corrective "internal note" as a user turn — stronger
        // than prompt-level hints because it arrives in the conversation context.
        // Max 1 retry to bound latency.
        const shouldRetry = input.forceToolCall === true &&
            firstToolCalls.length === 0 &&
            !isClarifyingQuestion(firstText);
        if (shouldRetry) {
            const retryItems = [
                ...firstItems,
                { role: "assistant", status: "completed", content: [{ type: "output_text", text: firstText }] },
                {
                    role: "user",
                    content: [{
                            type: "input_text",
                            text: "[Sistem notu: Kullanıcının isteğine yanıt vermek için " +
                                "find_therapists (veya uygun başka bir tool) çağrısı yapmalısın. " +
                                "Bilgiden cevap üretme — önce API'den gerçek veriyi çek, sonra yanıtla.]",
                        }],
                },
            ];
            try {
                const retryResult = await runner.run(agent, retryItems, { maxTurns: MAX_TURNS });
                const retryText = String(retryResult.finalOutput ?? firstText);
                const retryToolCalls = extractToolCalls(retryResult);
                debugProbe(retryResult, retryToolCalls.length);
                if (retryToolCalls.length > 0) {
                    // Retry successfully called tools — use its output
                    console.log(`[workflow] tool-miss retry succeeded (${retryToolCalls.length} tools)`);
                    return {
                        response: retryText,
                        updatedHistory: [
                            ...input.history,
                            { role: "user", content: input.message },
                            { role: "assistant", content: retryText },
                        ],
                        toolCalls: retryToolCalls,
                        model,
                    };
                }
                console.warn("[workflow] tool-miss retry still produced no tool calls — using first result");
            }
            catch (err) {
                console.error("[workflow] tool-miss retry failed:", err);
            }
        }
        return {
            response: firstText,
            updatedHistory: [
                ...input.history,
                { role: "user", content: input.message },
                { role: "assistant", content: firstText },
            ],
            toolCalls: firstToolCalls,
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