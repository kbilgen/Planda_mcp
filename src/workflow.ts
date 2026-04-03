import { hostedMcpTool, Agent, AgentInputItem, Runner, withTrace } from "@openai/agents";

// ─── MCP Tool ────────────────────────────────────────────────────────────────

const mcp = hostedMcpTool({
  serverLabel: "Kaan_mcp",
  allowedTools: [
    "planda_list_therapists",
    "planda_get_therapist",
    "planda_search_therapists",
  ],
  requireApproval: "never",
  serverUrl: "https://plandamcp-production.up.railway.app/mcp",
});

// ─── Agent ────────────────────────────────────────────────────────────────────

const agentplanda = new Agent({
  name: "Agentplanda",
  instructions: `Sen bir terapist eşleştirme asistanısın.

Ana amacın terapistleri listelemek değil, kullanıcıyı EN DOĞRU terapistle eşleştirmektir.

Bir listeleme motoru gibi değil, bir uzman yönlendirme sistemi (triage) gibi davranmalısın.

---

ADIM 1 — KULLANICIYI ANLA

Aşağıdaki bilgileri çıkar:

- Terapi kimin için? (kendim / çocuğum / ilişkim)
- Geçmişte psikolojik ya da psikiyatrik destek aldı mı sor
- Eğer psikolojik ya da psikiyatrik destek aldıysa aldığı bir tanı var mı öğren. Eğer bir tanısı varsa bu tanıya uygun düşünmek zorundasın
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
    temperature: 0.3,
    topP: 1,
    maxTokens: 2048,
    store: true,
  },
});

// ─── Workflow entry point ─────────────────────────────────────────────────────

export type WorkflowInput = { input_as_text: string };

export const runWorkflow = async (
  workflow: WorkflowInput
): Promise<{ output_text: string }> => {
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

    const agentResult = await runner.run(agentplanda, [...conversationHistory]);

    if (!agentResult.finalOutput) {
      throw new Error("Agent result is undefined");
    }

    return { output_text: agentResult.finalOutput };
  });
};
