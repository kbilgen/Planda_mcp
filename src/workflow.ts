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
  ],
  requireApproval: "never", // web UI için onay isteme
  serverUrl: "https://plandamcp-production.up.railway.app/mcp",
});

// ─── OpenAI client (guardrails için) ─────────────────────────────────────────

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Guardrails ───────────────────────────────────────────────────────────────

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
const guardrailsContext = { guardrailLlm: client };

function guardrailsHasTripwire(results: unknown[]): boolean {
  return (results ?? []).some(
    (r) => (r as { tripwireTriggered?: boolean })?.tripwireTriggered === true
  );
}

function getGuardrailSafeText(results: unknown[], fallbackText: string): string {
  for (const r of results ?? []) {
    const info = (r as { info?: Record<string, unknown> })?.info;
    if (info && "checked_text" in info) {
      return (info.checked_text as string) ?? fallbackText;
    }
  }
  const pii = (results ?? []).find(
    (r) => (r as { info?: Record<string, unknown> })?.info && "anonymized_text" in ((r as { info: Record<string, unknown> }).info)
  ) as { info: { anonymized_text?: string } } | undefined;
  return pii?.info?.anonymized_text ?? fallbackText;
}

async function scrubConversationHistory(
  history: AgentInputItem[],
  piiOnly: unknown
): Promise<void> {
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
        const res = await runGuardrails(
          (part as { text: string }).text,
          piiOnly as Parameters<typeof runGuardrails>[1],
          guardrailsContext,
          true
        );
        (part as { text: string }).text = getGuardrailSafeText(res, (part as { text: string }).text);
      }
    }
  }
}

async function scrubWorkflowInput(
  workflow: Record<string, unknown>,
  inputKey: string,
  piiOnly: unknown
): Promise<void> {
  if (!workflow || typeof workflow !== "object") return;
  const value = workflow[inputKey];
  if (typeof value !== "string") return;
  const res = await runGuardrails(
    value,
    piiOnly as Parameters<typeof runGuardrails>[1],
    guardrailsContext,
    true
  );
  workflow[inputKey] = getGuardrailSafeText(res, value);
}

async function runAndApplyGuardrails(
  inputText: string,
  config: typeof guardrailsConfig,
  history: AgentInputItem[],
  workflow: Record<string, unknown>
) {
  const guardrails = Array.isArray(config?.guardrails) ? config.guardrails : [];
  const results = await runGuardrails(
    inputText,
    config as Parameters<typeof runGuardrails>[1],
    guardrailsContext,
    true
  );
  const shouldMaskPII = guardrails.find(
    (g) => g?.name === "Contains PII" && (g as { config?: { block?: boolean } })?.config?.block === false
  );
  if (shouldMaskPII) {
    const piiOnly = { guardrails: [shouldMaskPII] };
    await scrubConversationHistory(history, piiOnly);
    await scrubWorkflowInput(workflow, "input_as_text", piiOnly);
    await scrubWorkflowInput(workflow, "input_text", piiOnly);
  }
  const hasTripwire = guardrailsHasTripwire(results);
  const safeText = getGuardrailSafeText(results, inputText) ?? inputText;
  return {
    results,
    hasTripwire,
    safeText,
    failOutput: buildGuardrailFailOutput(results ?? []),
    passOutput: { safe_text: safeText },
  };
}

function buildGuardrailFailOutput(results: unknown[]) {
  const get = (name: string) =>
    (results ?? []).find(
      (r) =>
        ((r as { info?: { guardrail_name?: string; guardrailName?: string } })?.info?.guardrail_name ??
          (r as { info?: { guardrailName?: string } })?.info?.guardrailName) === name
    ) as { info?: Record<string, unknown>; tripwireTriggered?: boolean } | undefined;

  const pii = get("Contains PII"), mod = get("Moderation"), jb = get("Jailbreak"),
    hal = get("Hallucination Detection"), nsfw = get("NSFW Text"),
    url = get("URL Filter"), custom = get("Custom Prompt Check"), pid = get("Prompt Injection Detection");

  const piiCounts = Object.entries(
    (pii?.info?.detected_entities as Record<string, unknown>) ?? {}
  )
    .filter(([, v]) => Array.isArray(v))
    .map(([k, v]) => k + ":" + (v as unknown[]).length);

  return {
    pii: { failed: piiCounts.length > 0 || pii?.tripwireTriggered === true, detected_counts: piiCounts },
    moderation: { failed: mod?.tripwireTriggered === true || ((mod?.info?.flagged_categories as unknown[] ?? []).length > 0), flagged_categories: mod?.info?.flagged_categories },
    jailbreak: { failed: jb?.tripwireTriggered === true },
    hallucination: { failed: hal?.tripwireTriggered === true, reasoning: hal?.info?.reasoning, hallucination_type: hal?.info?.hallucination_type, hallucinated_statements: hal?.info?.hallucinated_statements, verified_statements: hal?.info?.verified_statements },
    nsfw: { failed: nsfw?.tripwireTriggered === true },
    url_filter: { failed: url?.tripwireTriggered === true },
    custom_prompt_check: { failed: custom?.tripwireTriggered === true },
    prompt_injection: { failed: pid?.tripwireTriggered === true },
  };
}

