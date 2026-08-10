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
 *   OPENAI_API_KEY        — Chat endpoints via OpenAI (default provider)
 *   AI_PROVIDER           — "openai" (default) | "claude" (requires ANTHROPIC_API_KEY)
 *   ANTHROPIC_API_KEY     — Chat endpoints via Claude (claude-fable-5)
 *   CORS_ORIGIN           — Allowed CORS origin (default: "*")
 *   REDIS_URL             — Redis connection string for persistent sessions
 */
export {};
//# sourceMappingURL=index.d.ts.map