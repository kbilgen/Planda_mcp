#!/usr/bin/env node
/**
 * Planda MCP Server
 *
 * Endpoints:
 *   GET  /health                    — liveness check (no auth)
 *   POST /v1/assistant/chat         — iOS chat, buffered (requires Planda Bearer token)
 *   GET  /v1/assistant/chat/stream  — iOS chat, SSE streaming (requires Planda Bearer token)
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
 *   PLANDA_AUTH_ENDPOINT  — Optional override for token validation URL
 *                           (default: https://app.planda.org/api/v1/marketplace/user)
 */
export {};
//# sourceMappingURL=index.d.ts.map