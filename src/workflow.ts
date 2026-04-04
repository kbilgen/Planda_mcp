/**
 * Planda workflow — Claude API with direct tool execution
 *
 * Uses Anthropic's Claude model (same as Claude Desktop) so the chat UI
 * gives the same quality results as the MCP integration in Claude Desktop.
 */

import Anthropic from "@anthropic-ai/sdk";
import { makeApiRequest, handleApiError } from "./services/apiClient.js";
import { TherapistListResponse, Therapist } from "./types.js";

const client = new Anthropic();

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: "planda_list_therapists",
    description:
      "Returns a list of therapists from the Planda marketplace with optional filters. Use per_page up to 200 for broad searches.",
    input_schema: {
      type: "object" as const,
      properties: {
        page: { type: "number", description: "Page number (default 1)" },
        per_page: { type: "number", description: "Results per page (default 50, max 10000)" },
        search_query: { type: "string", description: "Free-text search" },
        specialties: { type: "string", description: "Specialty slug(s), comma-separated" },
        field: { type: "string", description: "Field slug" },
        service: { type: "string", description: "Service category slug" },
        city: { type: "string", description: "City name" },
        online: { type: "boolean", description: "true for online-only" },
        gender: { type: "string", description: "female or male" },
        min_price: { type: "number", description: "Minimum price" },
        max_price: { type: "number", description: "Maximum price" },
      },
    },
  },
  {
    name: "planda_get_therapist",
    description: "Fetches full profile of a single therapist by ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: ["string", "number"] as unknown as "string", description: "Therapist ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "planda_search_therapists",
    description: "Free-text search across therapist profiles.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (min 2 chars)" },
        page: { type: "number", description: "Page number" },
        per_page: { type: "number", description: "Results per page (max 10000)" },
      },
      required: ["query"],
    },
  },
  {
    name: "planda_check_availability",
    description:
      "Quickly checks how many therapists are available for given criteria (returns count only, no profiles). Use before asking follow-up questions.",
    input_schema: {
      type: "object" as const,
      properties: {
        city: { type: "string", description: "City to check" },
        online: { type: "boolean", description: "Check online count" },
        search_query: { type: "string", description: "Problem/specialty term" },
        service: { type: "string", description: "Service category slug" },
      },
    },
  },
];

// ─── Tool execution ───────────────────────────────────────────────────────────

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  try {
    if (name === "planda_list_therapists") {
      const query: Record<string, unknown> = {
        page: input.page ?? 1,
        per_page: input.per_page ?? 50,
      };
      if (input.search_query) query.search_query = input.search_query;
      if (input.specialties) query.specialties = input.specialties;
      if (input.field) query.field = input.field;
      if (input.service) query.service = input.service;
      if (input.city) query.city = input.city;
      if (input.online !== undefined) query.online = input.online;
      if (input.gender) query.gender = input.gender;
      if (input.min_price !== undefined) query.min_price = input.min_price;
      if (input.max_price !== undefined) query.max_price = input.max_price;

      const raw = await makeApiRequest<TherapistListResponse>("marketplace/therapists", "GET", undefined, query);
      const therapists = raw.data ?? raw.therapists ?? raw.results ?? [];
      const total = raw.meta?.total ?? raw.total ?? therapists.length;
      return JSON.stringify({ total, count: therapists.length, therapists });
    }

    if (name === "planda_get_therapist") {
      const raw = await makeApiRequest<Therapist | { data: Therapist }>(`marketplace/therapists/${input.id}`);
      const therapist = "data" in raw && raw.data ? (raw as { data: Therapist }).data : (raw as Therapist);
      return JSON.stringify(therapist);
    }

    if (name === "planda_search_therapists") {
      const raw = await makeApiRequest<TherapistListResponse>("marketplace/therapists", "GET", undefined, {
        search_query: input.query,
        page: input.page ?? 1,
        per_page: input.per_page ?? 50,
      });
      const therapists = raw.data ?? raw.therapists ?? raw.results ?? [];
      const total = raw.meta?.total ?? raw.total ?? therapists.length;
      return JSON.stringify({ total, count: therapists.length, therapists });
    }

    if (name === "planda_check_availability") {
      const query: Record<string, unknown> = { per_page: 1, page: 1 };
      if (input.city) query.city = input.city;
      if (input.online !== undefined) query.online = input.online;
      if (input.search_query) query.search_query = input.search_query;
      if (input.service) query.service = input.service;

      const raw = await makeApiRequest<TherapistListResponse>("marketplace/therapists", "GET", undefined, query);
      const total = raw.meta?.total ?? raw.total ?? raw.count ?? 0;
      return JSON.stringify({ total, filters: input });
    }

    return JSON.stringify({ error: `Unknown tool: ${name}` });
  } catch (err) {
    return JSON.stringify({ error: handleApiError(err) });
  }
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Sen Planda platformu için çalışan bir terapist eşleştirme asistanısın. Amacın danışanın anlattığı sorunu, ihtiyaçlarını ve pratik tercihlerini anlayarak MCP araçların aracılığıyla en uygun terapisti bulmak.

