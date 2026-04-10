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
export {};
//# sourceMappingURL=index.d.ts.map