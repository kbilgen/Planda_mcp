/**
 * Planda Assistant — Claude (Anthropic) provider path.
 *
 * Enabled with AI_PROVIDER=claude + ANTHROPIC_API_KEY. Runs the exact same
 * tool handlers (handlers.ts) as the OpenAI path through the Anthropic SDK's
 * beta tool runner, so guards, logging and post-processing see an identical
 * surface: same tool names, same ChatOutput shape.
 *
 * Model: CLAUDE_MODEL (default "claude-fable-5"). On Fable 5 thinking is
 * always on — the `thinking` parameter is intentionally omitted. Depth is
 * controlled with output_config.effort (CLAUDE_EFFORT, default "low": chat
 * latency matters here, and low effort on Fable 5 still outperforms prior
 * models' high settings).
 *
 * Safety: Fable 5's classifiers can decline a request (stop_reason
 * "refusal"). We opt into server-side fallbacks so a declined request is
 * transparently re-run on claude-opus-4-8; if the whole chain refuses we
 * return a safe Turkish message instead of crashing.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { z } from "zod";
import { SYSTEM_PROMPT } from "./prompts.js";
import { ListInputSchema, GetInputSchema, HoursInputSchema, AvailableDaysInputSchema, handleFindTherapists, handleGetTherapist, handleListSpecialties, handleGetTherapistHours, handleGetTherapistAvailableDays, FIND_THERAPISTS_DESCRIPTION, GET_THERAPIST_DESCRIPTION, LIST_SPECIALTIES_DESCRIPTION, GET_HOURS_DESCRIPTION, GET_DAYS_DESCRIPTION, } from "./tools/handlers.js";
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-fable-5";
const CLAUDE_EFFORT = (process.env.CLAUDE_EFFORT ?? "low");
const MAX_OUTPUT_TOKENS = 4096;
const CLAUDE_MAX_ITERATIONS = parseInt(process.env.AGENT_MAX_TURNS ?? "8", 10);
const REFUSAL_FALLBACK_TR = "Bu konuda yardımcı olamıyorum. Uygun bir terapist bulmak için buradayım — nasıl bir destek aradığını anlatır mısın?";
let _client = null;
function getClient() {
    if (!_client)
        _client = new Anthropic(); // reads ANTHROPIC_API_KEY
    return _client;
}
export function isClaudeEnabled() {
    return ((process.env.AI_PROVIDER ?? "").toLowerCase() === "claude" &&
        Boolean(process.env.ANTHROPIC_API_KEY));
}
const EMPTY_SCHEMA = {
    type: "object",
    properties: {},
    required: [],
};
/** Zod → JSON Schema for Claude's input_schema; mirrors localTools.ts. */
function toInputSchema(schema) {
    try {
        const js = z.toJSONSchema(schema, { io: "input" });
        return {
            type: "object",
            properties: (js.properties ?? {}),
            required: Array.isArray(js.required) ? js.required : [],
        };
    }
    catch {
        return EMPTY_SCHEMA;
    }
}
/** Validate with Zod, run the shared handler, return its markdown text. */
async function validateAndRun(schema, input, run) {
    const parsed = schema.safeParse(input ?? {});
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ");
        return `Error: Invalid tool parameters — ${issues}. Fix the arguments and retry.`;
    }
    const result = await run(parsed.data);
    return result.text;
}
/**
 * Build the tool set. Each run() records the call into `log` so the guard
 * layer (toolCallCount) and observability keep working identically to the
 * OpenAI path.
 */