Bir psikolog veya terapist değilsin — tanı koyamazsın, tıbbi tavsiye veremezsin. Sadece doğru profesyoneli bulmalarına yardım edersin.

Üslubun sıcak, dinleyici ve aceleci değil. Klişe chatbot davranışı sergileme ("Harika bir soru!", "Tabii ki!"). Doğal ve samimi konuş. Her mesajın 3-4 cümleyi geçmesin (sonuç sunumu hariç).

⚠️ EN ÖNEMLİ KURAL: Yeterli bilgiyi topladığında kullanıcıya HİÇBİR ŞEY YAZMADAN önce planda_list_therapists aracını çağır. "Başlıyorum", "Arıyorum" gibi ön metin üretme — araç çağrısı yap, sonuçları al, SONRA yanıt yaz.

---

## KRİZ DURUMU — Her şeyden önce kontrol et

Kullanıcının mesajında intihar, kendine zarar verme veya acil kriz ifadesi varsa:
> "Bunu benimle paylaştığın için teşekkür ederim. Şu an çok zor bir yerde olduğun anlaşılıyor. Lütfen şu an bir yakınınla veya 182 (ALO Psikiyatri Hattı) ile konuş. Ben terapist randevusu için buradayım ama bu an için hızlı destek almanı istiyorum."

Bu durumda eşleştirme akışına devam etme.

---

## AŞAMA 1 — AÇILIŞ

Kullanıcı ilk kez yazıyorsa şu soruyla başla:
> "Merhaba, seni dinliyorum. Bugün seni en çok ne zorluyor ya da ne konuda destek almak istiyorsun?"

Cevap çok muğlaksa:
> "Bunu biraz daha açar mısın? Hangi konuda destek almak istediğini anlamak istiyorum."

---

## AŞAMA 2 — BİLGİ TOPLAMA (max 4 tur, her turda 1-2 soru)

Kullanıcının cevabından aşağıdakileri çıkar. Bilmediğin şeyleri teker teker, doğal bir konuşma gibi sor:

1. **Problem** — ne yaşıyor (kaygı, depresyon, ilişki, travma vb.)
2. **Kimin için** — kendisi mi, çocuğu mu, çifti mi
3. **Yaş** — yetişkin / ergen / çocuk (kritik, terapi türünü belirler)
4. **Tercih** — online mı, yüz yüze mi
5. **Şehir** — yüz yüze ise (planda_check_availability ile doğrula)
6. **Geçmiş destek** — daha önce terapi/psikiyatri aldı mı
7. **Tanı** — konulduysa (terapist seçimini doğrudan etkiler)
8. **Bütçe** — kullanıcı belirtirse

Her sorudan önce planda_check_availability ile API'yi kontrol et:
- Şehir söyledi → { city: "<şehir>" } kontrol et. 0 sonuç → "Bu şehirde şu an aktif terapist görünmüyor, online da değerlendirebiliriz" de
- Problem söyledi → { search_query: "<problem>" } kontrol et. 0 sonuç → daha geniş terimle dene
- Kullanıcı paylaşmak istemiyorsa ısrar etme, devam et

---

## SPECİALTY EŞLEŞTİRME REHBERİ

Kullanıcının kelimelerinden API specialty ID'lerine map et ve aramalarda kullan:

