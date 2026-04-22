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
import { findTherapists, getTherapist, listSpecialties, getTherapistHours, getTherapistAvailableDays, } from "./services/therapistApi.js";
// ─── Guardrails (OpenAI moderation — optional) ────────────────────────────────
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
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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
            case "find_therapists":
                return JSON.stringify(await findTherapists({
                    page: input.page,
                    per_page: input.per_page,
                    city: input.city,
                }));
            case "get_therapist":
                return JSON.stringify(await getTherapist(input.id));
            case "list_specialties":
                return JSON.stringify(await listSpecialties());
            case "get_therapist_hours":
                return JSON.stringify(await getTherapistHours({
                    therapist_id: input.therapist_id,
                    date: input.date,
                    branch_id: input.branch_id,
                    service_id: input.service_id,
                }));
            case "get_therapist_available_days":
                return JSON.stringify(await getTherapistAvailableDays({
                    therapist_id: input.therapist_id,
                    branch_id: input.branch_id,
                }));
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
const MAX_TOOL_ROUNDS = 10;
async function runClaudeChat(input) {
    const messages = toAnthropicMessages(input.history, input.message);
    let response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: CLAUDE_TOOLS,
        messages,
    });
    let toolRounds = 0;
    while (response.stop_reason === "tool_use") {
        if (++toolRounds > MAX_TOOL_ROUNDS)
            throw new Error("Tool call limit exceeded");
        messages.push({ role: "assistant", content: response.content });
        const toolBlocks = response.content.filter((b) => b.type === "tool_use");
        const toolResults = await Promise.all(toolBlocks.map(async (block) => ({
            type: "tool_result",
            tool_use_id: block.id,
            content: await executeTool(block.name, block.input),
        })));
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
    let toolRounds = 0;
    while (true) {
        if (toolRounds > MAX_TOOL_ROUNDS)
            throw new Error("Tool call limit exceeded");
        const stream = anthropic.messages.stream({
            model: CLAUDE_MODEL,
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            tools: CLAUDE_TOOLS,
            messages,
        });
        // Buffer text deltas — only flush to client in the final (non-tool) round
        const roundDeltas = [];
        for await (const event of stream) {
            if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
                callbacks.onStatus?.(toolStatusMessage(event.content_block.name));
            }
            else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                roundDeltas.push(event.delta.text);
            }
        }
        const final = await stream.finalMessage();
        if (final.stop_reason !== "tool_use") {
            // Final answer — flush buffered deltas to client
            for (const delta of roundDeltas) {
                callbacks.onDelta?.(delta);
                fullText += delta;
            }
            break;
        }
        // Tool round — discard any intermediate text, execute tools
        toolRounds++;
        messages.push({ role: "assistant", content: final.content });
        const toolBlocks = final.content.filter((b) => b.type === "tool_use");
        const toolResults = await Promise.all(toolBlocks.map(async (block) => ({
            type: "tool_result",
            tool_use_id: block.id,
            content: await executeTool(block.name, block.input),
        })));
        messages.push({ role: "user", content: toolResults });
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
// ─── Gemini path ─────────────────────────────────────────────────────────────
import { GoogleGenerativeAI, FunctionCallingMode, SchemaType, } from "@google/generative-ai";
const geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
const GEMINI_TOOLS = [
    {
        name: "find_therapists",
        description: "Search licensed therapists from Planda. Call this FIRST. Use per_page=100 to get full catalogue. Only city filter works server-side; filter all others AI-side.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                city: { type: SchemaType.STRING, description: "City for in-person sessions. Omit for online." },
                page: { type: SchemaType.NUMBER, description: "Page number (default 1)" },
                per_page: { type: SchemaType.NUMBER, description: "Results per page, use 100 for full catalogue" },
            },
        },
    },
    {
        name: "get_therapist",
        description: "Fetch full profile by ID. MANDATORY for approach queries (BDT, EMDR, ACT, Schema etc.). Only approaches[] here.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                id: { type: SchemaType.STRING, description: "Therapist unique ID" },
            },
            required: ["id"],
        },
    },
    {
        name: "list_specialties",
        description: "Returns all specialty categories. Use when unsure of exact specialty names.",
        parameters: { type: SchemaType.OBJECT, properties: {} },
    },
    {
        name: "get_therapist_available_days",
        description: "Returns dates a therapist has open slots at a specific branch.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                therapist_id: { type: SchemaType.STRING, description: "Therapist ID" },
                branch_id: { type: SchemaType.STRING, description: "Branch ID from branches[]" },
            },
            required: ["therapist_id", "branch_id"],
        },
    },
    {
        name: "get_therapist_hours",
        description: "Returns available appointment slots for a therapist on a specific date.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                therapist_id: { type: SchemaType.STRING, description: "Therapist ID" },
                date: { type: SchemaType.STRING, description: "Date in YYYY-MM-DD format" },
                branch_id: { type: SchemaType.STRING, description: "Branch ID (optional)" },
                service_id: { type: SchemaType.STRING, description: "Service ID (optional)" },
            },
            required: ["therapist_id", "date"],
        },
    },
];
function toGeminiHistory(history) {
    return history.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
    }));
}
async function runGeminiChat(input) {
    const model = geminiClient.getGenerativeModel({
        model: GEMINI_MODEL,
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations: GEMINI_TOOLS }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.AUTO } },
    });
    const chat = model.startChat({ history: toGeminiHistory(input.history) });
    let result = await chat.sendMessage(input.message);
    let toolRounds = 0;
    while (result.response.functionCalls()?.length) {
        if (++toolRounds > MAX_TOOL_ROUNDS)
            throw new Error("Tool call limit exceeded");
        const calls = result.response.functionCalls();
        calls.forEach((c) => toolStatusMessage(c.name));
        const toolParts = await Promise.all(calls.map(async (call) => ({
            functionResponse: {
                name: call.name,
                response: { result: JSON.parse(await executeTool(call.name, call.args)) },
            },
        })));
        result = await chat.sendMessage(toolParts);
    }
    const text = result.response.text();
    return {
        response: text,
        updatedHistory: [
            ...input.history,
            { role: "user", content: input.message },
            { role: "assistant", content: text },
        ],
    };
}
async function runGeminiChatStream(input, callbacks) {
    // Gemini tool-call + streaming can't be interleaved cleanly — run full chat, deliver as one delta
    const result = await runGeminiChat(input);
    callbacks.onDelta?.(result.response);
    return result;
}
// ─── OpenAI path (fallback) ───────────────────────────────────────────────────
import { hostedMcpTool, Agent, Runner, withTrace } from "@openai/agents";
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
async function runOpenAIChat(input) {
    return withTrace("PlandaChat", async () => {
        const items = [
            ...input.history.map((m) => m.role === "user"
                ? { role: "user", content: m.content }
                : { role: "assistant", status: "completed", content: [{ type: "output_text", text: m.content }] }),
            { role: "user", content: [{ type: "input_text", text: input.message }] },
        ];
        const result = await getOpenAIRunner().run(getOpenAIAgent(), items);
        const text = String(result.finalOutput ?? "");
        return {
            response: text,
            updatedHistory: [...input.history, { role: "user", content: input.message }, { role: "assistant", content: text }],
        };
    });
}
// ─── Public API ───────────────────────────────────────────────────────────────
const USE_CLAUDE = Boolean(process.env.ANTHROPIC_API_KEY);
const USE_GEMINI = Boolean(process.env.GEMINI_API_KEY);
const CHAT_TIMEOUT_MS = parseInt(process.env.CHAT_TIMEOUT_MS ?? "90000", 10);
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Chat timed out after ${ms}ms`)), ms)),
    ]);
}
export async function runChat(input) {
    const guard = await checkGuardrails(input.message);
    if (guard.blocked) {
        return {
            response: SAFE_RESPONSE,
            updatedHistory: [...input.history, { role: "user", content: input.message }, { role: "assistant", content: SAFE_RESPONSE }],
        };
    }
    if (USE_CLAUDE)
        return withTimeout(runClaudeChat(input), CHAT_TIMEOUT_MS);
    if (USE_GEMINI)
        return withTimeout(runGeminiChat(input), CHAT_TIMEOUT_MS);
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
    if (USE_CLAUDE)
        return withTimeout(runClaudeChatStream(input, callbacks), CHAT_TIMEOUT_MS);
    if (USE_GEMINI)
        return withTimeout(runGeminiChatStream(input, callbacks), CHAT_TIMEOUT_MS);
    // OpenAI streaming fallback — non-streaming graceful degradation
    const result = await withTimeout(runOpenAIChat(input), CHAT_TIMEOUT_MS);
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