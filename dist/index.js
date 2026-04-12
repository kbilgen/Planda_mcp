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
import { runWorkflow, runChat } from "./workflow.js";
import { getHistory, saveHistory, sessionCount } from "./sessionStore.js";
import { makeApiRequest } from "./services/apiClient.js";
// ─── Expert tag enrichment ────────────────────────────────────────────────────
// Guarantees [[expert:slug]] always has preceding text.
// If the agent outputs a bare tag (or a wrong slug derived from the name),
// fetch all therapists and find by slug OR by name similarity.
/** Normalise Turkish text for fuzzy matching (ş→s, ğ→g, ü→u, ö→o, ı→i, ç→c) */
function normTR(s) {
    return s
        .toLowerCase()
        .replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u")
        .replace(/ö/g, "o").replace(/ı/g, "i").replace(/ç/g, "c")
        .replace(/[^a-z0-9 ]/g, "");
}
function findTherapist(therapists, slug) {
    // 1. Exact username match
    const exact = therapists.find((t) => t.username === slug);
    if (exact)
        return exact;
    // 2. Slug may be derived from name (agent violated SLUG KURALI).
    //    Try matching the normalised slug against normalised full names.
    const slugNorm = normTR(slug.replace(/[-_]/g, " "));
    return therapists.find((t) => {
        const fullName = t.full_name?.trim() || [t.name, t.surname].filter(Boolean).join(" ");
        const nameNorm = normTR(fullName);
        // Accept if slug words are all present in the name (or vice versa)
        const slugWords = slugNorm.split(" ").filter(Boolean);
        return slugWords.length > 0 && slugWords.every((w) => nameNorm.includes(w));
    });
}
async function enrichBareExpertTags(text) {
    const tagPattern = /\[\[expert:([^\]]+)\]\]/g;
    const tags = [...text.matchAll(tagPattern)];
    if (tags.length === 0)
        return text;
    // If there's already substantial text before the first tag, leave as-is
    const firstTagIndex = text.indexOf(tags[0][0]);
    const textBefore = text.slice(0, firstTagIndex).trim();
    if (textBefore.length > 60)
        return text;
    // Bare tag — enrich with a single list call
    let therapists = [];
    try {
        const raw = await makeApiRequest("marketplace/therapists", "GET", undefined, { per_page: 500 });
        therapists = raw.data ?? raw.therapists ?? raw.results ?? [];
    }
    catch {
        return text; // silently fall back to original
    }
    const enriched = text.replace(tagPattern, (_match, slug) => {
        const t = findTherapist(therapists, slug);
        if (!t)
            return _match;
        // If agent used a wrong slug, replace with the real username so iOS finds it
        const realSlug = t.username ?? slug;
        const correctTag = `[[expert:${realSlug}]]`;
        const name = t.full_name?.trim() || [t.name, t.surname].filter(Boolean).join(" ");
        const title = t.data?.title?.name ?? "";
        const fees = (t.services ?? [])
            .map((s) => {
            const raw = s.custom_fee ?? s.fee;
            return raw ? `${s.name}: ${Math.round(parseFloat(raw)).toLocaleString("tr-TR")} TL` : null;
        })
            .filter(Boolean);
        const isOnline = (t.branches ?? []).some((b) => b.type === "online");
        const cities = [...new Set((t.branches ?? []).filter((b) => b.type === "physical").map((b) => b.city?.name).filter(Boolean))];
        const location = [isOnline ? "Online" : null, ...cities].filter(Boolean).join(" / ");
        const lines = [];
        if (name)
            lines.push(`${name}${title ? " — " + title : ""}`);
        if (fees.length)
            lines.push(`Ücret: ${fees.join(" | ")}`);
        if (location)
            lines.push(`Görüşme: ${location}`);
        return lines.join("\n") + "\n" + correctTag;
    });
    return enriched;
}
// ─── SSE helper ───────────────────────────────────────────────────────────────
function sseWrite(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
// ─── MCP Server factory ───────────────────────────────────────────────────────
function createMcpServer() {
    const server = new McpServer({
        name: "planda-mcp-server",
        version: "1.0.0",
    });
    registerTherapistTools(server);
    return server;
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
    app.use(express.json());
    // ── GET /health ──────────────────────────────────────────────────────────────
    app.get("/health", (_req, res) => {
        res.json({
            status: "ok",
            server: "planda-mcp-server",
            version: "1.0.0",
            activeSessions: sessionCount(),
        });
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
    app.post("/v1/assistant/chat", async (req, res) => {
        if (!process.env.OPENAI_API_KEY) {
            res.status(500).json({ error: "OPENAI_API_KEY not configured" });
            return;
        }
        const body = req.body;
        const message = typeof body.message === "string" ? body.message.trim() : "";
        if (!message) {
            res.status(400).json({ error: "message is required" });
            return;
        }
        // session_id: body → header → yeni UUID
        const sessionId = (typeof body.session_id === "string" && body.session_id.trim()
            ? body.session_id.trim()
            : null) ??
            (typeof body.previous_response_id === "string" && body.previous_response_id.trim()
                ? body.previous_response_id.trim()
                : null) ??
            req.headers["x-session-id"]?.trim() ??
            crypto.randomUUID();
        // History kaynağı: client gönderirse onu kullan (server restart'a karşı güvenli)
        // Gönderilmezse server-side session store'dan yükle
        let history;
        const clientHistory = Array.isArray(body.history) ? body.history : null;
        if (clientHistory) {
            // Client-side history — validate shape
            history = clientHistory
                .filter((m) => m !== null &&
                typeof m === "object" &&
                (m.role === "user" || m.role === "assistant") &&
                typeof m.content === "string");
        }
        else {
            // Server-side session store fallback (Redis veya in-memory)
            history = await getHistory(sessionId);
        }
        try {
            const { response: rawResponse, updatedHistory } = await runChat({ message, history });
            const response = await enrichBareExpertTags(rawResponse);
            // Store'u async güncelle — response'u bekletme
            saveHistory(sessionId, updatedHistory).catch((err) => console.error("[planda] saveHistory error:", err));
            res.json({
                response,
                message: response, // alias
                session_id: sessionId,
                previous_response_id: sessionId, // alias
            });
        }
        catch (err) {
            console.error("[planda] /v1/assistant/chat error:", err);
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
    app.post("/v1/assistant/chat/stream", async (req, res) => {
        if (!process.env.OPENAI_API_KEY) {
            res.status(500).json({ error: "OPENAI_API_KEY not configured" });
            return;
        }
        const body = req.body;
        const message = typeof body.message === "string" ? body.message.trim() : "";
        if (!message) {
            res.status(400).json({ error: "message is required" });
            return;
        }
        const sessionId = (typeof body.session_id === "string" && body.session_id.trim()
            ? body.session_id.trim()
            : null) ??
            (typeof body.previous_response_id === "string" && body.previous_response_id.trim()
                ? body.previous_response_id.trim()
                : null) ??
            req.headers["x-session-id"]?.trim() ??
            crypto.randomUUID();
        // SSE headers
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no"); // Nginx proxy buffering'i kapat
        res.flushHeaders();
        // Anında "status" eventi — kullanıcı boş ekran görmez
        sseWrite(res, "status", { message: "Terapistler aranıyor..." });
        try {
            const clientHistory = Array.isArray(body.history) ? body.history : null;
            let history;
            if (clientHistory) {
                history = clientHistory.filter((m) => m !== null &&
                    typeof m === "object" &&
                    (m.role === "user" || m.role === "assistant") &&
                    typeof m.content === "string");
            }
            else {
                history = await getHistory(sessionId);
            }
            const { response: rawResponse2, updatedHistory } = await runChat({ message, history });
            const response = await enrichBareExpertTags(rawResponse2);
            saveHistory(sessionId, updatedHistory).catch((err) => console.error("[planda] saveHistory error:", err));
            // Yanıtı SSE eventi olarak gönder
            sseWrite(res, "response", {
                response,
                message: response,
                session_id: sessionId,
                previous_response_id: sessionId,
            });
            sseWrite(res, "done", { session_id: sessionId });
        }
        catch (err) {
            console.error("[planda] /v1/assistant/chat/stream error:", err);
            sseWrite(res, "error", { error: "Assistant unavailable. Please try again." });
        }
        finally {
            res.end();
        }
    });
    // ── POST /api/chat — legacy stateless endpoint (history in body) ─────────────
    app.post("/api/chat", async (req, res) => {
        if (!process.env.OPENAI_API_KEY) {
            res.status(500).json({ error: "OPENAI_API_KEY not configured" });
            return;
        }
        const { message, history } = req.body;
        if (!message) {
            res.status(400).json({ error: "message is required" });
            return;
        }
        try {
            const result = await runWorkflow({ input_as_text: message, history: history ?? [] });
            const rawText = result.output_text ?? JSON.stringify(result);
            const text = await enrichBareExpertTags(rawText);
            res.json({ response: text });
        }
        catch (err) {
            console.error("[planda] /api/chat error:", err);
            res.status(502).json({ error: String(err) });
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
    process.exit(1);
});
process.on("unhandledRejection", (reason) => {
    console.error("[planda] Unhandled rejection:", reason);
    process.exit(1);
});
// ─── Entry point ──────────────────────────────────────────────────────────────
console.log("[planda] Starting up — Node", process.version);
console.log("[planda] PORT:", process.env.PORT ?? "3000 (default)");
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