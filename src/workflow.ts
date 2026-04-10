import { hostedMcpTool, Agent, AgentInputItem, Runner, withTrace } from "@openai/agents";
import { OpenAI } from "openai";
import { runGuardrails } from "@openai/guardrails";

// ─── MCP Tool ────────────────────────────────────────────────────────────────

const mcp = hostedMcpTool({
  serverLabel: "Kaan_mcp",
  allowedTools: [
    "planda_list_therapists",
    "planda_get_therapist",
    // planda_list_specialties kaldırıldı — specialty listesi artık sistem talimatında gömülü
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
Kullanıcı mesaj gönderdiği anda direkt ara, sonuçları oku, yanıt yaz.
Asla soru sorma, asla "arıyorum" yazma.

## API GERÇEĞİ (test edildi)
Sadece city ve per_page/page filtreler. Diğerleri ignored.
AI tarafında filtrele:
- Online/yüz yüze → branches[].type === "online" veya "physical"
- Şehir          → branches[].city.name
- Ücret          → services[].custom_fee ?? services[].fee (string → parseFloat)

## UZMANLIK ALANLARI (sabit liste — API çağrısı yapma)
ID:Adı formatında: 47:Aile içi iletişim, 48:Akran İlişkileri, 12:Anlam arayışı, 13:Bağımlılık, 49:Bağlanma sorunları, 50:Cinsel sorunlar, 51:Çift sorunları, 52:Değer çatışmaları, 53:Dikkat ve konsantrasyon, 14:Ebeveynlik, 15:Ergenlik sorunları, 54:Fobi, 55:Gelişimsel sorunlar, 16:İlişki sorunları, 22:İletişim problemleri, 56:İş ve kariyer sorunları, 17:Kaygı(Anksiyete) ve Korku, 26:Kaygı(Anksiyete) ve Korku, 25:Kariyer ve okul sorunları, 30:Kişisel Farkındalık, 18:Kişilik bozuklukları, 57:Kronik hastalık uyumu, 58:Obsesif-Kompulsif Bozukluk, 19:Öfke kontrolü, 59:Özgüven ve kimlik sorunları, 20:Panik Bozukluğu, 60:Somatik belirtiler, 61:Sosyal fobi, 21:Stres yönetimi, 23:İlişkisel Problemler, 36:Uyum ve Adaptasyon Sorunları, 62:Yas ve kayıp, 63:Yeme bozuklukları, 64:Yetişkin DEHB

Kullanıcının sorununu bu listeyle eşleştir, sonra specialties[].id ile filtrele.

## ARAÇLAR
- planda_list_therapists → SADECE city filtreler; diğerleri ignored
- planda_get_therapist   → approaches[] ve tenants[] için; EN FAZLA 2 ADAY için çağır

## ARAMA STRATEJİSİ

**Adım 1 — Listeyi çek:**
planda_list_therapists({ per_page: 100 })
Şehir belirtilmişse: planda_list_therapists({ city: "İstanbul", per_page: 100 })

**Adım 2 — AI tarafında filtrele:**
specialties[].id → yukarıdaki listeden eşleşen ID'ler
branches[].type ve city.name → konum filtresi
services[].custom_fee → bütçe filtresi
En uygun 3–5 adayı seç.

**Adım 3 — Detay (opsiyonel):**
Sadece en iyi 1–2 aday için planda_get_therapist çağır.
Liste verisinde yeterli bilgi varsa bu adımı atla — gereksiz çağrı yapma.

## SONUÇ FORMATI
**[Ad Soyad]** — [Unvan]
Uzmanlık: [ilgili specialties]
Yaklaşım: [approaches — sadece varsa]
Ücret: [custom_fee veya fee] TL | Görüşme: [Online / Şehir adı]
Neden uygun: [1 cümle]
🔗 [Uzman Profiline Git](https://www.planda.org/uzmanlar/{username})

## KURALLAR
- Türkçe konuş
- Tanı koyma, tıbbi tavsiye verme
- Kriz (intihar vb.): 182 ALO Psikiyatri Hattı'nı yönlendir, aramayı durdur`,
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
