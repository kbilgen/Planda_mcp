#!/usr/bin/env node
/**
 * Planda MCP Server
 *
 * Provides LLM tools to query the Planda marketplace therapist API.
 *
 * Tools:
 *   - planda_list_therapists   : Paginated list with filters
 *   - planda_get_therapist     : Single therapist profile by ID
 *   - planda_search_therapists : Free-text search
 *
 * Transport:
 *   - Set TRANSPORT=http (or leave unset on Hostinger) to run as HTTP server
 *   - Set TRANSPORT=stdio for local Claude Desktop integration
 *
 * Environment variables:
 *   - PORT            : HTTP server port (Hostinger sets this automatically)
 *   - TRANSPORT       : "http" (default on Hostinger) or "stdio"
 *   - PLANDA_API_KEY  : Optional Bearer token for authenticated Planda API calls
 *   - CORS_ORIGIN     : Allowed CORS origin (default: "*" — open for OpenAI)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import cors from "cors";
import axios from "axios";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { registerTherapistTools } from "./tools/therapists.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// ─── Factory: create a fresh MCP server instance (for stateless HTTP mode) ───
function createMcpServer() {
    const server = new McpServer({
        name: "planda-mcp-server",
        version: "1.0.0",
    });
    registerTherapistTools(server);
    return server;
}
// ─── Transport: stdio (local use) ────────────────────────────────────────────
async function runStdio() {
    const transport = new StdioServerTransport();
    const server = createMcpServer();
    await server.connect(transport);
    console.log("[planda-mcp-server] Running via stdio transport");
}
// ─── Transport: Streamable HTTP (Hostinger / remote) ─────────────────────────
async function runHttp() {
    const app = express();
    // ── CORS ─────────────────────────────────────────────────────────────────────
    // OpenAI Playground and Agents SDK call from their servers — allow all origins.
    // Restrict via CORS_ORIGIN env var if you want tighter control.
    const corsOrigin = process.env.CORS_ORIGIN ?? "*";
    app.use(cors({
        origin: corsOrigin,
        methods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id"],
        exposedHeaders: ["Mcp-Session-Id"],
    }));
    // Handle OPTIONS preflight for all routes (Express 4 compatible)
    app.options("*", cors());
    app.use(express.json());
    // ── Health check ──────────────────────────────────────────────────────────────
    app.get("/health", (_req, res) => {
        res.json({ status: "ok", server: "planda-mcp-server", version: "1.0.0" });
    });
    // ── Static UI files ───────────────────────────────────────────────────────────
    app.use(express.static(join(__dirname, "../public")));
    // ── Chat API — proxies to OpenAI workflow ─────────────────────────────────────
    app.post("/api/chat", async (req, res) => {
        const { message } = req.body;
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            res.status(500).json({ error: "OPENAI_API_KEY not set" });
            return;
        }
        try {
            const response = await axios.post("https://api.openai.com/v1/responses", {
                workflow_id: "wf_69ceac5a340c81908ac3f8d49e1afa0103e85e9ffaa5af21",
                input: message,
            }, {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                timeout: 60_000,
            });
            const output = response.data?.output ?? [];
            const text = output.find((o) => o.type === "message")
                ?.content?.[0]?.text ?? JSON.stringify(response.data);
            res.json({ response: text });
        }
        catch (err) {
            const msg = axios.isAxiosError(err)
                ? err.response?.data ?? err.message
                : String(err);
            console.log("[planda-mcp-server] /api/chat error:", msg);
            res.status(502).json({ error: msg });
        }
    });
    // ── Root → serve UI ───────────────────────────────────────────────────────────
    app.get("/", (_req, res) => {
        res.sendFile(join(__dirname, "../public/index.html"));
    });
    // ── MCP endpoint — POST (JSON-RPC) ────────────────────────────────────────────
    // Each request gets its own McpServer + transport instance (stateless mode).
    // SDK 1.x throws "Already connected" if connect() is called twice on the same
    // server instance, so we must create a fresh server per request.
    app.post("/mcp", async (req, res) => {
        try {
            const server = createMcpServer();
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined, // stateless — no session cookies
                enableJsonResponse: true, // return plain JSON, not SSE stream
            });
            res.on("close", () => {
                transport.close().catch(() => { });
            });
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        }
        catch (err) {
            console.log("[planda-mcp-server] POST /mcp error:", err);
            if (!res.headersSent) {
                res.status(500).json({ error: "Internal server error" });
            }
        }
    });
    // ── MCP endpoint — GET (SSE streaming, required by some MCP clients) ─────────
    app.get("/mcp", async (req, res) => {
        try {
            const server = createMcpServer();
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                enableJsonResponse: false, // SSE mode for GET
            });
            res.on("close", () => {
                transport.close().catch(() => { });
            });
            await server.connect(transport);
            await transport.handleRequest(req, res);
        }
        catch (err) {
            console.log("[planda-mcp-server] GET /mcp error:", err);
            if (!res.headersSent) {
                res.status(500).json({ error: "Internal server error" });
            }
        }
    });
    // ── MCP endpoint — DELETE (session termination) ───────────────────────────────
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
            console.log("[planda-mcp-server] DELETE /mcp error:", err);
            if (!res.headersSent) {
                res.status(500).json({ error: "Internal server error" });
            }
        }
    });
    // ── Listen on 0.0.0.0 (required for Hostinger / container envs) ─────────────
    const port = parseInt(process.env.PORT ?? "3000", 10);
    app.listen(port, "0.0.0.0", () => {
        console.log(`[planda-mcp-server] HTTP server listening on 0.0.0.0:${port}`);
        console.log(`[planda-mcp-server] MCP endpoint: http://0.0.0.0:${port}/mcp`);
    });
}
// ─── Entry point ──────────────────────────────────────────────────────────────
// Hostinger Node.js hosting: set TRANSPORT=http in environment variables panel.
// Default is also "http" here since this server is deployed as a web service.
process.on("uncaughtException", (err) => {
    console.log("[planda-mcp-server] Uncaught exception:", err);
    process.exit(1);
});
process.on("unhandledRejection", (reason) => {
    console.log("[planda-mcp-server] Unhandled rejection:", reason);
    process.exit(1);
});
console.log("[planda-mcp-server] Starting up...");
console.log("[planda-mcp-server] Node version:", process.version);
console.log("[planda-mcp-server] PORT env:", process.env.PORT);
const transportMode = (process.env.TRANSPORT ?? "http").toLowerCase();
if (transportMode === "stdio") {
    runStdio().catch((err) => {
        console.log("[planda-mcp-server] Fatal error:", err);
        process.exit(1);
    });
}
else {
    runHttp().catch((err) => {
        console.log("[planda-mcp-server] Fatal error:", err);
        process.exit(1);
    });
}
//# sourceMappingURL=index.js.map