function buildClaudeTools(log) {
    const record = (name, args) => {
        log.push({ name, arguments: args });
    };
    return [
        betaTool({
            name: "find_therapists",
            description: FIND_THERAPISTS_DESCRIPTION,
            inputSchema: toInputSchema(ListInputSchema),
            run: (input) => {
                record("find_therapists", input);
                return validateAndRun(ListInputSchema, input, handleFindTherapists);
            },
        }),
        betaTool({
            name: "get_therapist",
            description: GET_THERAPIST_DESCRIPTION,
            inputSchema: toInputSchema(GetInputSchema),
            run: (input) => {
                record("get_therapist", input);
                return validateAndRun(GetInputSchema, input, handleGetTherapist);
            },
        }),
        betaTool({
            name: "list_specialties",
            description: LIST_SPECIALTIES_DESCRIPTION,
            inputSchema: EMPTY_SCHEMA,
            run: async () => {
                record("list_specialties", {});
                return (await handleListSpecialties()).text;
            },
        }),
        betaTool({
            name: "get_therapist_hours",
            description: GET_HOURS_DESCRIPTION,
            inputSchema: toInputSchema(HoursInputSchema),
            run: (input) => {
                record("get_therapist_hours", input);
                return validateAndRun(HoursInputSchema, input, handleGetTherapistHours);
            },
        }),
        betaTool({
            name: "get_therapist_available_days",
            description: GET_DAYS_DESCRIPTION,
            inputSchema: toInputSchema(AvailableDaysInputSchema),
            run: (input) => {
                record("get_therapist_available_days", input);
                return validateAndRun(AvailableDaysInputSchema, input, handleGetTherapistAvailableDays);
            },
        }),
    ];
}
// ─── Message assembly ─────────────────────────────────────────────────────────
function buildMessages(history, userMessage) {
    return [
        ...history.map((m) => ({
            role: m.role,
            content: m.content,
        })),
        { role: "user", content: userMessage },
    ];
}
function extractText(message) {
    return message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
}
/** Same clarifying-question heuristic as the OpenAI path (workflow.ts). */
function isClarifyingQuestion(text) {
    const trimmed = text.trim();
    if (trimmed.endsWith("?"))
        return true;
    const lower = trimmed.toLowerCase();
    return [
        "paylaşabilir", "paylasabilir", "söyleyebilir", "soyleyebilir",
        "hangi konu", "hangi şehir", "hangi sehir", "kimin için", "kimin icin",
        "kaç yaş", "kac yas", "online mi", "yüz yüze mi", "yuz yuze mi",
        "çalışma tarzı", "calisma tarzi", "hangi yaklaşım", "hangi yaklasim",
    ].some((p) => lower.includes(p));
}
// ─── Core run ────────────────────────────────────────────────────────────────
async function runOnce(messages, toolCalls) {
    const client = getClient();
    const runner = client.beta.messages.toolRunner({
        model: CLAUDE_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        // Fable 5: thinking is always on — the parameter is deliberately omitted.
        output_config: { effort: CLAUDE_EFFORT },
        // Safety classifiers can decline a request; retry it server-side on
        // Opus 4.8 instead of surfacing a refusal to the user.
        betas: ["server-side-fallback-2026-06-01"],
        fallbacks: [{ model: "claude-opus-4-8" }],
        system: [
            {
                type: "text",
                text: SYSTEM_PROMPT,
                // Stable prefix — cache across turns and sessions.
                cache_control: { type: "ephemeral" },
            },
        ],
        tools: buildClaudeTools(toolCalls),
        messages,
        max_iterations: CLAUDE_MAX_ITERATIONS,
    });
    return await runner;
}
export async function runClaudeChat(input) {
    const toolCalls = [];
    const firstMessages = buildMessages(input.history, input.message);
    let final = await runOnce(firstMessages, toolCalls);
    let text = extractText(final);
    // Refusal (whole fallback chain declined) → safe message, no fabrication.
    if (final.stop_reason === "refusal") {
        text = REFUSAL_FALLBACK_TR;
        return {
            response: text,
            updatedHistory: [
                ...input.history,
                { role: "user", content: input.message },
                { role: "assistant", content: text },
            ],
            toolCalls,
            model: final.model ?? CLAUDE_MODEL,
        };
    }
    // Tool-miss retry — same contract as the OpenAI path: classifier said a
    // tool is required, none was called, and the reply isn't a clarifying
    // question. One corrective retry, then give up.
    if (input.forceToolCall === true &&
        toolCalls.length === 0 &&
        !isClarifyingQuestion(text)) {
        const retryMessages = [
            ...firstMessages,
            { role: "assistant", content: final.content },
            {
                role: "user",
                content: "[Sistem notu: Kullanıcının isteğine yanıt vermek için " +
                    "find_therapists (veya uygun başka bir tool) çağrısı yapmalısın. " +
                    "Bilgiden cevap üretme — önce API'den gerçek veriyi çek, sonra yanıtla.]",
            },
        ];
        try {
            const retryCalls = [];
            const retryFinal = await runOnce(retryMessages, retryCalls);
            if (retryCalls.length > 0 && retryFinal.stop_reason !== "refusal") {
                console.log(`[claude] tool-miss retry succeeded (${retryCalls.length} tools)`);
                toolCalls.push(...retryCalls);
                final = retryFinal;
                text = extractText(retryFinal);
            }
        }
        catch (err) {
            console.error("[claude] tool-miss retry failed:", err);
        }
    }
    return {
        response: text,
        updatedHistory: [
            ...input.history,
            { role: "user", content: input.message },
            { role: "assistant", content: text },
        ],
        toolCalls,
        model: final.model ?? CLAUDE_MODEL,
    };
}
//# sourceMappingURL=claudeWorkflow.js.map