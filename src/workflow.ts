import { hostedMcpTool, Agent, AgentInputItem, Runner, withTrace } from "@openai/agents";
import { OpenAI } from "openai";
import { runGuardrails } from "@openai/guardrails";

// ─── MCP Tool ────────────────────────────────────────────────────────────────

const mcp = hostedMcpTool({
  serverLabel: "Kaan_mcp",
  allowedTools: [
    "planda_list_therapists",
    "planda_get_therapist",
    "planda_search_therapists",
    "planda_check_availability",
  ],
  requireApproval: "never",
  serverUrl: "https://plandamcp-production.up.railway.app/mcp",
});

// ─── Guardrails ───────────────────────────────────────────────────────────────

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const guardrailsConfig = {
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
const context = { guardrailLlm: client };

function guardrailsHasTripwire(results: unknown[]): boolean {
  return (results ?? []).some((r: unknown) => (r as { tripwireTriggered?: boolean })?.tripwireTriggered === true);
}

function getGuardrailSafeText(results: unknown[], fallbackText: string): string {
  for (const r of results ?? []) {
    const info = (r as { info?: Record<string, unknown> })?.info;
    if (info && "checked_text" in info) {
      return (info.checked_text as string) ?? fallbackText;
    }
  }
  const pii = (results ?? []).find((r: unknown) => {
    const info = (r as { info?: Record<string, unknown> })?.info;
    return info && "anonymized_text" in info;
  }) as { info?: Record<string, unknown> } | undefined;
  return (pii?.info?.anonymized_text as string) ?? fallbackText;
}

async function scrubConversationHistory(history: AgentInputItem[], piiOnly: unknown): Promise<void> {
  for (const msg of history ?? []) {
    const content = Array.isArray((msg as { content?: unknown }).content)
      ? (msg as { content: unknown[] }).content
      : [];
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: string }).type === "input_text" &&
        typeof (part as { text?: string }).text === "string"
      ) {
        const res = await runGuardrails((part as { text: string }).text, piiOnly as never, context, true);
        (part as { text: string }).text = getGuardrailSafeText(res as unknown[], (part as { text: string }).text);
      }
    }
  }
}

async function scrubWorkflowInput(workflow: Record<string, unknown>, inputKey: string, piiOnly: unknown): Promise<void> {
  if (!workflow || typeof workflow !== "object") return;
  const value = workflow[inputKey];
  if (typeof value !== "string") return;
  const res = await runGuardrails(value, piiOnly as never, context, true);
  workflow[inputKey] = getGuardrailSafeText(res as unknown[], value);
}

async function runAndApplyGuardrails(
  inputText: string,
  config: typeof guardrailsConfig,
  history: AgentInputItem[],
  workflow: Record<string, unknown>
) {
  const guardrails = Array.isArray(config?.guardrails) ? config.guardrails : [];
  const results = await runGuardrails(inputText, config as never, context, true);
  const shouldMaskPII = guardrails.find(
    (g) => g?.name === "Contains PII" && (g as { config?: { block?: boolean } })?.config?.block === false
  );
  if (shouldMaskPII) {
    const piiOnly = { guardrails: [shouldMaskPII] };
    await scrubConversationHistory(history, piiOnly);
    await scrubWorkflowInput(workflow, "input_as_text", piiOnly);
    await scrubWorkflowInput(workflow, "input_text", piiOnly);
  }
  const hasTripwire = guardrailsHasTripwire(results as unknown[]);
  const safeText = getGuardrailSafeText(results as unknown[], inputText) ?? inputText;
  return {
    results,
    hasTripwire,
    safeText,
    failOutput: buildGuardrailFailOutput(results as unknown[]),
    passOutput: { safe_text: safeText },
  };
}

