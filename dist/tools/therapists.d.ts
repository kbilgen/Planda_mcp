/**
 * Planda MCP Server — Therapist Tools (MCP adapter)
 *
 * Registers tools on the provided McpServer instance:
 *   1. find_therapists               — paginated list with optional filters
 *   2. get_therapist                 — single therapist detail (username preferred, id fallback)
 *   3. list_specialties              — all specialty areas
 *   4. get_therapist_hours           — available time slots for a date
 *   5. get_therapist_available_days  — available dates for a branch
 *   6. get_active_cities             — cities with active therapists
 *
 * Tool logic lives in handlers.ts (shared with the in-process agent tools in
 * localTools.ts). This file only adapts handler results to the MCP response
 * shape ({ content, structuredContent, isError }).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export declare function registerTherapistTools(server: McpServer): void;
//# sourceMappingURL=therapists.d.ts.map