#!/usr/bin/env node
/**
 * Planda MCP Server
 *
 * Endpoints:
 *   GET  /health                    — liveness check (no auth)
 *   POST /v1/assistant/chat         — iOS chat, buffered (no auth)
 *   GET  /v1/assistant/chat/stream  — iOS chat, SSE streaming (no auth)
 *   POST /api/chat                  — legacy compat, stateless (no auth)
 *   POST /mcp                       — MCP JSON-RPC (AI clients)
 *   GET  /mcp                       — MCP SSE stream
 *   DELETE /mcp                     — MCP session termination
 *
 * Environment variables:
 *   PORT                  — HTTP port (Railway sets automatically)
 *   TRANSPORT             — "http" (default) | "stdio"
 *   OPENAI_API_KEY        — Required for chat endpoints
 *   CORS_ORIGIN           — Allowed CORS origin (default: "*")
 *   REDIS_URL             — Redis connection string for persistent sessions
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import cors from "cors";
import { registerTherapistTools } from "./tools/therapists.js";
import { runWorkflow, runChat, runChatStream } from "./workflow.js";
import { getHistory, saveHistory } from "./sessionStore.js";
import { findTherapists } from "./services/therapistApi.js";
import { logTurn } from "./logger.js";
import { classifyIntent, detectIntentToolMismatch, shouldForceToolCall, } from "./guards/intentClassifier.js";
import { verifyResponse, shouldUseFallback, HALLUCINATION_FALLBACK, } from "./guards/hallucinationGuard.js";
import { initSentry, Sentry } from "./sentry.js";
// Sentry must initialize before any other import that might throw
initSentry();
// ─── Therapist list cache ─────────────────────────────────────────────────────
const THERAPIST_CACHE_TTL_MS = 5 * 60 * 1000;
let therapistCache = null;
async function getCachedTherapists() {
    if (therapistCache && Date.now() - therapistCache.fetchedAt < THERAPIST_CACHE_TTL_MS) {
        return therapistCache.therapists;
    }
    const raw = await findTherapists({ per_page: 500 });
    const therapists = raw.data ?? raw.therapists ?? raw.results ?? [];
    therapistCache = { therapists, fetchedAt: Date.now() };
    return therapists;
}
// ─── Rate limiter ─────────────────────────────────────────────────────────────
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const rateLimitMap = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
        if (now > entry.resetAt)
            rateLimitMap.delete(ip);
    }
}, 5 * 60 * 1000);
function checkRateLimit(ip) {
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (!entry || now > entry.resetAt) {
        rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return true;
    }
    if (entry.count >= RATE_LIMIT_MAX)
        return false;
    entry.count++;
    return true;
}
// ─── Session helpers ──────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function extractSessionId(body, req) {
    const candidate = (typeof body.session_id === "string" && body.session_id.trim() ? body.session_id.trim() : null) ??
        (typeof body.previous_response_id === "string" && body.previous_response_id.trim()
            ? body.previous_response_id.trim()
            : null) ??
        req.headers["x-session-id"]?.trim() ??
        null;
    return candidate && UUID_RE.test(candidate) ? candidate : crypto.randomUUID();
}
async function resolveHistory(clientHistory, sessionId) {
    if (clientHistory) {
        return clientHistory.filter((m) => m !== null &&
            typeof m === "object" &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string");
    }
    return getHistory(sessionId);
}
// ─── Turkish character normalisation ─────────────────────────────────────────
function normTR(s) {
    return s.toLowerCase()
        .replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u")
        .replace(/ö/g, "o").replace(/ı/g, "i").replace(/ç/g, "c")
        .replace(/[^a-z0-9 ]/g, "");
}
/** Find therapist by exact username, or fuzzy-match a name/slug against full_name. */
function findTherapist(therapists, query) {
    const exact = therapists.find((t) => t.username === query);
    if (exact)
        return exact;
    const norm = normTR(query.replace(/[-_]/g, " "));
    const words = norm.split(/\s+/).filter(Boolean);
    if (!words.length)
        return undefined;
    return therapists.find((t) => {
        const full = t.full_name?.trim() || [t.name, t.surname].filter(Boolean).join(" ");
        return words.every((w) => normTR(full).includes(w));
    });
}
// ─── Combined response post-processing ───────────────────────────────────────
//
// Single Planda API call; three sequential passes on the agent's text:
//
//  Pass 1 — Fix names in **Name** — Title headers
//    Agent may garble Turkish characters; replace with the API's full_name.
//
//  Pass 2 — Inject missing [[expert:username]] tags
//    If a recommendation block has no tag, add one.
//
//  Pass 3 — Fix slugs and enrich bare tags
//    Wrong slugs → correct API username.
//    Bare tags (< 60 chars preceding text) → prepend Name / Fee / Location.
async function postProcessResponse(text) {
    const hasBoldHeaders = /\*\*[^*\n]+\*\*\s*—/.test(text);
    const hasExpertTags = /\[\[expert:[^\]]+\]\]/.test(text);
    if (!hasBoldHeaders && !hasExpertTags)
        return text;
    let therapists = [];
    try {
        therapists = await getCachedTherapists();
    }
    catch {
        return text;
    }
    let result = text;
    // ── Pass 1: Correct garbled therapist names in bold headers ──────────────
    if (hasBoldHeaders) {
        result = result.replace(/\*\*([^*\n]+)\*\*(\s*—[^\n]*)/g, (_m, rawName, rest) => {
            const t = findTherapist(therapists, rawName.trim());
            if (!t)
                return _m;
            const correct = t.full_name?.trim() || [t.name, t.surname].filter(Boolean).join(" ");
            return `**${correct}**${rest}`;
        });
    }
    // ── Pass 2: Inject [[expert:username]] where missing ─────────────────────
    if (hasBoldHeaders && !/\[\[expert:[^\]]+\]\]/.test(result)) {
        const headerPat = /\*\*([^*\n]+)\*\*\s*—[^\n]*/g;
        const insertions = [];
        let m;
        while ((m = headerPat.exec(result)) !== null) {
            const t = findTherapist(therapists, m[1].trim());
            if (!t?.username)
                continue;
            const after = result.slice(m.index + m[0].length);
            const nextIdx = after.search(/\n\*\*[^*]/);
            const blockEnd = nextIdx >= 0 ? m.index + m[0].length + nextIdx : result.length;
            insertions.push({ pos: blockEnd, tag: `\n[[expert:${t.username}]]` });
        }
        insertions.sort((a, b) => b.pos - a.pos);
        for (const { pos, tag } of insertions) {
            result = result.slice(0, pos) + tag + result.slice(pos);
        }
    }
    // ── Pass 3: Fix wrong slugs; enrich tags that lack card-format context ──────
    // Each tag is evaluated independently:
    //   • Tag preceded by a **Name** — Title header → card content already present,
    //     just fix the slug.
    //   • Tag with no bold header before it (bare tag OR availability text) →
    //     prepend Name / Fee / Location so iOS card renders correctly.
    if (!/\[\[expert:[^\]]+\]\]/.test(result))
        return result;
    const tagCtxMap = new Map();
    const tagScan = /\[\[expert:([^\]]+)\]\]/g;
    let scanMatch;
    while ((scanMatch = tagScan.exec(result)) !== null) {
        const textBefore = result.slice(0, scanMatch.index);
        const headers = [...textBefore.matchAll(/\*\*([^*\n]+)\*\*\s*—/g)];
        tagCtxMap.set(scanMatch.index, {
            slug: scanMatch[1],
            precedingHeader: headers.length > 0 ? headers[headers.length - 1][1].trim() : null,
        });
    }
    result = result.replace(/\[\[expert:([^\]]+)\]\]/g, (_m, _slug, offset) => {
        const ctx = tagCtxMap.get(offset);
        if (!ctx)
            return _m;
        // Has a bold header before it → fix the slug to match that header's therapist
        if (ctx.precedingHeader) {
            const tFromHeader = findTherapist(therapists, ctx.precedingHeader);
            if (tFromHeader?.username)
                return `[[expert:${tFromHeader.username}]]`;
        }
        // No bold header context → slug-based lookup + card enrichment
        const t = findTherapist(therapists, ctx.slug);
        if (!t?.username)
            return _m;
        const correctTag = `[[expert:${t.username}]]`;
        const name = t.full_name?.trim() || [t.name, t.surname].filter(Boolean).join(" ");
        const title = t.data?.title?.name ?? "";
        const fees = (t.services ?? [])
            .map((s) => {
            const f = s.custom_fee ?? s.fee;
            return f ? `${s.name}: ${Math.round(parseFloat(f)).toLocaleString("tr-TR")} TL` : null;
        })
            .filter(Boolean);
        const physicalBranches = (t.branches ?? []).filter((b) => b.type === "physical");
        const isOnline = (t.branches ?? []).some((b) => b.type === "online");
        const branchLabels = physicalBranches.map((b) => [b.city?.name, b.name].filter(Boolean).join(" — "));
        const location = [isOnline ? "Online" : null, ...branchLabels].filter(Boolean).join(" / ");
        const lines = [];
        if (name)
            lines.push(`**${name}**${title ? " — " + title : ""}`);
        if (fees.length)
            lines.push(`Ücret: ${fees.join(" | ")}`);
        if (location)
            lines.push(`Görüşme: ${location}`);
        return lines.join("\n") + "\n" + correctTag;
    });
    return result;
}
async function guardResponse(rawResponse, toolCallCount, actualToolNames = [], intent) {
    const violations = [];
    let hallucinations = [];
    try {
        hallucinations = await verifyResponse(rawResponse);
    }
    catch (err) {
        console.error("[guard] verifyResponse error:", err);
        return { response: rawResponse, replaced: false, violations: [] };
    }
    for (const v of hallucinations) {
        violations.push({ kind: v.kind, detail: v.value });
    }
    // Intent-aware hard block: classifier said a tool is expected, none called,
    // and the response isn't just a clarifying question. This catches intent
    // misclassification (NODE-2 class) where the response looks substantive but
    // the backend was never consulted.
    if (intent && toolCallCount === 0 && intent.expectedTools.length > 0) {
        const mismatch = detectIntentToolMismatch(intent, actualToolNames, rawResponse);
        if (mismatch.length > 0) {
            violations.push({ kind: "intent_mismatch", detail: mismatch[0] });
            try {
                Sentry.captureMessage("Intent mismatch — response replaced", {
                    level: "error",
                    tags: {
                        kind: "intent_mismatch_fallback",
                        intent: intent.intent,
                        expected_tools: intent.expectedTools.join(","),
                        tool_count: String(toolCallCount),
                    },
                });
            }
            catch { }
            return { response: HALLUCINATION_FALLBACK, replaced: true, violations };
        }
    }
    if (shouldUseFallback(hallucinations, toolCallCount, rawResponse)) {
        // Detect rule #5 — therapist card with no tool call (NODE-2 class) — so
        // Sentry can distinguish this from classic unknown-name hallucinations.
        const cardNoTool = toolCallCount === 0 &&
            hallucinations.length === 0 &&
            (/\*\*[^*\n]+\*\*\s*—/.test(rawResponse) ||
                /\[\[expert:[^\]]+\]\]/.test(rawResponse));
        if (cardNoTool) {
            violations.push({ kind: "other", detail: "card_without_tool_call" });
        }
        console.warn("[guard] Hallucination detected, replacing with fallback. " +
            `unknown=${hallucinations.length} tools=${toolCallCount} ` +
            `cardNoTool=${cardNoTool}`);
        try {
            Sentry.captureMessage("Hallucination detected — response replaced", {
                level: "error",
                tags: {
                    kind: "hallucination_fallback",
                    trigger: cardNoTool ? "card_without_tool_call" : "unknown_therapist",
                    tool_count: String(toolCallCount),
                    unknown_count: String(hallucinations.length),
                },
            });
        }
        catch { }
        return { response: HALLUCINATION_FALLBACK, replaced: true, violations };
    }
    return { response: rawResponse, replaced: false, violations };
}
// ─── Observability pipeline ──────────────────────────────────────────────────
//
// Called after every chat turn (buffered + stream + legacy).
// Collects intent, guard violations, tool calls; writes JSONL + stdout.
async function observeTurn(opts) {
    const toolCalls = opts.toolCalls ?? [];
    const intent = opts.precomputedIntent ?? classifyIntent(opts.userMessage);
    const violations = [...(opts.precomputedViolations ?? [])];
    // Intent → tool-call mismatch (e.g. search intent without find_therapists).
    // Response is passed so clarifying questions don't falsely trigger a mismatch.
    const mismatch = detectIntentToolMismatch(intent, toolCalls.map((c) => c.name), opts.response);
    for (const m of mismatch) {
        violations.push({ kind: "intent_mismatch", detail: m });
    }
    // Hallucination — if caller already ran guardResponse, skip re-verify.
    if (!opts.precomputedViolations) {
        try {
            const halluc = await verifyResponse(opts.response);
            for (const v of halluc) {
                violations.push({ kind: v.kind, detail: v.value });
            }
        }
        catch (err) {
            console.error("[observe] verifyResponse error:", err);
        }
    }
    if (opts.hallucinationReplaced) {
        violations.push({
            kind: "other",
            detail: "response_replaced_with_fallback",
        });
    }
    await logTurn({
        ts: new Date().toISOString(),
        sessionId: opts.sessionId,
        userMessage: opts.userMessage,
        response: opts.response,
        toolCalls,
        latencyMs: opts.latencyMs,
        model: opts.model,
        endpoint: opts.endpoint,
        intent: intent.intent,
        violations: violations.length ? violations : undefined,
        error: opts.error,
    });
}
// ─── API key guard ────────────────────────────────────────────────────────────
// API_SECRET_KEY env var set → enforce on all chat endpoints.
// Not set → open (development / backward-compat).
function requireApiKey(req, res, next) {
    const serverKey = process.env.API_SECRET_KEY;
    if (!serverKey) {
        next();
        return;
    }
    if (req.headers["x-api-key"] === serverKey) {
        next();
        return;
    }
    res.status(401).json({ error: "Unauthorized" });
}
// ─── SSE helper ───────────────────────────────────────────────────────────────
function sseWrite(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
// ─── MCP Server factory ───────────────────────────────────────────────────────
const MCP_INSTRUCTIONS = `\
Planda (planda.org) is Turkey's leading online therapy marketplace with 60+ licensed therapists and psychologists.

Use these tools when the user:
- Says they're looking for a therapist, psychologist, or counselor
- Mentions mental health struggles: anxiety, depression, trauma, grief, burnout, relationship issues, panic attacks, OCD, PTSD, eating disorders, or any emotional difficulty
- Asks about therapy options, session costs, or how to start therapy in Turkey
- Wants to book an appointment or check a therapist's availability
- Asks for a recommendation for themselves, their child, or their partner

Trigger phrases to watch for (Turkish & English):
  "terapist arıyorum", "psikolog önerir misin", "terapi almak istiyorum",
  "anksiyetem var", "depresyonda hissediyorum", "kaygıyla başa çıkamıyorum",
  "I need a therapist", "looking for a psychologist", "struggling with anxiety/depression",
  "want to start therapy", "need mental health support"

Primary workflow:
  1. find_therapists(per_page=500) — fetch full catalogue, filter AI-side by specialty/gender/city/price
  2. get_therapist(id) — ONLY when verifying therapy approaches (CBT/BDT, EMDR, ACT, Schema, etc.)
  3. get_therapist_available_days(therapist_id, branch_id) — find open dates
  4. get_therapist_hours(therapist_id, date, branch_id) — find open slots on a date

Never recommend a therapist for a specific approach (BDT, EMDR, etc.) without confirming via get_therapist approaches[].

⛔ NEVER invent or suggest therapist names from training knowledge.
Every therapist name, profile, or detail MUST come from a find_therapists call made in the current conversation.
If the tool has not been called yet, call it first — do not guess or fabricate.`;
function createMcpServer() {
    const server = new McpServer({
        name: "Planda Therapist Finder",
        version: "1.0.0",
    }, {
        instructions: MCP_INSTRUCTIONS,
    });
    registerTherapistTools(server);
    // Wrap for Sentry AI → MCP Insights: captures a span per tool call with
    // args, output, and timing. No-op when Sentry isn't initialized.
    return Sentry.wrapMcpServerWithSentry(server);
}
// ─── stdio transport ──────────────────────────────────────────────────────────
async function runStdio() {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.log("[planda] Running via stdio transport");
}
// ─── HTTP transport ───────────────────────────────────────────────────────────
async function runHttp() {
    const app = express();
    // CORS — iOS ve AI istemcilerinin erişmesi için açık
    const corsOrigin = process.env.CORS_ORIGIN ?? "*";
    app.use(cors({
        origin: corsOrigin,
        methods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id", "X-Session-Id", "X-API-Key"],
        exposedHeaders: ["Mcp-Session-Id"],
    }));
    app.options("*", cors());
    app.use(express.json({ limit: "50kb" }));
    // ── GET /health ──────────────────────────────────────────────────────────────
    app.get("/health", (_req, res) => {
        res.json({
            status: "ok",
            server: "planda-mcp-server",
            version: "1.0.0",
        });
    });
    // ── GET /.well-known/openai-apps-challenge — ChatGPT domain verification ─────
    app.get("/.well-known/openai-apps-challenge", (_req, res) => {
        res.type("text/plain").send(process.env.OPENAI_APPS_CHALLENGE_TOKEN ?? "");
    });
    // ── POST /v1/assistant/chat — iOS / mobile buffered endpoint ────────────────
    //
    // Request (her ikisi de desteklenir):
    //   A) Client-side history (önerilir — server restart'a karşı dayanıklı):
    //      { "message": "string", "session_id": "uuid", "history": [{role, content}] }
    //
    //   B) Server-side session (fallback):
    //      { "message": "string", "session_id": "uuid | null" }
    //
    // Response:
    //   { "response": "string", "session_id": "uuid" }
    //
    // Öncelik: body'de history varsa → onu kullan (server yeniden deploy edilse de çalışır)
    //          history yoksa → session store'dan yükle
    //
    app.post("/v1/assistant/chat", requireApiKey, async (req, res) => {
        if (!process.env.OPENAI_API_KEY) {
            res.status(500).json({ error: "No AI provider configured (set OPENAI_API_KEY)" });
            return;
        }
        const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
        if (!checkRateLimit(ip)) {
            res.status(429).json({ error: "Too many requests. Please wait a moment before retrying." });
            return;
        }
        const body = req.body;
        const message = typeof body.message === "string" ? body.message.trim() : "";
        if (!message) {
            res.status(400).json({ error: "message is required" });
            return;
        }
        const sessionId = extractSessionId(body, req);
        const history = await resolveHistory(Array.isArray(body.history) ? body.history : null, sessionId);
        const intent = classifyIntent(message);
        const forceToolCall = shouldForceToolCall(intent);
        const startedAt = Date.now();
        try {
            const { response: rawResponse, updatedHistory, toolCalls, model } = await runChat({ message, history, forceToolCall });
            const processed = await postProcessResponse(rawResponse);
            const guarded = await guardResponse(processed, toolCalls?.length ?? 0, (toolCalls ?? []).map((c) => c.name), intent);
            const response = guarded.response;
            // Store'u async güncelle — fallback devreye girdiyse gerçek konuşmayı
            // geçmişe eklemeyelim (model kurgu isim ürettiği için), orijinali tut.
            if (!guarded.replaced) {
                saveHistory(sessionId, updatedHistory).catch((err) => console.error("[planda] saveHistory error:", err));
            }
            observeTurn({
                sessionId, userMessage: message, response,
                toolCalls, latencyMs: Date.now() - startedAt, model,
                endpoint: "/v1/assistant/chat",
                precomputedIntent: intent,
                precomputedViolations: guarded.violations,
                hallucinationReplaced: guarded.replaced,
            }).catch(() => { });
            res.json({
                response,
                message: response, // alias
                session_id: sessionId,
                previous_response_id: sessionId, // alias
            });
        }
        catch (err) {
            console.error("[planda] /v1/assistant/chat error:", err);
            observeTurn({
                sessionId, userMessage: message, response: "",
                latencyMs: Date.now() - startedAt,
                endpoint: "/v1/assistant/chat",
                error: err instanceof Error ? err.message : String(err),
            }).catch(() => { });
            res.status(502).json({ error: "Assistant unavailable. Please try again." });
        }
    });
    // ── POST /v1/assistant/chat/stream — iOS SSE streaming endpoint ──────────────
    //
    // @openai/agents token-level streaming'i desteklemez.
    // Bu endpoint şu stratejiyle en iyi UX'i sağlar:
    //   1. Anında "status" eventi → iOS spinner/typing gösterir
    //   2. Agent çalışır (tool calls + LLM)
    //   3. Yanıt hazır olunca "response" eventi → metin bir seferde gelir
    //   4. "done" eventi → bağlantı kapanır
    //
    // iOS'ta: URLSession + EventSource ile parse edilir.
    //
    app.post("/v1/assistant/chat/stream", requireApiKey, async (req, res) => {
        if (!process.env.OPENAI_API_KEY) {
            res.status(500).json({ error: "No AI provider configured (set OPENAI_API_KEY)" });
            return;
        }
        const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
        if (!checkRateLimit(ip)) {
            res.status(429).json({ error: "Too many requests. Please wait a moment before retrying." });
            return;
        }
        const body = req.body;
        const message = typeof body.message === "string" ? body.message.trim() : "";
        if (!message) {
            res.status(400).json({ error: "message is required" });
            return;
        }
        const sessionId = extractSessionId(body, req);
        // SSE headers
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no"); // Nginx proxy buffering'i kapat
        res.flushHeaders();
        const keepalive = setInterval(() => { try {
            res.write(": keepalive\n\n");
        }
        catch {
            clearInterval(keepalive);
        } }, 15000);
        const intent = classifyIntent(message);
        const forceToolCall = shouldForceToolCall(intent);
        const startedAt = Date.now();
        try {
            const history = await resolveHistory(Array.isArray(body.history) ? body.history : null, sessionId);
            let fullText = "";
            const { updatedHistory, toolCalls, model } = await runChatStream({ message, history, forceToolCall }, {
                onStatus: (msg) => sseWrite(res, "status", { message: msg }),
                onDelta: (delta) => {
                    fullText += delta;
                    sseWrite(res, "delta", { delta });
                },
            });
            // Post-process full text (fixes Turkish names + expert tags)
            const processed = await postProcessResponse(fullText);
            const guarded = await guardResponse(processed, toolCalls?.length ?? 0, (toolCalls ?? []).map((c) => c.name), intent);
            const response = guarded.response;
            // If guard or post-processing changed the text, send corrected event so
            // iOS can replace the streamed text with the final (safe) version.
            if (response !== fullText) {
                sseWrite(res, "corrected", { response, session_id: sessionId });
            }
            if (!guarded.replaced) {
                saveHistory(sessionId, updatedHistory).catch((err) => console.error("[planda] saveHistory error:", err));
            }
            observeTurn({
                sessionId, userMessage: message, response,
                toolCalls, latencyMs: Date.now() - startedAt, model,
                endpoint: "/v1/assistant/chat/stream",
                precomputedIntent: intent,
                precomputedViolations: guarded.violations,
                hallucinationReplaced: guarded.replaced,
            }).catch(() => { });
            sseWrite(res, "done", {
                response,
                message: response,
                session_id: sessionId,
                previous_response_id: sessionId,
            });
        }
        catch (err) {
            console.error("[planda] /v1/assistant/chat/stream error:", err);
            observeTurn({
                sessionId, userMessage: message, response: "",
                latencyMs: Date.now() - startedAt,
                endpoint: "/v1/assistant/chat/stream",
                error: err instanceof Error ? err.message : String(err),
            }).catch(() => { });
            sseWrite(res, "error", { error: "Assistant unavailable. Please try again." });
        }
        finally {
            clearInterval(keepalive);
            res.end();
        }
    });
    // ── POST /api/chat — legacy stateless endpoint (history in body) ─────────────
    app.post("/api/chat", requireApiKey, async (req, res) => {
        if (!process.env.OPENAI_API_KEY) {
            res.status(500).json({ error: "No AI provider configured (set OPENAI_API_KEY)" });
            return;
        }
        const { message, history } = req.body;
        if (!message) {
            res.status(400).json({ error: "message is required" });
            return;
        }
        const intent = classifyIntent(message);
        const forceToolCall = shouldForceToolCall(intent);
        const startedAt = Date.now();
        try {
            const result = await runWorkflow({
                input_as_text: message,
                history: history ?? [],
                forceToolCall,
            });
            const rawText = result.output_text ?? JSON.stringify(result);
            const processed = await postProcessResponse(rawText);
            const toolCalls = result.toolCalls;
            const guarded = await guardResponse(processed, toolCalls?.length ?? 0, (toolCalls ?? []).map((c) => c.name), intent);
            const text = guarded.response;
            observeTurn({
                sessionId: "legacy-" + (req.ip ?? "unknown"),
                userMessage: message,
                response: text,
                toolCalls,
                latencyMs: Date.now() - startedAt,
                model: result.model,
                endpoint: "/api/chat",
                precomputedIntent: intent,
                precomputedViolations: guarded.violations,
                hallucinationReplaced: guarded.replaced,
            }).catch(() => { });
            res.json({ response: text });
        }
        catch (err) {
            console.error("[planda] /api/chat error:", err);
            res.status(502).json({ error: "Assistant unavailable. Please try again." });
        }
    });
    // ── POST /debug/tool — raw API tool output for inspection ───────────────────
    app.post("/debug/tool", async (req, res) => {
        const { tool, params } = req.body ?? {};
        if (!tool || !params) {
            res.status(400).json({ error: "Required: { tool, params }" });
            return;
        }
        try {
            const { findTherapists, getTherapist, listSpecialties, getTherapistHours, getTherapistAvailableDays, } = await import("./services/therapistApi.js");
            let result;
            switch (tool) {
                case "find_therapists":
                    result = await findTherapists(params);
                    break;
                case "get_therapist":
                    result = await getTherapist(params.id);
                    break;
                case "list_specialties":
                    result = await listSpecialties();
                    break;
                case "get_therapist_hours":
                    result = await getTherapistHours(params);
                    break;
                case "get_therapist_available_days":
                    result = await getTherapistAvailableDays(params);
                    break;
                default:
                    res.status(400).json({ error: `Unknown tool: ${tool}` });
                    return;
            }
            res.json({ tool, params, result });
        }
        catch (err) {
            res.status(500).json({ tool, params, error: String(err) });
        }
    });
    // ── POST /mcp — MCP JSON-RPC ─────────────────────────────────────────────────
    app.post("/mcp", async (req, res) => {
        try {
            const server = createMcpServer();
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                enableJsonResponse: true,
            });
            res.on("close", () => transport.close().catch(() => { }));
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        }
        catch (err) {
            console.error("[planda] POST /mcp error:", err);
            if (!res.headersSent)
                res.status(500).json({ error: "Internal server error" });
        }
    });
    // ── GET /mcp — MCP SSE stream ────────────────────────────────────────────────
    app.get("/mcp", async (req, res) => {
        try {
            const server = createMcpServer();
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                enableJsonResponse: false,
            });
            res.on("close", () => transport.close().catch(() => { }));
            await server.connect(transport);
            await transport.handleRequest(req, res);
        }
        catch (err) {
            console.error("[planda] GET /mcp error:", err);
            if (!res.headersSent)
                res.status(500).json({ error: "Internal server error" });
        }
    });
    // ── DELETE /mcp — session termination ────────────────────────────────────────
    app.delete("/mcp", async (req, res) => {
        try {
            const server = createMcpServer();
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                enableJsonResponse: true,
            });
            await server.connect(transport);
            await transport.handleRequest(req, res);
        }
        catch (err) {
            console.error("[planda] DELETE /mcp error:", err);
            if (!res.headersSent)
                res.status(500).json({ error: "Internal server error" });
        }
    });
    // ── Listen ───────────────────────────────────────────────────────────────────
    const port = parseInt(process.env.PORT ?? "3000", 10);
    app.listen(port, "0.0.0.0", () => {
        console.log(`[planda] HTTP server listening on 0.0.0.0:${port}`);
        console.log(`[planda] Chat endpoint : POST /v1/assistant/chat`);
        console.log(`[planda] MCP endpoint  : POST /mcp`);
        console.log(`[planda] Health check  : GET  /health`);
    });
}
// ─── Process error handlers ───────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
    console.error("[planda] Uncaught exception:", err);
    try {
        Sentry.captureException(err);
    }
    catch { }
    process.exit(1);
});
process.on("unhandledRejection", (reason) => {
    console.error("[planda] Unhandled rejection:", reason);
    try {
        Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
    }
    catch { }
    process.exit(1);
});
// ─── Entry point ──────────────────────────────────────────────────────────────
console.log("[planda] Starting up — Node", process.version);
console.log("[planda] PORT:", process.env.PORT ?? "3000 (default)");
if (!process.env.OPENAI_API_KEY) {
    console.error("[planda] FATAL: OPENAI_API_KEY must be set");
    process.exit(1);
}
const transportMode = (process.env.TRANSPORT ?? "http").toLowerCase();
if (transportMode === "stdio") {
    runStdio().catch((err) => {
        console.error("[planda] Fatal:", err);
        process.exit(1);
    });
}
else {
    runHttp().catch((err) => {
        console.error("[planda] Fatal:", err);
        process.exit(1);
    });
}
//# sourceMappingURL=index.js.map