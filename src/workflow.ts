/**
 * Planda Assistant — Agent & Workflow
 *
 * OpenAI Agents SDK kullanarak terapist eşleştirme akışını çalıştırır.
 * Guardrails (moderation) input üzerinde uygulanır.
 */

import { hostedMcpTool, Agent, AgentInputItem, Runner, withTrace } from "@openai/agents";
import { OpenAI } from "openai";
import { runGuardrails } from "@openai/guardrails";
import { SYSTEM_PROMPT } from "./prompts.js";
import type { ChatMessage } from "./sessionStore.js";

// ─── MCP Tool ────────────────────────────────────────────────────────────────

const mcp = hostedMcpTool({
  serverLabel: "Kaan_mcp",
  allowedTools: [
    "planda_list_therapists",
    "planda_get_therapist",
  ],
  requireApproval: "never",
  serverUrl: "https://plandamcp-production.up.railway.app/mcp",
});

// ─── Guardrails ───────────────────────────────────────────────────────────────

const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

const guardrailsContext = { guardrailLlm: openaiClient };

async function checkGuardrails(text: string): Promise<{ blocked: boolean; reason?: string }> {
  try {
    const results = (await runGuardrails(
      text,
      GUARDRAILS_CONFIG as never,
      guardrailsContext,
      true
    )) as Array<{ tripwireTriggered?: boolean; info?: { flagged_categories?: string[] } }>;

    const blocked = results.some((r) => r.tripwireTriggered === true);
    if (!blocked) return { blocked: false };

    const flagged = results
      .flatMap((r) => r.info?.flagged_categories ?? [])
      .join(", ");
    return { blocked: true, reason: flagged || "content policy violation" };
  } catch {
    // Guardrail hatası akışı durdurmasın
    return { blocked: false };
  }
}

// ─── Agent ────────────────────────────────────────────────────────────────────

function createAgent(): Agent {
  return new Agent({
    name: "PlandaAssistant",
    instructions: SYSTEM_PROMPT,
    model: "gpt-4.1-mini",
    tools: [mcp],
    modelSettings: {
      store: true,
    },
  });
}

// Singleton agent — her request yeniden oluşturmaya gerek yok
const agent = createAgent();

const runner = new Runner({
  traceMetadata: {
    __trace_source__: "agent-builder",
    workflow_id: "wf_69ceac5a340c81908ac3f8d49e1afa0103e85e9ffaa5af21",
  },
});

// ─── History helpers ──────────────────────────────────────────────────────────

function toAgentItems(history: ChatMessage[], currentMessage: string): AgentInputItem[] {
  const items: AgentInputItem[] = history.map((m): AgentInputItem => {
    if (m.role === "user") {
      return { role: "user", content: m.content };
    }
    return {
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: m.content }],
    } as AgentInputItem;
  });

  items.push({
    role: "user",
    content: [{ type: "input_text", text: currentMessage }],
  });

  return items;
}

// ─── runChat — /v1/assistant/chat için ───────────────────────────────────────

export interface ChatInput {
  message: string;
  history: ChatMessage[];
}

export interface ChatOutput {
  response: string;
  updatedHistory: ChatMessage[];
}

export async function runChat(input: ChatInput): Promise<ChatOutput> {
  return withTrace("PlandaChat", async () => {
    // 1. Guardrail kontrolü
    const guard = await checkGuardrails(input.message);
    if (guard.blocked) {
      const safeResponse =
        "Bu konuda sana yardımcı olamıyorum. Uygun bir terapist bulmak için buradayım — devam edelim mi?";
      return {
        response: safeResponse,
        updatedHistory: [
          ...input.history,
          { role: "user" as const, content: input.message },
          { role: "assistant" as const, content: safeResponse },
        ],
      };
    }

    // 2. Agent çalıştır
    const agentItems = toAgentItems(input.history, input.message);
    const result = await runner.run(agent, agentItems);

    const responseText = result.finalOutput ?? "";

    // 3. History güncelle
    const updatedHistory: ChatMessage[] = [
      ...input.history,
      { role: "user" as const, content: input.message },
      { role: "assistant" as const, content: responseText },
    ];

    return { response: responseText, updatedHistory };
  });
}

// ─── runWorkflow — /api/chat için (geriye dönük uyumluluk) ───────────────────

export type WorkflowInput = {
  input_as_text: string;
  history?: { role: "user" | "assistant"; content: string }[];
};

export const runWorkflow = async (workflow: WorkflowInput) => {
  const history: ChatMessage[] = (workflow.history ?? []).slice(0, -1);
  const result = await runChat({ message: workflow.input_as_text, history });
  return { output_text: result.response };
};
