#!/usr/bin/env node
/**
 * Planda MCP Server
 *
 * Endpoints:
 *   GET  /health                    — liveness check (no auth)
 *   POST /v1/assistant/chat         — iOS chat, buffered  [API key + user token]
 *   POST /v1/assistant/chat/stream  — iOS chat, SSE       [API key + user token]
 *   GET  /v1/assistant/history      — fetch session msgs  [API key + user token]
 *   POST /api/chat                  — legacy stateless     [API key + user token]
 *   POST /mcp                       — MCP JSON-RPC (AI clients, no user token)
 *   GET  /mcp                       — MCP SSE stream
 *   DELETE /mcp                     — MCP session termination
 *
 * iOS auth flow:
 *   X-API-Key:    <API_SECRET_KEY>          shared app secret
 *   Authorization: Bearer <planda_token>     user's Sanctum token from login
 * Server validates the bearer against Planda /marketplace/user (auth.ts),
 * caches success in Redis 5 min. Set SKIP_USER_AUTH=1 only for local dev.
 *
 * Environment variables:
 *   PORT                  — HTTP port (Railway sets automatically)
 *   TRANSPORT             — "http" (default) | "stdio"
 *   OPENAI_API_KEY        — Required for chat endpoints
 *   API_SECRET_KEY        — Required: shared app secret (X-API-Key header)
 *   PLANDA_AUTH_ENDPOINT  — Override Planda token-validate URL (default: /marketplace/user)
 *   SKIP_USER_AUTH        — "1" to bypass user-token check (DEV ONLY)
 *   CORS_ORIGIN           — Allowed CORS origin (default: "*")
 *   REDIS_URL             — Redis connection string for persistent sessions
 */
export {};
//# sourceMappingURL=index.d.ts.map