function buildGuardrailFailOutput(results: unknown[]) {
  const get = (name: string) =>
    (results ?? []).find(
      (r: unknown) =>
        ((r as { info?: { guardrail_name?: string; guardrailName?: string } })?.info?.guardrail_name ??
          (r as { info?: { guardrailName?: string } })?.info?.guardrailName) === name
    ) as Record<string, unknown> | undefined;

  const pii = get("Contains PII");
  const mod = get("Moderation");
  const jb = get("Jailbreak");
  const hal = get("Hallucination Detection");
  const nsfw = get("NSFW Text");
  const url = get("URL Filter");
  const custom = get("Custom Prompt Check");
  const pid = get("Prompt Injection Detection");

  const piiInfo = pii?.info as Record<string, unknown> | undefined;
  const piiCounts = Object.entries((piiInfo?.detected_entities as Record<string, unknown[]>) ?? {})
    .filter(([, v]) => Array.isArray(v))
    .map(([k, v]) => k + ":" + v.length);

  return {
    pii: { failed: piiCounts.length > 0 || pii?.tripwireTriggered === true, detected_counts: piiCounts },
    moderation: {
      failed: mod?.tripwireTriggered === true || ((mod?.info as { flagged_categories?: unknown[] })?.flagged_categories ?? []).length > 0,
      flagged_categories: (mod?.info as { flagged_categories?: unknown[] })?.flagged_categories,
    },
    jailbreak: { failed: jb?.tripwireTriggered === true },
    hallucination: {
      failed: hal?.tripwireTriggered === true,
      reasoning: (hal?.info as Record<string, unknown>)?.reasoning,
      hallucination_type: (hal?.info as Record<string, unknown>)?.hallucination_type,
      hallucinated_statements: (hal?.info as Record<string, unknown>)?.hallucinated_statements,
      verified_statements: (hal?.info as Record<string, unknown>)?.verified_statements,
    },
    nsfw: { failed: nsfw?.tripwireTriggered === true },
    url_filter: { failed: url?.tripwireTriggered === true },
    custom_prompt_check: { failed: custom?.tripwireTriggered === true },
    prompt_injection: { failed: pid?.tripwireTriggered === true },
  };
}

// ─── Agent ────────────────────────────────────────────────────────────────────

const agentplanda = new Agent({
  name: "Agentplanda",
  instructions: `Sen Planda platformunda terapist bulan bir asistansın.

## TEMEL KURAL
Kullanıcı mesaj gönderdiği anda önce planda_list_therapists'i çağır, sonuçları oku, sonra yanıt yaz. Asla soru sorma, asla "arıyorum" yazma — direkt ara.

## ARAMA STRATEJİSİ

⛔ YASAK: online/city filtresi ile search_query'yi AYNI çağrıda kullanma. API sıfır sonuç döndürür.

Her zaman iki AYRI çağrı yap:
1. { online: true, per_page: 200 } VEYA { city: "şehir", per_page: 200 } — sadece konum
2. { search_query: "kaygı", per_page: 200 } — sadece problem, konum filtresi YOK

İki listede ortak ID'ler → en iyi adaylar. Sonra top 5'in detayını planda_get_therapist ile çek.
Eğer ortak ID yoksa: Çağrı 1'deki terapistlerin specialty alanını manuel oku, probleme uyanları seç.

## SONUÇ FORMATI
**[Ad Soyad]** — [Unvan]
Uzmanlık: [ilgili alanlar]
Ücret: [ücret] TL | Görüşme: [Online/Şehir]
Neden uygun: [1 cümle]
→ https://app.planda.org/terapist/{username}

## KURALLAR
- Türkçe konuş
- Tanı koyma, tıbbi tavsiye verme
- Kriz varsa (intihar vb.): 182 ALO Psikiyatri Hattı'nı yönlendir, aramayı durdur
- Hiç sonuç çıkmazsa geniş arama yap, pes etme`,
  model: "gpt-4.1-mini",
  tools: [mcp],
  modelSettings: {
    store: true,
  },
});

// ─── Workflow entry point ─────────────────────────────────────────────────────

export type WorkflowInput = {
  input_as_text: string;
  history?: { role: "user" | "assistant"; content: string }[];
};

export const runWorkflow = async (workflow: WorkflowInput) => {
  return await withTrace("Planda", async () => {
    // Build conversation history
    const prior = (workflow.history ?? []).slice(0, -1);
    const conversationHistory: AgentInputItem[] = [
      ...prior.map((m): AgentInputItem => {
        if (m.role === "user") {
          return { role: "user", content: m.content };
        }
        return {
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: m.content }],
        } as AgentInputItem;
      }),
      {
        role: "user",
        content: [{ type: "input_text", text: workflow.input_as_text }],
      },
    ];

    const runner = new Runner({
      traceMetadata: {
        __trace_source__: "agent-builder",
        workflow_id: "wf_69ceac5a340c81908ac3f8d49e1afa0103e85e9ffaa5af21",
      },
    });

    // Run guardrails on input
    const { hasTripwire, failOutput, passOutput } = await runAndApplyGuardrails(
      workflow.input_as_text,
      guardrailsConfig,
      conversationHistory,
      workflow as unknown as Record<string, unknown>
    );

    if (hasTripwire) {
      return failOutput;
    }

    const agentResult = await runner.run(agentplanda, [...conversationHistory]);

    if (!agentResult.finalOutput) {
      throw new Error("Agent result is undefined");
    }

    return { output_text: agentResult.finalOutput };
  });
};
