/**
 * MCP Server Card — SEP-1649 discovery document
 *
 * Serves GET /.well-known/mcp/server-card.json so clients can learn what this
 * server offers (protocol version, capabilities, tools) WITHOUT opening an MCP
 * session first.
 *
 * Design note — nothing here is hand-written metadata. The card is built by
 * running a real `initialize` + `tools/list` handshake against a throwaway
 * McpServer instance over an in-memory transport, so the card is by
 * construction identical to what a client sees on /mcp. If a tool is added or
 * a capability changes, the card follows automatically.
 *
 * The card is built once on first request and cached — the underlying server
 * definition is static for the lifetime of the process.
 *
 * Security: the card is public. It carries no secrets, keys, or tokens — only
 * the tool/capability metadata already returned by an unauthenticated
 * `initialize` call on the public /mcp endpoint.
 */

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

/** Public URL of the MCP endpoint this card describes. */
export const DEFAULT_MCP_ENDPOINT = "https://plandamcp-production.up.railway.app/mcp";

const CARD_SCHEMA_URL =
  "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json";
const CARD_VERSION = "1.0";

export interface ServerCard {
  $schema: string;
  version: string;
  protocolVersion: string;
  serverInfo: { name: string; title?: string; version: string };
  description?: string;
  documentationUrl?: string;
  transport: { type: "streamable-http"; endpoint: string };
  capabilities: Record<string, unknown>;
  authentication?: { required: boolean; schemes?: string[] };
  instructions?: string;
  tools?: unknown[];
  resources?: unknown[];
  prompts?: unknown[];
}

// ─── Minimal JSON-RPC client over the in-memory transport ────────────────────
//
// The SDK's Client class doesn't expose the negotiated protocol version, and
// the card needs the literal `initialize` result. So we speak JSON-RPC
// directly: one round trip for initialize, one for tools/list.

interface JsonRpcResponse {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

const RPC_TIMEOUT_MS = 5000;

class InMemoryRpc {
  private pending = new Map<
    number,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;

  constructor(private transport: InMemoryTransport) {
    this.transport.onmessage = (msg: unknown) => {
      const res = msg as JsonRpcResponse;
      if (res.id === undefined) return; // notification — ignore
      const waiter = this.pending.get(res.id as number);
      if (!waiter) return;
      this.pending.delete(res.id as number);
      waiter.resolve(res);
    };
  }

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`server-card: ${method} timed out`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.transport.send({ jsonrpc: "2.0", id, method, params } as never).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
    if (response.error) {
      throw new Error(`server-card: ${method} failed — ${response.error.message}`);
    }
    return response.result ?? {};
  }

  notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    return this.transport.send({ jsonrpc: "2.0", method, params } as never);
  }
}

// ─── Card construction ───────────────────────────────────────────────────────

export interface BuildServerCardOptions {
  /** Public URL of the /mcp endpoint the card advertises. */
  endpoint: string;
  /** Human-readable summary of the server. */
  description?: string;
  /** Link to human documentation. */
  documentationUrl?: string;
  /**
   * Whether the /mcp endpoint demands credentials. Planda's /mcp is open —
   * the API-key guard only covers the chat endpoints.
   */
  authenticationRequired?: boolean;
}

/**
 * Introspect a live McpServer and render its SEP-1649 Server Card.
 *
 * @param createServer factory producing the same server instance /mcp serves
 */
export async function buildServerCard(
  createServer: () => McpServer,
  opts: BuildServerCardOptions
): Promise<ServerCard> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const rpc = new InMemoryRpc(clientTransport);

  try {
    await server.connect(serverTransport);
    await clientTransport.start();

    // 1. initialize — the card mirrors this response.
    const init = await rpc.request("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "planda-server-card-builder", version: "1.0.0" },
    });
    await rpc.notify("notifications/initialized");

    const capabilities = (init.capabilities ?? {}) as Record<string, unknown>;
    const serverInfo = (init.serverInfo ?? {}) as { name?: string; title?: string; version?: string };
    const protocolVersion = typeof init.protocolVersion === "string"
      ? init.protocolVersion
      : LATEST_PROTOCOL_VERSION;
    const instructions = typeof init.instructions === "string" ? init.instructions : undefined;

    const card: ServerCard = {
      $schema: CARD_SCHEMA_URL,
      version: CARD_VERSION,
      protocolVersion,
      serverInfo: {
        name: serverInfo.name ?? "unknown",
        title: serverInfo.title ?? serverInfo.name ?? undefined,
        version: serverInfo.version ?? "0.0.0",
      },
      transport: { type: "streamable-http", endpoint: opts.endpoint },
      capabilities,
      authentication: { required: opts.authenticationRequired ?? false },
    };

    if (opts.description) card.description = opts.description;
    if (opts.documentationUrl) card.documentationUrl = opts.documentationUrl;
    if (instructions) card.instructions = instructions;

    // 2. Enumerate primitives — only those the server actually advertises.
    // Listing a primitive the server doesn't support would make the card lie.
    if (capabilities.tools) {
      const { tools } = await rpc.request("tools/list", {});
      if (Array.isArray(tools)) card.tools = tools;
    }
    if (capabilities.resources) {
      const { resources } = await rpc.request("resources/list", {});
      if (Array.isArray(resources)) card.resources = resources;
    }
    if (capabilities.prompts) {
      const { prompts } = await rpc.request("prompts/list", {});
      if (Array.isArray(prompts)) card.prompts = prompts;
    }

    return card;
  } finally {
    await Promise.allSettled([clientTransport.close(), server.close()]);
  }
}

/**
 * Memoising wrapper — the card is static, so build it once. A failed build is
 * not cached, so a transient error doesn't poison the endpoint permanently.
 */
export function createServerCardProvider(
  createServer: () => McpServer,
  opts: BuildServerCardOptions
): () => Promise<ServerCard> {
  let cached: Promise<ServerCard> | null = null;
  return () => {
    if (!cached) {
      cached = buildServerCard(createServer, opts).catch((err) => {
        cached = null;
        throw err;
      });
    }
    return cached;
  };
}
