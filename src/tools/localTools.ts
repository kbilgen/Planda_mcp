/**
 * In-process tool definitions for the chat agent (@openai/agents).
 *
 * Why this exists: workflow.ts historically used hostedMcpTool, which makes
 * OpenAI dial back into our own public /mcp endpoint over the internet for
 * every tool call — an extra network round-trip per call, and a hard
 * dependency on our public URL being reachable mid-deploy. These local tools
 * run the exact same handlers (handlers.ts) inside this process instead.
 *
 * Enabled via USE_LOCAL_TOOLS=1 (see workflow.ts). Default stays hosted MCP
 * so production behaviour is unchanged until the flag is flipped.
 *
 * Design notes:
 *   • Tool names/descriptions are identical to the MCP registrations, so the
 *     model, intent classifier (expectedTools) and guards see no difference.
 *   • Parameters are passed as non-strict JSON Schema (derived from the same
 *     Zod schemas). Validation happens in execute() via Zod safeParse — on
 *     invalid input the model receives an actionable error string and can
 *     self-correct, mirroring MCP's validation-error behaviour.
 *   • execute() returns the handler's markdown text — the same text content
 *     the model received through the hosted MCP path.
 *   • All tools are read-only. If a write tool (e.g. create_appointment) is
 *     ever added, route it through an approval flow (needsApproval) — see the
 *     prompt-injection note in workflow.ts.
 */

import { tool } from "@openai/agents";
import { z } from "zod";
import {
  ListInputSchema,
  GetInputSchema,
  HoursInputSchema,
  AvailableDaysInputSchema,
  handleFindTherapists,
  handleGetTherapist,
  handleListSpecialties,
  handleGetTherapistHours,
  handleGetTherapistAvailableDays,
  FIND_THERAPISTS_DESCRIPTION,
  GET_THERAPIST_DESCRIPTION,
  LIST_SPECIALTIES_DESCRIPTION,
  GET_HOURS_DESCRIPTION,
  GET_DAYS_DESCRIPTION,
} from "./handlers.js";

// Mirrors the SDK's JsonObjectSchemaNonStrict — additionalProperties must be
// the literal `true` for the strict:false tool() overload to apply. Unknown
// keys are still rejected at runtime by the Zod .strict() parse in execute().
type JsonObjectSchema = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: true;
};

const PERMISSIVE_SCHEMA: JsonObjectSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: true,
};

/**
 * Convert a Zod schema to non-strict JSON Schema for the model. Falls back to
 * a permissive object schema if conversion fails (e.g. an unrepresentable
 * refinement) — execute() still validates with Zod, so correctness is kept;
 * only the model-side hinting degrades.
 */
function toJsonSchema(schema: z.ZodType): JsonObjectSchema {
  try {
    const js = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
    delete js["$schema"];
    return {
      type: "object",
      properties: (js.properties as Record<string, Record<string, unknown>>) ?? {},
      required: Array.isArray(js.required) ? (js.required as string[]) : [],
      additionalProperties: true,
    };
  } catch (err) {
    console.warn("[localTools] zod→JSON Schema conversion failed, using permissive schema:", err);
    return PERMISSIVE_SCHEMA;
  }
}

/** Validate raw model input with Zod; run the handler; return its text. */
async function validateAndRun<S extends z.ZodType>(
  schema: S,
  input: unknown,
  run: (params: z.infer<S>) => Promise<{ text: string }>
): Promise<string> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return `Error: Invalid tool parameters — ${issues}. Fix the arguments and retry.`;
  }
  const result = await run(parsed.data);
  return result.text;
}

/**
 * Build the in-process tool set for the chat agent.
 *
 * Tool list intentionally mirrors the hosted-MCP `allowedTools` allowlist
 * (find_therapists, get_therapist, list_specialties, get_therapist_hours,
 * get_therapist_available_days) so switching modes never changes what the
 * model can do. get_active_cities stays MCP-only, as before.
 */
export function buildLocalTools() {
  return [
    tool({
      name: "find_therapists",
      description: FIND_THERAPISTS_DESCRIPTION,
      parameters: toJsonSchema(ListInputSchema),
      strict: false,
      execute: (input: unknown) =>
        validateAndRun(ListInputSchema, input, handleFindTherapists),
    }),
    tool({
      name: "get_therapist",
      description: GET_THERAPIST_DESCRIPTION,
      parameters: toJsonSchema(GetInputSchema),
      strict: false,
      execute: (input: unknown) =>
        validateAndRun(GetInputSchema, input, handleGetTherapist),
    }),
    tool({
      name: "list_specialties",
      description: LIST_SPECIALTIES_DESCRIPTION,
      parameters: PERMISSIVE_SCHEMA,
      strict: false,
      execute: async () => (await handleListSpecialties()).text,
    }),
    tool({
      name: "get_therapist_hours",
      description: GET_HOURS_DESCRIPTION,
      parameters: toJsonSchema(HoursInputSchema),
      strict: false,
      execute: (input: unknown) =>
        validateAndRun(HoursInputSchema, input, handleGetTherapistHours),
    }),
    tool({
      name: "get_therapist_available_days",
      description: GET_DAYS_DESCRIPTION,
      parameters: toJsonSchema(AvailableDaysInputSchema),
      strict: false,
      execute: (input: unknown) =>
        validateAndRun(AvailableDaysInputSchema, input, handleGetTherapistAvailableDays),
    }),
  ];
}
