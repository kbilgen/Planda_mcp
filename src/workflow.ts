/**
 * Planda Assistant — Workflow
 *
 * ANTHROPIC_API_KEY set → Claude (claude-haiku-4-5-20251001 default)
 * Otherwise            → OpenAI Agents SDK (gpt-4.1-mini default)
 */

import Anthropic from "@anthropic-ai/sdk";
import { OpenAI } from "openai";
import { runGuardrails } from "@openai/guardrails";
import { SYSTEM_PROMPT } from "./prompts.js";
import { makeApiRequest } from "./services/apiClient.js";
import type { ChatMessage } from "./sessionStore.js";

// ─── Guardrails (OpenAI moderation — optional) ────────────────────────────────

const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "placeholder" });

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
      { guardrailLlm: openaiClient },
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
}

export interface ChatStreamCallbacks {
  onStatus?: (message: string) => void;
  onDelta?: (delta: string) => void;
}

const SAFE_RESPONSE = "Bu konuda sana yardımcı olamıyorum. Uygun bir terapist bulmak için buradayım — devam edelim mi?";

function toolStatusMessage(name: string): string {
  switch (name) {
    case "find_therapists":               return "Terapistler aranıyor...";
    case "get_therapist":                 return "Terapist profili inceleniyor...";
    case "get_therapist_hours":           return "Müsait saatler kontrol ediliyor...";
    case "get_therapist_available_days":  return "Müsait günler kontrol ediliyor...";
    case "list_specialties":              return "Uzmanlık alanları yükleniyor...";
    default:                              return "Bilgiler alınıyor...";
  }
}

// ─── Claude path ──────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "placeholder" });
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";

const CLAUDE_TOOLS: Anthropic.Tool[] = [
  {
    name: "find_therapists",
    description: `Search licensed therapists from Planda (planda.org). Call this FIRST for any therapist search.
Trigger: user asks for a therapist, mentions anxiety/depression/trauma/burnout/relationship issues or any mental health struggle.
Fetch first — filter AI-side. Use per_page=500 to get the full catalogue.
Server-side filter: city (in-person only). All others (gender, price, specialty, online) filter AI-side.
⚠️ NEVER suggest therapist names not returned by this tool.`,
    input_schema: {
      type: "object" as const,
      properties: {
        city:     { type: "string", description: "City name for in-person sessions (e.g. İstanbul). Omit for online." },
        page:     { type: "number", description: "Page number (default 1)" },
        per_page: { type: "number", description: "Results per page. Use 500 for full catalogue." },
      },
    },
  },
  {
    name: "get_therapist",
    description: `Fetch full profile of a single therapist by ID or username.
Prefer username (already in find_therapists results) — no extra lookup needed.
⚠️ MANDATORY for approach queries (BDT, EMDR, ACT, Schema, Gestalt etc.):
  - Call for EVERY candidate
  - approaches[].name does NOT contain the requested method → EXCLUDE
  - approaches[] empty/null or call fails → EXCLUDE, never guess`,
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: ["string", "number"] as never, description: "Therapist numeric ID (use username instead if available)" },
        username: { type: "string" as const, description: "Therapist username slug (e.g. gulcin_yilmaz) — preferred over id" },
      },
    },
  },
  {
    name: "list_specialties",
    description: "Returns all therapy specialty categories from Planda. Use when unsure of exact specialty names.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_therapist_available_days",
    description: `Returns dates a therapist has open slots at a specific branch.
Call this when user specifies a day (cumartesi, pazartesi etc.) in a therapist search.
Check returned dates to see which fall on the requested day — only recommend therapists with that day available.`,
    input_schema: {
      type: "object" as const,
      properties: {
        therapist_id: { type: ["string", "number"] as never, description: "Therapist ID" },
        branch_id:    { type: ["string", "number"] as never, description: "Branch ID from branches[]" },
      },
      required: ["therapist_id", "branch_id"],
    },
  },
  {
    name: "get_therapist_hours",
    description: "Returns available appointment slots for a therapist on a specific date.",
    input_schema: {
      type: "object" as const,
      properties: {
        therapist_id: { type: ["string", "number"] as never, description: "Therapist ID" },
        date:         { type: "string", description: "Date in YYYY-MM-DD format" },
        branch_id:    { type: ["string", "number"] as never, description: "Branch ID (optional)" },
        service_id:   { type: ["string", "number"] as never, description: "Service ID (optional)" },
      },
      required: ["therapist_id", "date"],
    },
  },
];

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case "find_therapists": {
        const q: Record<string, unknown> = { page: input.page ?? 1, per_page: input.per_page ?? 50 };
        if (input.city) q.city = input.city;
        return JSON.stringify(await makeApiRequest("marketplace/therapists", "GET", undefined, q));
      }
      case "get_therapist": {
        // Numeric id → /therapists/{id}, string username → /therapists/username/{username}
        const idOrUsername = input.id ?? input.username;
        const path = typeof idOrUsername === "number" || /^\d+$/.test(String(idOrUsername))
          ? `marketplace/therapists/${idOrUsername}`
          : `marketplace/therapists/username/${idOrUsername}`;
        return JSON.stringify(await makeApiRequest(path));
      }
      case "list_specialties":
        return JSON.stringify(await makeApiRequest("marketplace/specialties"));
      case "get_therapist_hours": {
        const q: Record<string, unknown> = { date: input.date };
        if (input.branch_id)  q.branch_id  = input.branch_id;
        if (input.service_id) q.service_id = input.service_id;
        return JSON.stringify(await makeApiRequest(
          `marketplace/therapists/${input.therapist_id}/hours`, "GET", undefined, q
        ));
      }
      case "get_therapist_available_days":
        return JSON.stringify(await makeApiRequest(
          `marketplace/therapists/${input.therapist_id}/branches/${input.branch_id}/days`
        ));
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: String(err) });
  }
}

