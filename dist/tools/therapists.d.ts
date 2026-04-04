/**
 * Planda MCP Server — Therapist Tools
 *
 * Registers four tools on the provided McpServer instance:
 *   1. planda_list_therapists   — paginated list with optional filters
 *   2. planda_get_therapist     — single therapist detail by ID
 *   3. planda_search_therapists — keyword / criteria search
 *   4. planda_check_availability — lightweight count check for dynamic conversation
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export declare function registerTherapistTools(server: McpServer): void;
//# sourceMappingURL=therapists.d.ts.map