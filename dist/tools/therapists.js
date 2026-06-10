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
import { z } from "zod";
import { ListInputSchema, GetInputSchema, HoursInputSchema, AvailableDaysInputSchema, EmptyInputSchema, handleFindTherapists, handleGetTherapist, handleListSpecialties, handleGetTherapistHours, handleGetTherapistAvailableDays, handleGetActiveCities, FIND_THERAPISTS_DESCRIPTION, GET_THERAPIST_DESCRIPTION, LIST_SPECIALTIES_DESCRIPTION, GET_HOURS_DESCRIPTION, GET_DAYS_DESCRIPTION, GET_ACTIVE_CITIES_DESCRIPTION, } from "./handlers.js";
// ─── Output schemas (structuredContent) ─────────────────────────────────────
//
// Declared so ChatGPT/MCP clients understand each tool's result shape. Kept
// deliberately LOOSE: the Planda API returns rich, variable records, and the
// MCP SDK validates structuredContent against these schemas on every call —
// a too-strict schema would turn a stray null/extra field into a tool error.
// Strategy: document the top-level fields, allow nulls (.nullish()), and let
// unknown keys through (.passthrough()). Heavy nested records pass as-is.
const TherapistOutputSchema = z
    .object({
    id: z.union([z.number(), z.string()]).optional(),
    full_name: z.string().nullish(),
    username: z.string().nullish(),
    gender: z.string().nullish(),
})
    .passthrough()
    .describe("A single therapist record (additional fields passed through).");
const FindTherapistsOutputSchema = z
    .object({
    total: z.number().optional().describe("Total therapists matching the query."),
    count: z.number().optional().describe("Number of therapists in this response."),
    page: z.number().optional(),
    per_page: z.number().optional(),
    has_more: z.boolean().optional(),
    next_page: z.number().nullish(),
    therapists: z.array(TherapistOutputSchema),
    truncated: z.boolean().optional(),
    truncation_message: z.string().optional(),
})
    .passthrough();
const SpecialtiesOutputSchema = z
    .object({
    // z.unknown() — element shape is {id, name} in practice, but kept fully
    // permissive so a payload variation can never fail output validation.
    specialties: z.array(z.unknown()).describe("Specialty areas ({id, name})."),
})
    .passthrough();
const HoursOutputSchema = z
    .object({
    date: z.string().optional(),
    slots: z.array(z.unknown()).describe("Bookable time slots (string or object)."),
})
    .passthrough();
const DaysOutputSchema = z
    .object({
    days: z.array(z.unknown()).describe("Available dates (YYYY-MM-DD or objects)."),
})
    .passthrough();
const CitiesOutputSchema = z
    .object({
    cities: z.array(z.string()).describe("Active city names."),
})
    .passthrough();
/** Map a transport-independent handler result onto the MCP response shape. */
function toMcpResult(result) {
    if (result.isError) {
        return { content: [{ type: "text", text: result.text }], isError: true };
    }
    return {
        content: [{ type: "text", text: result.text }],
        structuredContent: result.structured,
    };
}
// ─── Tool registration ────────────────────────────────────────────────────────
export function registerTherapistTools(server) {
    // ── 1. find_therapists ───────────────────────────────────────────────────────
    server.registerTool("find_therapists", {
        title: "Find Planda Therapists",
        description: FIND_THERAPISTS_DESCRIPTION,
        inputSchema: ListInputSchema,
        outputSchema: FindTherapistsOutputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (params) => toMcpResult(await handleFindTherapists(params)));
    // ── 2. get_therapist ─────────────────────────────────────────────────────────
    server.registerTool("get_therapist", {
        title: "Get Therapist Detail",
        description: GET_THERAPIST_DESCRIPTION,
        inputSchema: GetInputSchema,
        outputSchema: TherapistOutputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async (params) => toMcpResult(await handleGetTherapist(params)));
    // ── 3. list_specialties ──────────────────────────────────────────────────────
    server.registerTool("list_specialties", {
        title: "List Specialties",
        description: LIST_SPECIALTIES_DESCRIPTION,
        inputSchema: EmptyInputSchema,
        outputSchema: SpecialtiesOutputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async () => toMcpResult(await handleListSpecialties()));
    // ── 4. get_therapist_hours ───────────────────────────────────────────────────
    server.registerTool("get_therapist_hours", {
        title: "Get Therapist Available Hours",
        description: GET_HOURS_DESCRIPTION,
        inputSchema: HoursInputSchema,
        outputSchema: HoursOutputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (params) => toMcpResult(await handleGetTherapistHours(params)));
    // ── 5. get_therapist_available_days ─────────────────────────────────────────
    server.registerTool("get_therapist_available_days", {
        title: "Get Therapist Available Days",
        description: GET_DAYS_DESCRIPTION,
        inputSchema: AvailableDaysInputSchema,
        outputSchema: DaysOutputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (params) => toMcpResult(await handleGetTherapistAvailableDays(params)));
    // ── 6. get_active_cities ─────────────────────────────────────────────────────
    server.registerTool("get_active_cities", {
        title: "Get Active Cities",
        description: GET_ACTIVE_CITIES_DESCRIPTION,
        inputSchema: EmptyInputSchema,
        outputSchema: CitiesOutputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async () => toMcpResult(await handleGetActiveCities()));
}
//# sourceMappingURL=therapists.js.map