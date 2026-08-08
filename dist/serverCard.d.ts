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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
/** Public URL of the MCP endpoint this card describes. */
export declare const DEFAULT_MCP_ENDPOINT = "https://plandamcp-production.up.railway.app/mcp";
export interface ServerCard {
    $schema: string;
    version: string;
    protocolVersion: string;
    serverInfo: {
        name: string;
        title?: string;
        version: string;
    };
    description?: string;
    documentationUrl?: string;
    transport: {
        type: "streamable-http";
        endpoint: string;
    };
    capabilities: Record<string, unknown>;
    authentication?: {
        required: boolean;
        schemes?: string[];
    };
    instructions?: string;
    tools?: unknown[];
    resources?: unknown[];
    prompts?: unknown[];
}
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
export declare function buildServerCard(createServer: () => McpServer, opts: BuildServerCardOptions): Promise<ServerCard>;
/**
 * Memoising wrapper — the card is static, so build it once. A failed build is
 * not cached, so a transient error doesn't poison the endpoint permanently.
 */
export declare function createServerCardProvider(createServer: () => McpServer, opts: BuildServerCardOptions): () => Promise<ServerCard>;
//# sourceMappingURL=serverCard.d.ts.map