/**
 * Planda Assistant — Structured conversation logger
 *
 * Writes one JSON object per turn to `logs/conversations.jsonl`.
 * Also emits a one-line summary to stdout for Railway log capture.
 *
 * Disable with LOG_CONVERSATIONS=0. Override path with CONVERSATION_LOG_PATH.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { reportTurnToSentry } from "./sentry.js";
const ENABLED = process.env.LOG_CONVERSATIONS !== "0";
const LOG_PATH = resolve(process.env.CONVERSATION_LOG_PATH ?? "logs/conversations.jsonl");
let dirEnsured = false;
async function ensureDir() {
    if (dirEnsured)
        return;
    try {
        await mkdir(dirname(LOG_PATH), { recursive: true });
        dirEnsured = true;
    }
    catch (err) {
        console.error("[logger] mkdir failed:", err);
    }
}
function truncate(s, max) {
    if (!s)
        return "";
    return s.length > max ? s.slice(0, max) + "…[truncated]" : s;
}
export async function logTurn(turn) {
    if (!ENABLED)
        return;
    const safe = {
        ...turn,
        userMessage: truncate(turn.userMessage, 2000),
        response: truncate(turn.response, 8000),
        toolCalls: turn.toolCalls.map((c) => ({
            ...c,
            arguments: truncate(c.arguments, 1500),
            output: truncate(c.output, 3000),
        })),
    };
    const summary = `[turn] sid=${safe.sessionId.slice(0, 8)} ` +
        `intent=${safe.intent ?? "?"} ` +
        `tools=${safe.toolCalls.map((c) => c.name).join(",") || "-"} ` +
        `ms=${safe.latencyMs} ` +
        (safe.violations?.length ? `violations=${safe.violations.length} ` : "") +
        (safe.error ? `ERROR=${safe.error.slice(0, 80)}` : "");
    console.log(summary);
    // Primary transport: Sentry (persistent, queryable)
    try {
        reportTurnToSentry(safe);
    }
    catch (err) {
        console.error("[logger] sentry report failed:", err);
    }
    // Secondary: local JSONL — useful for dev, lost on Railway redeploy
    try {
        await ensureDir();
        await appendFile(LOG_PATH, JSON.stringify(safe) + "\n", "utf8");
    }
    catch (err) {
        console.error("[logger] appendFile failed:", err);
    }
}
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
export function extractToolCalls(result) {
    const calls = [];
    const r = result;
    // Probe every known location and concat
    const pools = [
        (r?.newItems ?? []),
        (r?.history ?? []),
        (r?.state?._generatedItems ?? []),
    ];
    // Model responses contain raw items too
    for (const mr of (r?.state?._modelResponses ?? [])) {
        if (Array.isArray(mr?.output))
            pools.push(mr.output);
    }
    const seenIds = new Set();
    const debug = process.env.DEBUG_TOOL_CALLS === "1";
    const typeTrace = [];
    // mcp_list_tools is a transport/bootstrap call (MCP server tool discovery),
    // not a semantic tool call. Filter it out so downstream checks (intent
    // mismatch, tool_count tag) only see user-meaningful calls.
    const BOOTSTRAP_NAMES = new Set(["mcp_list_tools"]);
    for (const items of pools) {
        for (const item of items) {
            if (!item || typeof item !== "object")
                continue;
            const wrapper = item;
            const raw = (wrapper.rawItem ?? item);
            const type = String(raw.type ?? wrapper.type ?? "");
            if (debug)
                typeTrace.push(type);
            // Actual tool name: for hosted_tool_call with name="mcp_call", the real
            // tool name is in providerData.name (confirmed via live probe).
            const providerName = raw.providerData?.name;
            const wrappedName = raw.name;
            let toolName = wrappedName;
            if (wrappedName === "mcp_call" || wrappedName === "mcp_list_tools") {
                toolName = providerName ?? raw.tool_name ?? wrappedName;
            }
            const hasCallShape = typeof raw.name === "string";
            const isKnownCallType = type === "function_call" ||
                type === "mcp_call" ||
                type === "tool_call" ||
                type === "hosted_tool_call" ||
                type.endsWith("tool_call_item") ||
                type.includes("mcp_call");
            const isOutput = type === "function_call_output" ||
                type === "mcp_call_output" ||
                type === "hosted_tool_call_output" ||
                type.endsWith("tool_call_output_item") ||
                type === "tool_call_output";
            if (isOutput) {
                const out = typeof raw.output === "string"
                    ? raw.output
                    : JSON.stringify(raw.output ?? raw.providerData?.output ?? "");
                const target = calls[calls.length - 1];
                if (target && !target.output)
                    target.output = out;
                continue;
            }
            if (hasCallShape || isKnownCallType) {
                const id = raw.call_id ?? raw.id ?? `${toolName}-${calls.length}`;
                if (seenIds.has(id))
                    continue;
                seenIds.add(id);
                const resolvedName = toolName ?? type ?? "unknown";
                // Skip bootstrap calls — not meaningful for intent-mismatch analysis
                if (BOOTSTRAP_NAMES.has(resolvedName))
                    continue;
                const rawArgs = raw.arguments ?? raw.providerData?.arguments;
                const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {});
                calls.push({ name: resolvedName, arguments: args });
            }
        }
    }
    if (debug && typeTrace.length > 0) {
        console.log("[extractToolCalls] item types:", typeTrace.join(", "), "→", calls.length, "calls");
    }
    return calls;
}
//# sourceMappingURL=logger.js.map