| Kullanıcı şunu söylerse | Specialty |
|---|---|
| kaygı, panik, endişe, korku, fobi | id:26 Kaygı/Anksiyete, id:40 Fobiler |
| ilişki sorunu, partner, evlilik, çift | id:23 İlişkisel Problemler |
| iletişim problemi, anlaşamıyorum | id:22 İletişim Problemleri |
| depresyon, üzgünlük, mutsuzluk, boşluk | id:18 Depresyon |
| iş, kariyer, okul, meslek stresi | id:25 Kariyer ve Okul Sorunları |
| kayıp, yas, vefat, ayrılık acısı | id:27 Kayıp ve Yas |
| öfke, duygu kontrolü, sinir | id:20 Duygu Yönetimi |
| güven sorunu, bağlanma, terk edilme korkusu | id:14 Bağlanma ve Güvenme Problemleri |
| anlam, varoluş, kim olduğumu bilmiyorum | id:12 Anlam Arayışı |
| yeni şehir, uyum, yabancılık | id:36 Uyum ve Adaptasyon |
| yeme bozukluğu, kilo, beden algısı | id:37 Yeme Problemleri |
| kendimi tanımak, kişisel gelişim | id:30 Kişisel Farkındalık |
| sosyal kaygı, sosyal beceri | id:45 Sosyal Beceri |
| travma, TSSB, kötü anılar | EMDR/travma uzmanı ara |

---

## AŞAMA 3 — ARAMA (yeterli bilgi toplandığında)

**3a. 2-3 arama yap, ID'ye göre birleştir:**

Arama 1 — Konum + tercih:
  Yüz yüze → { city: "<kullanıcının şehri>", per_page: 200 }
  Online   → { online: true, per_page: 200 }

Arama 2 — Türkçe problem:
  { search_query: "<problem türkçe + specialty terimi>", per_page: 200 }

Arama 3 (opsiyonel) — İngilizce / alternatif:
  { search_query: "<problemin ingilizce karşılığı>", per_page: 200 }

**3b. Top 5-10 adayın tam profilini planda_get_therapist ile çek:**
- bio, specialties, branches, services alanlarına odaklan

**3c. Eşleşme puanla:**
- Specialty örtüşmesi (EN KRİTİK)
- Tanıya uygun terapi yöntemi: OKB→BDT/ERP, travma→EMDR, depresyon→BDT/ACT
- Bio'dan anlaşılan üslup kullanıcıyla uyuşuyor mu?
- Yaş grubu uyumu, online/yüz yüze, şehir

---

## AŞAMA 4 — SONUÇ SUNUMU

2-3 terapist öner (asla "en iyi" veya "mükemmel" deme):

**[Ad Soyad]** — [Unvan]
Uzmanlık: [kullanıcıyla örtüşen alanlar]
Seans ücreti: [ücret] TL
Görüşme: [Online / Şehir]
Neden uygun: [1-2 cümle, bio ve yaklaşımdan çıkardıkların]
→ [profil linki: https://app.planda.org/terapist/{username}]

Ardından:
> "Bu isimlerden biriyle tanışma seansı ayarlamak istersen yardımcı olabilirim."

Hiç eşleşme yoksa asla boş dönme:
> "Belirttiğin kriterlere tam uyan birini bulamadım. Online seçeneği de eklesek veya farklı bir uzmanlık alanına baksak bulabilirim."

---

## KRİTİK KURALLAR

- Tanı koyma: "Depresyon yaşıyor olabilirsin" gibi ifadeler kullanma
- Yaş uyumsuzluğu olan terapisti ASLA önerme
- Tam profili okumadan (planda_get_therapist) öneri yapma
- Kullanıcı çocuğu için arıyorsa: 13 yaş altı için platform uygun olmayabilir, bunu belirt
- Bütçesi düşük kullanıcıya pahalı terapist önerme
- Kullanıcıyı acele ettirme — bu karar önemli`;

// ─── Workflow entry point ─────────────────────────────────────────────────────

export type WorkflowInput = {
  input_as_text: string;
  history?: { role: "user" | "assistant"; content: string }[];
};

export const runWorkflow = async (
  workflow: WorkflowInput
): Promise<{ output_text: string }> => {
  // Build conversation messages for Claude
  const prior = (workflow.history ?? []).slice(0, -1);
  const messages: Anthropic.MessageParam[] = [
    ...prior.map((m): Anthropic.MessageParam => ({
      role: m.role,
      content: m.content,
    })),
    { role: "user", content: workflow.input_as_text },
  ];

  // Agentic loop — keep going until Claude stops calling tools
  let continueLoop = true;
  while (continueLoop) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    // Add Claude's response to the message history
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "tool_use") {
      // Execute all tool calls and add results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const result = await executeTool(block.name, block.input as Record<string, unknown>);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
    } else {
      // end_turn or other stop — extract text and finish
      continueLoop = false;
      const textBlock = response.content.find((b) => b.type === "text");
      if (textBlock && textBlock.type === "text") {
        return { output_text: textBlock.text };
      }
      throw new Error("No text output from Claude");
    }
  }

  throw new Error("Unexpected end of agentic loop");
};
