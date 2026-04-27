/**
 * Planda MCP Server — Therapist Tools
 *
 * Registers tools on the provided McpServer instance:
 *   1. find_therapists               — paginated list with optional filters
 *   2. get_therapist                 — single therapist detail (username preferred, id fallback)
 *   3. list_specialties              — all specialty areas
 *   4. get_therapist_hours           — available time slots for a date
 *   5. get_therapist_available_days  — available dates for a branch
 *   6. get_active_cities             — cities with active therapists
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export declare function registerTherapistTools(server: McpServer): void;
//# sourceMappingURL=therapists.d.ts.map