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
 *   - Set TRANSPORT=http to run as a Streamable HTTP server (default port 3000)
 *   - Leave unset (or set TRANSPORT=stdio) for stdio mode (local Claude integration)
 *
 * Optional env vars:
 *   - PLANDA_API_KEY  : Bearer token for authenticated Planda API calls
 *   - PORT            : HTTP server port (default 3000, only for HTTP transport)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { registerTherapistTools } from "./tools/therapists.js";

// ─── Server instance ──────────────────────────────────────────────────────────

const server = new McpServer({
  name: "planda-mcp-server",
  version: "1.0.0",
});

registerTherapistTools(server);

// ─── Transport: stdio ─────────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[planda-mcp-server] Running via stdio transport");
}

// ─── Transport: Streamable HTTP ───────────────────────────────────────────────

async function runHttp(): Promise<void> {
  const app = express();
  app.use(express.json());

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "planda-mcp-server", version: "1.0.0" });
  });

  // MCP endpoint — a new stateless transport instance per request
  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });

    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT ?? "3000", 10);
  app.listen(port, () => {
    console.error(
      `[planda-mcp-server] Running via HTTP transport on http://localhost:${port}/mcp`
    );
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const transport = (process.env.TRANSPORT ?? "stdio").toLowerCase();

if (transport === "http") {
  runHttp().catch((err: unknown) => {
    console.error("[planda-mcp-server] Fatal error:", err);
    process.exit(1);
  });
} else {
  runStdio().catch((err: unknown) => {
    console.error("[planda-mcp-server] Fatal error:", err);
    process.exit(1);
  });
}
