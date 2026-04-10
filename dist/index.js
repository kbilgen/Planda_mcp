#!/usr/bin/env node
/**
 * Planda MCP Server
 *
 * Endpoints:
 *   GET  /health                  — liveness check
 *   POST /v1/assistant/chat       — iOS / mobile chat (session-aware)
 *   POST /api/chat                — legacy compat (stateless, history in body)
 *   POST /mcp                     — MCP JSON-RPC (AI clients)
 *   GET  /mcp                     — MCP SSE stream
 *   DELETE /mcp                   — MCP session termination
 *
 * Environment variables:
 *   PORT            — HTTP port (Railway sets automatically)
 *   TRANSPORT       — "http" (default) | "stdio"
 *   OPENAI_API_KEY  — Required for /v1/assistant/chat and /api/chat
 *   PLANDA_API_KEY  — Optional Bearer token for Planda API
 *   CORS_ORIGIN     — Allowed CORS origin (default: "*")
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import cors from "cors";
import { registerTherapistTools } from "./tools/therapists.js";
import { runWorkflow } from "./workflow.js";
import { runChat } from "./workflow.js";
import { getHistory, saveHistory, sessionCount } from "./sessionStore.js";
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
        allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id", "X-Session-Id"],
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
    // ── POST /v1/assistant/chat — iOS / mobile ana endpoint ─────────────────────
    //
    // Request:
    //   { "message": "string", "session_id": "uuid | null" }
    //
    // Response:
    //   { "response": "string", "session_id": "uuid" }
    //
    // session_id yoksa yeni oturum başlatılır.
    // Sunucu history'yi saklar — client sadece session_id taşır.
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
        // session_id: body veya X-Session-Id header'dan al; yoksa yeni üret
        const sessionId = (typeof body.session_id === "string" && body.session_id.trim()
            ? body.session_id.trim()
            : null) ??
            req.headers["x-session-id"]?.trim() ??
            crypto.randomUUID();
        try {
            const history = getHistory(sessionId);
            const { response, updatedHistory } = await runChat({ message, history });
            saveHistory(sessionId, updatedHistory);
            // Return both field names for iOS/client compatibility
            res.json({
                response, // current field name
                message: response, // alias — some clients may expect this
                session_id: sessionId,
                previous_response_id: sessionId, // alias for OpenAI Responses API compat
            });
        }
        catch (err) {
            console.error("[planda] /v1/assistant/chat error:", err);
            res.status(502).json({ error: "Assistant unavailable. Please try again." });
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
            const text = result.output_text ?? JSON.stringify(result);
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