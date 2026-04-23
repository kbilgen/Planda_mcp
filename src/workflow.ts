/**
 * Planda Assistant — Workflow (OpenAI Agents SDK)
 */

import { OpenAI } from "openai";
import { runGuardrails } from "@openai/guardrails";
import { hostedMcpTool, Agent, Runner, withTrace } from "@openai/agents";
import type { AgentInputItem } from "@openai/agents";
import { SYSTEM_PROMPT } from "./prompts.js";
import type { ChatMessage } from "./sessionStore.js";
import type { ToolCallLog } from "./logger.js";
import { extractToolCalls } from "./logger.js";

// ─── Guardrails (optional — skipped if OPENAI_API_KEY missing) ───────────────

let _guardrailsClient: OpenAI | null = null;
function getGuardrailsClient(): OpenAI {
  if (!_guardrailsClient) _guardrailsClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  return _guardrailsClient;
}

const GUARDRAILS_CONFIG = {
  guardrails: [
    {
      name: "Moderation",
      config: {
        categories: [
          "sexual/minors",
          "hate/threatening",
          "harassment/threatening",
          "self-harm/instructions",
          "violence/graphic",
          "illicit/violent",
        ],
      },
    },
  ],
};

async function checkGuardrails(text: string): Promise<{ blocked: boolean; reason?: string }> {
  if (!process.env.OPENAI_API_KEY) return { blocked: false };
  try {
    const results = (await runGuardrails(
      text,
      GUARDRAILS_CONFIG as never,
      { guardrailLlm: getGuardrailsClient() },
      true
    )) as Array<{ tripwireTriggered?: boolean; info?: { flagged_categories?: string[] } }>;
    const blocked = results.some((r) => r.tripwireTriggered === true);
    if (!blocked) return { blocked: false };
    const flagged = results.flatMap((r) => r.info?.flagged_categories ?? []).join(", ");
    return { blocked: true, reason: flagged || "content policy violation" };
  } catch {
    return { blocked: false };
  }
}

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface ChatInput {
  message: string;
  history: ChatMessage[];
}

export interface ChatOutput {
  response: string;
  updatedHistory: ChatMessage[];
  toolCalls?: ToolCallLog[];
  model?: string;
}

export interface ChatStreamCallbacks {
  onStatus?: (message: string) => void;
  onDelta?: (delta: string) => void;
}

const SAFE_RESPONSE = "Bu konuda sana yardımcı olamıyorum. Uygun bir terapist bulmak için buradayım — devam edelim mi?";
const CHAT_TIMEOUT_MS = parseInt(process.env.CHAT_TIMEOUT_MS ?? "90000", 10);

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Chat timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// ─── OpenAI Agents path ───────────────────────────────────────────────────────

let _openaiAgent: InstanceType<typeof Agent> | null = null;
let _openaiRunner: InstanceType<typeof Runner> | null = null;

function getOpenAIAgent(): InstanceType<typeof Agent> {
  if (!_openaiAgent) {
    const mcp = hostedMcpTool({
      serverLabel: "Kaan_mcp",
      allowedTools: ["find_therapists", "get_therapist", "list_specialties", "get_therapist_hours", "get_therapist_available_days"],
      requireApproval: "never",
      serverUrl: process.env.MCP_SERVER_URL ?? "https://plandamcp-production.up.railway.app/mcp",
    });
    _openaiAgent = new Agent({
      name: "PlandaAssistant",
      instructions: SYSTEM_PROMPT,
      model: (process.env.OPENAI_MODEL ?? "gpt-4.1-mini") as string,
      tools: [mcp],
      modelSettings: { store: true },
    });
  }
  return _openaiAgent;
}

function getOpenAIRunner(): InstanceType<typeof Runner> {
  if (!_openaiRunner) _openaiRunner = new Runner();
  return _openaiRunner;
}

async function runOpenAIChat(input: ChatInput): Promise<ChatOutput> {
  return withTrace("PlandaChat", async () => {
    const items: AgentInputItem[] = [
      ...input.history.map((m): AgentInputItem =>
        m.role === "user"
          ? { role: "user", content: m.content }
          : { role: "assistant", status: "completed", content: [{ type: "output_text", text: m.content }] } as AgentInputItem
      ),
      { role: "user", content: [{ type: "input_text", text: input.message }] },
    ];
    const result = await getOpenAIRunner().run(getOpenAIAgent(), items);
    const text = String(result.finalOutput ?? "");
    const toolCalls = extractToolCalls(result);

    // Diagnostic: full key dump of raw items to identify hosted MCP tool name
    // field. Toggle via DEBUG_TOOL_CALLS=1.
    if (process.env.DEBUG_TOOL_CALLS === "1") {
      const probe = {
        extracted: toolCalls.length,
        newItems: Array.isArray((result as { newItems?: unknown[] }).newItems)
          ? (result as { newItems?: unknown[] }).newItems!.slice(0, 6).map((i: unknown) => {
              const w = i as { type?: string; rawItem?: Record<string, unknown> };
              const r = w.rawItem ?? {};
              return {
                wType: w.type,
                rType: r.type,
                rName: r.name,
                rKeys: Object.keys(r),
                rSample: JSON.stringify(r).slice(0, 400),
              };
            })
          : null,
      };
      console.log("[workflow] raw probe:", JSON.stringify(probe));
    }

    const model = (process.env.OPENAI_MODEL ?? "gpt-4.1-mini");
    return {
      response: text,
      updatedHistory: [...input.history, { role: "user" as const, content: input.message }, { role: "assistant" as const, content: text }],
      toolCalls,
      model,
    };
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runChat(input: ChatInput): Promise<ChatOutput> {
  const guard = await checkGuardrails(input.message);
  if (guard.blocked) {
    return {
      response: SAFE_RESPONSE,
      updatedHistory: [...input.history, { role: "user" as const, content: input.message }, { role: "assistant" as const, content: SAFE_RESPONSE }],
    };
  }
  return withTimeout(runOpenAIChat(input), CHAT_TIMEOUT_MS);
}

export async function runChatStream(input: ChatInput, callbacks: ChatStreamCallbacks): Promise<ChatOutput> {
  const guard = await checkGuardrails(input.message);
  if (guard.blocked) {
    callbacks.onDelta?.(SAFE_RESPONSE);
    return {
      response: SAFE_RESPONSE,
      updatedHistory: [...input.history, { role: "user" as const, content: input.message }, { role: "assistant" as const, content: SAFE_RESPONSE }],
    };
  }
  const result = await withTimeout(runOpenAIChat(input), CHAT_TIMEOUT_MS);
  callbacks.onDelta?.(result.response);
  return result;
}

// ─── runWorkflow — /api/chat için (geriye dönük uyumluluk) ───────────────────

export type WorkflowInput = {
  input_as_text: string;
  history?: { role: "user" | "assistant"; content: string }[];
};

export const runWorkflow = async (workflow: WorkflowInput) => {
  const all: ChatMessage[] = workflow.history ?? [];
  const last = all[all.length - 1];
  const history: ChatMessage[] =
    last?.role === "user" && last?.content === workflow.input_as_text ? all.slice(0, -1) : all;
  const result = await runChat({ message: workflow.input_as_text, history });
  return {
    output_text: result.response,
    toolCalls: result.toolCalls,
    model: result.model,
  };
};
