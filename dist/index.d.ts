#!/usr/bin/env node
/**
 * Planda MCP Server
 *
 * Endpoints:
 *   GET  /health                    — liveness check (no auth)
 *   POST /v1/assistant/chat         — iOS chat, buffered (requires X-API-Key)
 *   GET  /v1/assistant/chat/stream  — iOS chat, SSE streaming (requires X-API-Key)
 *   POST /api/chat                  — legacy compat, stateless (no auth)
 *   POST /mcp                       — MCP JSON-RPC (AI clients)
 *   GET  /mcp                       — MCP SSE stream
 *   DELETE /mcp                     — MCP session termination
 *
 * Environment variables:
 *   PORT            — HTTP port (Railway sets automatically)
 *   TRANSPORT       — "http" (default) | "stdio"
 *   OPENAI_API_KEY  — Required for chat endpoints
 *   API_SECRET_KEY  — Required: shared secret iOS app sends as X-API-Key header
 *   PLANDA_API_KEY  — Optional Bearer token for Planda API
 *   CORS_ORIGIN     — Allowed CORS origin (default: "*")
 *   REDIS_URL       — Redis connection string for persistent sessions
 */
export {};
//# sourceMappingURL=index.d.ts.map