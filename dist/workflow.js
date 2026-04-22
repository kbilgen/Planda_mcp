/**
 * Planda Assistant — Workflow
 *
 * ANTHROPIC_API_KEY set → Claude (claude-haiku-4-5-20251001 default)
 * Otherwise            → OpenAI Agents SDK (gpt-4.1-mini default)
 */
import Anthropic from "@anthropic-ai/sdk";
import { OpenAI } from "openai";
import { runGuardrails } from "@openai/guardrails";
import { SYSTEM_PROMPT } from "./prompts.js";
import { makeApiRequest } from "./services/apiClient.js";
// ─── Guardrails (OpenAI moderation — optional) ────────────────────────────────
const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "placeholder" });
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
        const results = (await runGuardrails(text, GUARDRAILS_CONFIG, { guardrailLlm: openaiClient }, true));
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
function toolStatusMessage(name) {
    switch (name) {
        case "find_therapists": return "Terapistler aranıyor...";
        case "get_therapist": return "Terapist profili inceleniyor...";
        case "get_therapist_hours": return "Müsait saatler kontrol ediliyor...";
        case "get_therapist_available_days": return "Müsait günler kontrol ediliyor...";
        case "list_specialties": return "Uzmanlık alanları yükleniyor...";
        default: return "Bilgiler alınıyor...";
    }
}
// ─── Claude path ──────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "placeholder" });
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
const CLAUDE_TOOLS = [
    {
        name: "find_therapists",
        description: `Search licensed therapists from Planda (planda.org). Call this FIRST for any therapist search.
Trigger: user asks for a therapist, mentions anxiety/depression/trauma/burnout/relationship issues or any mental health struggle.
Fetch first — filter AI-side. Use per_page=500 to get the full catalogue.
Server-side filter: city (in-person only). All others (gender, price, specialty, online) filter AI-side.
⚠️ NEVER suggest therapist names not returned by this tool.`,
        input_schema: {
            type: "object",
            properties: {
                city: { type: "string", description: "City name for in-person sessions (e.g. İstanbul). Omit for online." },
                page: { type: "number", description: "Page number (default 1)" },
                per_page: { type: "number", description: "Results per page. Use 500 for full catalogue." },
            },
        },
    },
    {
        name: "get_therapist",
        description: `Fetch full profile of a single therapist by ID.
⚠️ MANDATORY for approach queries (BDT, EMDR, ACT, Schema, Gestalt etc.):
  - Call for EVERY candidate
  - approaches[].name does NOT contain the requested method → EXCLUDE
  - approaches[] empty/null or call fails → EXCLUDE, never guess`,
        input_schema: {
            type: "object",
            properties: {
                id: { type: ["string", "number"], description: "Therapist unique ID" },
            },
            required: ["id"],
        },
    },
    {
        name: "list_specialties",
        description: "Returns all therapy specialty categories from Planda. Use when unsure of exact specialty names.",
        input_schema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "get_therapist_available_days",
        description: `Returns dates a therapist has open slots at a specific branch.
Call this when user specifies a day (cumartesi, pazartesi etc.) in a therapist search.
Check returned dates to see which fall on the requested day — only recommend therapists with that day available.`,
        input_schema: {
            type: "object",
            properties: {
                therapist_id: { type: ["string", "number"], description: "Therapist ID" },
                branch_id: { type: ["string", "number"], description: "Branch ID from branches[]" },
            },
            required: ["therapist_id", "branch_id"],
        },
    },
    {
        name: "get_therapist_hours",
        description: "Returns available appointment slots for a therapist on a specific date.",
        input_schema: {
            type: "object",
            properties: {
                therapist_id: { type: ["string", "number"], description: "Therapist ID" },
                date: { type: "string", description: "Date in YYYY-MM-DD format" },
                branch_id: { type: ["string", "number"], description: "Branch ID (optional)" },
                service_id: { type: ["string", "number"], description: "Service ID (optional)" },
            },
            required: ["therapist_id", "date"],
        },
    },
];
async function executeTool(name, input) {
    try {
        switch (name) {
            case "find_therapists": {
                const q = { page: input.page ?? 1, per_page: input.per_page ?? 50 };
                if (input.city)
                    q.city = input.city;
                return JSON.stringify(await makeApiRequest("marketplace/therapists", "GET", undefined, q));
            }
            case "get_therapist":
                return JSON.stringify(await makeApiRequest(`marketplace/therapists/${input.id}`));
            case "list_specialties":
                return JSON.stringify(await makeApiRequest("marketplace/specialties"));
            case "get_therapist_hours": {
                const q = { date: input.date };
                if (input.branch_id)
                    q.branch_id = input.branch_id;
                if (input.service_id)
                    q.service_id = input.service_id;
                return JSON.stringify(await makeApiRequest(`marketplace/therapists/${input.therapist_id}/hours`, "GET", undefined, q));
            }
            case "get_therapist_available_days":
                return JSON.stringify(await makeApiRequest(`marketplace/therapists/${input.therapist_id}/branches/${input.branch_id}/days`));
            default:
                return JSON.stringify({ error: `Unknown tool: ${name}` });
        }
    }
    catch (err) {
        return JSON.stringify({ error: String(err) });
    }
}
function toAnthropicMessages(history, current) {
    return [
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: current },
    ];
}
async function runClaudeChat(input) {
    const messages = toAnthropicMessages(input.history, input.message);
    let response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: CLAUDE_TOOLS,
        messages,
    });
    while (response.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: response.content });
        const toolResults = [];
        for (const block of response.content) {
            if (block.type === "tool_use") {
                toolResults.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: await executeTool(block.name, block.input),
                });
            }
        }
        messages.push({ role: "user", content: toolResults });
        response = await anthropic.messages.create({
            model: CLAUDE_MODEL,
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            tools: CLAUDE_TOOLS,
            messages,
        });
    }
    const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    return {
        response: text,
        updatedHistory: [
            ...input.history,
            { role: "user", content: input.message },
            { role: "assistant", content: text },
        ],
    };
}
async function runClaudeChatStream(input, callbacks) {
    const messages = toAnthropicMessages(input.history, input.message);
    let fullText = "";
    while (true) {
        const stream = anthropic.messages.stream({
            model: CLAUDE_MODEL,
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            tools: CLAUDE_TOOLS,
            messages,
        });
        for await (const event of stream) {
            if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
                callbacks.onStatus?.(toolStatusMessage(event.content_block.name));
            }
            else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                callbacks.onDelta?.(event.delta.text);
                fullText += event.delta.text;
            }
        }
        const final = await stream.finalMessage();
        if (final.stop_reason !== "tool_use")
            break;
        messages.push({ role: "assistant", content: final.content });
        const toolResults = [];
        for (const block of final.content) {
            if (block.type === "tool_use") {
                toolResults.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: await executeTool(block.name, block.input),
                });
            }
        }
        messages.push({ role: "user", content: toolResults });
        fullText = ""; // reset — next loop streams the final answer
    }
    return {
        response: fullText,
        updatedHistory: [
            ...input.history,
            { role: "user", content: input.message },
            { role: "assistant", content: fullText },
        ],
    };
}
// ─── OpenAI path (fallback) ───────────────────────────────────────────────────
import { hostedMcpTool, Agent, Runner, withTrace } from "@openai/agents";
const _openaiMcp = hostedMcpTool({
    serverLabel: "Kaan_mcp",
    allowedTools: ["find_therapists", "get_therapist", "list_specialties", "get_therapist_hours", "get_therapist_available_days"],
    requireApproval: "never",
    serverUrl: "https://plandamcp-production.up.railway.app/mcp",
});
const _openaiAgent = new Agent({
    name: "PlandaAssistant",
    instructions: SYSTEM_PROMPT,
    model: (process.env.OPENAI_MODEL ?? "gpt-4.1-mini"),
    tools: [_openaiMcp],
    modelSettings: { store: true },
});
const _openaiRunner = new Runner();
async function runOpenAIChat(input) {
    return withTrace("PlandaChat", async () => {
        const items = [
            ...input.history.map((m) => m.role === "user"
                ? { role: "user", content: m.content }
                : { role: "assistant", status: "completed", content: [{ type: "output_text", text: m.content }] }),
            { role: "user", content: [{ type: "input_text", text: input.message }] },
        ];
        const result = await _openaiRunner.run(_openaiAgent, items);
        const text = result.finalOutput ?? "";
        return {
            response: text,
            updatedHistory: [...input.history, { role: "user", content: input.message }, { role: "assistant", content: text }],
        };
    });
}
// ─── Public API ───────────────────────────────────────────────────────────────
const USE_CLAUDE = Boolean(process.env.ANTHROPIC_API_KEY);
export async function runChat(input) {
    const guard = await checkGuardrails(input.message);
    if (guard.blocked) {
        return {
            response: SAFE_RESPONSE,
            updatedHistory: [...input.history, { role: "user", content: input.message }, { role: "assistant", content: SAFE_RESPONSE }],
        };
    }
    return USE_CLAUDE ? runClaudeChat(input) : runOpenAIChat(input);
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
    if (USE_CLAUDE)
        return runClaudeChatStream(input, callbacks);
    // OpenAI streaming fallback — non-streaming graceful degradation
    const result = await runOpenAIChat(input);
    callbacks.onDelta?.(result.response);
    return result;
}
export const runWorkflow = async (workflow) => {
    const all = workflow.history ?? [];
    const last = all[all.length - 1];
    const history = last?.role === "user" && last?.content === workflow.input_as_text ? all.slice(0, -1) : all;
    const result = await runChat({ message: workflow.input_as_text, history });
    return { output_text: result.response };
};
//# sourceMappingURL=workflow.js.map