// ─── Agent ────────────────────────────────────────────────────────────────────

const therapistAgent = new Agent({
  name: "1.Agent",
  instructions: `Sen bir terapist eşleştirme asistanısın.

Ana amacın terapistleri listelemek değil, kullanıcıyı EN DOĞRU terapistle eşleştirmektir.

Bir listeleme motoru gibi değil, bir uzman yönlendirme sistemi (triage) gibi davranmalısın.

---

ADIM 1 — KULLANICIYI ANLA

Aşağıdaki bilgileri çıkar:

- Terapi kimin için? (kendim / çocuğum / ilişkim)
- Yaş bilgisi (kritik)
- Problemler (kaygı, depresyon, ilişki, travma vb.)
- Tercih (online mı, yüz yüze mi)
- Lokasyon (yüz yüze ise)
- Bütçe hassasiyeti (varsa)
- Aciliyet / durumun şiddeti (varsa)

Eğer bilgi eksikse:
→ kısa ve net 1 soru sor

---

ADIM 2 — ELEME (ZORUNLU KRİTERLER)

Aşağıdaki kriterlere uymayan terapistleri ELİMİNE ET:

- Yaş aralığı uygun değilse
- Hizmet türü uygun değilse (çocuk / yetişkin / çift)
- Online / yüz yüze tercihi uymuyorsa
- Lokasyon uymuyorsa (yüz yüze için)

---

ADIM 3 — EŞLEŞME PUANLAMASI (EN ÖNEMLİ)

Kalan terapistleri şu kriterlere göre değerlendir:

1. Uzmanlık alanı eşleşmesi (EN KRİTİK)
2. Deneyim ve eğitim seviyesi
3. Terapi yaklaşımı uygunluğu
4. Ücret uyumu (kullanıcı hassassa)
5. Ek avantajlar (dil, özel alanlar vb.)

---

ADIM 4 — EN İYİ 1-3 TERAPİSTİ SEÇ

- Çok sayıda terapist listeleme
- Maksimum 3 öneri yap
- 1 tanesini "en iyi eşleşme" olarak belirt

---

ADIM 5 — NEDENİNİ AÇIKLA

Her öneri için:

- Neden uygun olduğunu açıkla
- Kullanıcının hangi ihtiyacını karşıladığını belirt
- Diğerlerine göre neden daha iyi olduğunu anlat

---

YANIT TARZI

- Doğal ve güven veren bir dil kullan
- Robotik olma
- Gereksiz uzun listeleme yapma
- Karar verdiren bir ton kullan

---

KRİTİK KURALLAR

- Yaş uyumsuzluğu olan terapisti ASLA önerme
- Uzmanlık alanı uymuyorsa önerme
- Emin değilsen → önce 1 soru sor
- Az ama doğru öner

---

AMAÇ

Kullanıcı şu hissi yaşamalı:

"Evet, bu terapist tam bana göre"`,
  model: "gpt-4.1",
  tools: [mcp],
  modelSettings: {
    temperature: 1,
    topP: 1,
    maxTokens: 2048,
    store: true,
  },
});

// ─── Workflow entry point ─────────────────────────────────────────────────────

export type WorkflowInput = { input_as_text: string };

export const runWorkflow = async (workflow: WorkflowInput): Promise<{ output_text: string } | Record<string, unknown>> => {
  return await withTrace("Planda", async () => {
    const conversationHistory: AgentInputItem[] = [
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

    const { hasTripwire, failOutput } = await runAndApplyGuardrails(
      workflow.input_as_text,
      guardrailsConfig,
      conversationHistory,
      workflow as unknown as Record<string, unknown>
    );

    if (hasTripwire) {
      return failOutput;
    }

    const agentResult = await runner.run(therapistAgent, [...conversationHistory]);
    conversationHistory.push(...agentResult.newItems.map((item) => item.rawItem as AgentInputItem));

    if (!agentResult.finalOutput) {
      throw new Error("Agent result is undefined");
    }

    return { output_text: agentResult.finalOutput ?? "" };
  });
};