function toAnthropicMessages(history: ChatMessage[], current: string): Anthropic.MessageParam[] {
  return [
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user" as const, content: current },
  ];
}

async function runClaudeChat(input: ChatInput): Promise<ChatOutput> {
  const messages = toAnthropicMessages(input.history, input.message);

  let response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: CLAUDE_TOOLS,
    messages,
  });

  while (response.stop_reason === "tool_use") {
    messages.push({ role: "assistant", content: response.content });
    const toolBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolBlocks.map(async (block) => ({
        type: "tool_result" as const,
        tool_use_id: block.id,
        content: await executeTool(block.name, block.input as Record<string, unknown>),
      }))
    );
    messages.push({ role: "user", content: toolResults });
    response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: CLAUDE_TOOLS,
      messages,
    });
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  return {
    response: text,
    updatedHistory: [
      ...input.history,
      { role: "user" as const, content: input.message },
      { role: "assistant" as const, content: text },
    ],
  };
}

async function runClaudeChatStream(input: ChatInput, callbacks: ChatStreamCallbacks): Promise<ChatOutput> {
  const messages = toAnthropicMessages(input.history, input.message);
  let fullText = "";

  while (true) {
    const stream = anthropic.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: CLAUDE_TOOLS,
      messages,
    });

    // Buffer text deltas — only flush to client in the final (non-tool) round
    const roundDeltas: string[] = [];

    for await (const event of stream) {
      if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        callbacks.onStatus?.(toolStatusMessage(event.content_block.name));
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        roundDeltas.push(event.delta.text);
      }
    }

    const final = await stream.finalMessage();

    if (final.stop_reason !== "tool_use") {
      // Final answer — flush buffered deltas to client
      for (const delta of roundDeltas) {
        callbacks.onDelta?.(delta);
        fullText += delta;
      }
      break;
    }

    // Tool round — discard any intermediate text, execute tools
    messages.push({ role: "assistant", content: final.content });
    const toolBlocks = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolBlocks.map(async (block) => ({
        type: "tool_result" as const,
        tool_use_id: block.id,
        content: await executeTool(block.name, block.input as Record<string, unknown>),
      }))
    );
    messages.push({ role: "user", content: toolResults });
  }

  return {
    response: fullText,
    updatedHistory: [
      ...input.history,
      { role: "user" as const, content: input.message },
      { role: "assistant" as const, content: fullText },
    ],
  };
}

// ─── OpenAI path (fallback) ───────────────────────────────────────────────────

import { hostedMcpTool, Agent, Runner, withTrace } from "@openai/agents";
import type { AgentInputItem } from "@openai/agents";

const _openaiMcp = hostedMcpTool({
  serverLabel: "Kaan_mcp",
  allowedTools: ["find_therapists", "get_therapist", "list_specialties", "get_therapist_hours", "get_therapist_available_days"],
  requireApproval: "never",
  serverUrl: "https://plandamcp-production.up.railway.app/mcp",
});

const _openaiAgent = new Agent({
  name: "PlandaAssistant",
  instructions: SYSTEM_PROMPT,
  model: (process.env.OPENAI_MODEL ?? "gpt-4.1-mini") as string,
  tools: [_openaiMcp],
  modelSettings: { store: true },
});

const _openaiRunner = new Runner();

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
    const result = await _openaiRunner.run(_openaiAgent, items);
    const text = result.finalOutput ?? "";
    return {
      response: text,
      updatedHistory: [...input.history, { role: "user" as const, content: input.message }, { role: "assistant" as const, content: text }],
    };
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

const USE_CLAUDE = Boolean(process.env.ANTHROPIC_API_KEY);

export async function runChat(input: ChatInput): Promise<ChatOutput> {
  const guard = await checkGuardrails(input.message);
  if (guard.blocked) {
    return {
      response: SAFE_RESPONSE,
      updatedHistory: [...input.history, { role: "user" as const, content: input.message }, { role: "assistant" as const, content: SAFE_RESPONSE }],
    };
  }
  return USE_CLAUDE ? runClaudeChat(input) : runOpenAIChat(input);
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
  if (USE_CLAUDE) return runClaudeChatStream(input, callbacks);
  // OpenAI streaming fallback — non-streaming graceful degradation
  const result = await runOpenAIChat(input);
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
  return { output_text: result.response };
};
