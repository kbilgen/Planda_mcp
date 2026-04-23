/**
 * Planda Assistant — Structured conversation logger
 *
 * Writes one JSON object per turn to `logs/conversations.jsonl`.
 * Also emits a one-line summary to stdout for Railway log capture.
 *
 * Disable with LOG_CONVERSATIONS=0. Override path with CONVERSATION_LOG_PATH.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface ToolCallLog {
  name: string;
  arguments: string;
  output?: string;
  durationMs?: number;
}

export interface GuardViolation {
  kind: "unknown_therapist" | "unknown_username" | "intent_mismatch" | "other";
  detail: string;
}

export interface TurnLog {
  ts: string;
  sessionId: string;
  userMessage: string;
  response: string;
  toolCalls: ToolCallLog[];
  latencyMs: number;
  model?: string;
  endpoint?: string;
  guardrailsBlocked?: boolean;
  intent?: string;
  violations?: GuardViolation[];
  error?: string;
}

const ENABLED = process.env.LOG_CONVERSATIONS !== "0";
const LOG_PATH = resolve(
  process.env.CONVERSATION_LOG_PATH ?? "logs/conversations.jsonl"
);

let dirEnsured = false;
async function ensureDir(): Promise<void> {
  if (dirEnsured) return;
  try {
    await mkdir(dirname(LOG_PATH), { recursive: true });
    dirEnsured = true;
  } catch (err) {
    console.error("[logger] mkdir failed:", err);
  }
}

function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…[truncated]" : s;
}

export async function logTurn(turn: TurnLog): Promise<void> {
  if (!ENABLED) return;

  const safe: TurnLog = {
    ...turn,
    userMessage: truncate(turn.userMessage, 2000),
    response: truncate(turn.response, 8000),
    toolCalls: turn.toolCalls.map((c) => ({
      ...c,
      arguments: truncate(c.arguments, 1500),
      output: truncate(c.output, 3000),
    })),
  };

  const summary =
    `[turn] sid=${safe.sessionId.slice(0, 8)} ` +
    `tools=${safe.toolCalls.map((c) => c.name).join(",") || "-"} ` +
    `ms=${safe.latencyMs} ` +
    (safe.violations?.length ? `violations=${safe.violations.length} ` : "") +
    (safe.error ? `ERROR=${safe.error.slice(0, 80)}` : "");
  console.log(summary);

  try {
    await ensureDir();
    await appendFile(LOG_PATH, JSON.stringify(safe) + "\n", "utf8");
  } catch (err) {
    console.error("[logger] appendFile failed:", err);
  }
}

/**
 * Extract tool calls from @openai/agents Runner result.
 * Defensive — tolerates multiple item shapes (function_call, mcp_call, hosted_tool_call_item).
 */
export function extractToolCalls(result: unknown): ToolCallLog[] {
  const calls: ToolCallLog[] = [];
  const r = result as { newItems?: unknown[]; history?: unknown[] } | null;
  const items = (r?.newItems ?? r?.history ?? []) as unknown[];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const wrapper = item as { type?: string; rawItem?: unknown };
    const raw = (wrapper.rawItem ?? item) as {
      type?: string;
      name?: string;
      arguments?: unknown;
      output?: unknown;
      call_id?: string;
    };
    const type = String(raw.type ?? wrapper.type ?? "");

    const isCall =
      type === "function_call" ||
      type === "mcp_call" ||
      type.endsWith("tool_call_item") ||
      type === "tool_call";
    const isOutput =
      type === "function_call_output" ||
      type === "mcp_call_output" ||
      type.endsWith("tool_call_output_item") ||
      type === "tool_call_output";

    if (isCall) {
      const args =
        typeof raw.arguments === "string"
          ? raw.arguments
          : JSON.stringify(raw.arguments ?? {});
      calls.push({ name: raw.name ?? "unknown", arguments: args });
    } else if (isOutput && calls.length > 0) {
      const out =
        typeof raw.output === "string"
          ? raw.output
          : JSON.stringify(raw.output ?? "");
      calls[calls.length - 1].output = out;
    }
  }
  return calls;
}
