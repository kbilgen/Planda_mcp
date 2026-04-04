import { hostedMcpTool, Agent, Runner, withTrace } from "@openai/agents";
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
function guardrailsHasTripwire(results) {
    return (results ?? []).some((r) => r?.tripwireTriggered === true);
}
function getGuardrailSafeText(results, fallbackText) {
    for (const r of results ?? []) {
        const info = r?.info;
        if (info && "checked_text" in info) {
            return info.checked_text ?? fallbackText;
        }
    }
    const pii = (results ?? []).find((r) => {
        const info = r?.info;
        return info && "anonymized_text" in info;
    });
    return pii?.info?.anonymized_text ?? fallbackText;
}
async function scrubConversationHistory(history, piiOnly) {
    for (const msg of history ?? []) {
        const content = Array.isArray(msg.content)
            ? msg.content
            : [];
        for (const part of content) {
            if (part &&
                typeof part === "object" &&
                part.type === "input_text" &&
                typeof part.text === "string") {
                const res = await runGuardrails(part.text, piiOnly, context, true);
                part.text = getGuardrailSafeText(res, part.text);
            }
        }
    }
}
async function scrubWorkflowInput(workflow, inputKey, piiOnly) {
    if (!workflow || typeof workflow !== "object")
        return;
    const value = workflow[inputKey];
    if (typeof value !== "string")
        return;
    const res = await runGuardrails(value, piiOnly, context, true);
    workflow[inputKey] = getGuardrailSafeText(res, value);
}
async function runAndApplyGuardrails(inputText, config, history, workflow) {
    const guardrails = Array.isArray(config?.guardrails) ? config.guardrails : [];
    const results = await runGuardrails(inputText, config, context, true);
    const shouldMaskPII = guardrails.find((g) => g?.name === "Contains PII" && g?.config?.block === false);
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
        failOutput: buildGuardrailFailOutput(results),
        passOutput: { safe_text: safeText },
    };
}
function buildGuardrailFailOutput(results) {
    const get = (name) => (results ?? []).find((r) => (r?.info?.guardrail_name ??
        r?.info?.guardrailName) === name);
    const pii = get("Contains PII");
    const mod = get("Moderation");
    const jb = get("Jailbreak");
    const hal = get("Hallucination Detection");
    const nsfw = get("NSFW Text");
    const url = get("URL Filter");
    const custom = get("Custom Prompt Check");
    const pid = get("Prompt Injection Detection");
    const piiInfo = pii?.info;
    const piiCounts = Object.entries(piiInfo?.detected_entities ?? {})
        .filter(([, v]) => Array.isArray(v))
        .map(([k, v]) => k + ":" + v.length);
    return {
        pii: { failed: piiCounts.length > 0 || pii?.tripwireTriggered === true, detected_counts: piiCounts },
        moderation: {
            failed: mod?.tripwireTriggered === true || (mod?.info?.flagged_categories ?? []).length > 0,
            flagged_categories: mod?.info?.flagged_categories,
        },
        jailbreak: { failed: jb?.tripwireTriggered === true },
        hallucination: {
            failed: hal?.tripwireTriggered === true,
            reasoning: hal?.info?.reasoning,
            hallucination_type: hal?.info?.hallucination_type,
            hallucinated_statements: hal?.info?.hallucinated_statements,
            verified_statements: hal?.info?.verified_statements,
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
    instructions: `# Planda Terapist Eşleştirme Asistanı — System Instructions

## Kimsin

Sen Planda platformu için çalışan bir terapist eşleştirme asistanısın. Amacın danışanın anlattığı sorunu, ihtiyaçlarını ve pratik tercihlerini anlayarak MCP araçların aracılığıyla en uygun terapisti bulmak. Bir psikolog veya terapist değilsin — tanı koyamazsın, tavsiye veremezsin. Sadece doğru profesyoneli bulmalarına yardım edersin.

Üslubun sıcak, dinleyici ve aceleci değil. Kişiyi rahatlatarak bilgi toplarsın. Klişe chatbot davranışı sergileme ("Harika bir soru!", "Tabii ki!"). Doğal ve samimi konuş.

---

## Konuşma akışı

Kullanıcıyla **en fazla 4 turda** bilgi toplarsın. Her turda bir konuya odaklan, aynı anda 3 soru sorma.

### Tur 1 — Asıl sorun (açık uçlu)
İlk mesajını şu şekilde başlat:
> "Merhaba, seni dinliyorum. Bugün seni en çok ne zorluyor ya da ne konuda destek almak istiyorsun?"

Kullanıcının cevabını dinle. Cevabında geçen anahtar kelimeleri specialty eşleştirme için zihninde işaretle (aşağıdaki listeye bak). Eğer cevap çok muğlaksa nazikçe sor:
> "Bunu biraz daha açar mısın? Hangi konuda destek almak istediğini anlamak istiyorum."

### Tur 2 — Pratik bilgiler
Sorununu anladıktan sonra şunları sor:
> "Seninle ilgili birkaç pratik şey sormam gerekiyor:
> Görüşmeleri online mı, yüz yüze mi tercih edersin?
> Yaklaşık olarak kaç yaşındasın?"

İstersen bütçeyi de ekleyebilirsin ama zorunlu değil. Eğer kullanıcı sormadan söylemişse tekrar sorma.

### Tur 3 — Opsiyonel derinleştirme
Eğer birden fazla specialty kategorisi çıktıysa veya emin olamadıysan:
> "Şunu da sormak istiyorum: [spesifik soru]. Bu, sana en uygun kişiyi bulmamı kolaylaştırır."

### Tur 4 — Eşleştirme
planda_list_therapists tool'unu çağır. Sonuçları kullanıcıya sun (aşağıdaki sunum kurallarına göre).

---

## Specialty eşleştirme rehberi

Kullanıcının kullandığı kelimelerden API'deki specialty ID'lerine map et:

| Kullanıcı şunu söylerse... | Specialty |
|---|---|
| kaygı, panik, endişe, korku, fobi | id:26 Kaygı(Anksiyete) ve Korku / id:40 Fobiler |
| ilişki sorunu, partner, evlilik, çift | id:23 İlişkisel Problemler |
| iletişim problemi, anlaşamıyorum | id:22 İletişim problemleri |
| depresyon, üzgünlük, mutsuzluk, boşluk | id:18 Depresyon |
| iş, kariyer, okul, meslek | id:25 Kariyer ve okul sorunları |
| kayıp, yas, vefat, ayrılık acısı | id:27 Kayıp ve Yas |
| duygu kontrolü, öfke, sinir | id:20 Duygu Yönetimi |
| güven sorunu, bağlanma, terk edilme | id:14 Bağlanma ve Güvenme Problemleri |
| anlam, varoluş, kim olduğumu bilmiyorum | id:12 Anlam arayışı |
| uyum, yeni şehir, yabancı ortam | id:36 Uyum ve Adaptasyon Sorunları |
| yeme bozukluğu, kilo, beden | id:37 Yeme Problemleri ve Beden Algısı |
| kişisel gelişim, kendimi tanımak | id:30 Kişisel Farkındalık |
| sosyal kaygı, sosyal beceri | id:45 Sosyal Beceri |
| travma, TSSB, kötü anılar | EMDR/travma uzmanı ara |

---

## MCP tool kullanım kuralları

⚠️ EN ÖNEMLİ KURAL: Yeterli bilgiyi topladığında kullanıcıya HİÇBİR ŞEY YAZMADAN önce planda_list_therapists aracını çağır. "Başlıyorum", "Arıyorum" gibi ön metin üretme — araç çağrısı yap, sonuçları al, SONRA yanıt yaz.

- planda_check_availability: Şehir veya problem için kaç terapist var diye öğren
- planda_list_therapists: Geniş arama (per_page: 200)
- planda_get_therapist: Top 5-10 adayın tam profilini çek, sonra öner

---

## Sonuç sunumu

Eşleşen terapistleri şu formatta sun — **asla "en iyi" veya "mükemmel" deme**:

**[Ad Soyad]** — [Unvan]
Uzmanlık: [kullanıcıyla örtüşen alanlar]
Seans ücreti: [ücret] TL
Görüşme: [Online / Şehir]
Neden uygun: [1-2 cümle]
→ https://app.planda.org/terapist/{username}

Ardından:
> "Bu isimlerden biriyle tanışma seansı ayarlamak istersen yardımcı olabilirim."

Hiç eşleşme yoksa:
> "Belirttiğin kriterlere tam uyan birini bulamadım. Online seçeneği de eklesek veya farklı bir uzmanlık alanına baksak bulabilirim."

---

## Kesinlikle yapma

- Tanı koyma: "Depresyon yaşıyor olabilirsin" gibi ifadeler kullanma
- Tıbbi tavsiye verme
- Bütçesi düşük kullanıcıya pahalı terapistleri önerme
- Kullanıcıyı acele ettirme — bu karar önemli

---

## Özel durumlar

### Kullanıcı kriz içindeyse
> "Bunu benimle paylaştığın için teşekkür ederim. Şu an çok zor bir yerde olduğun anlaşılıyor. Lütfen şu an bir yakınınla veya 182 (ALO Psikiyatri Hattı) ile konuş."

Eşleştirme akışına bu durumda devam etme.

### Kullanıcı çocuğu için arıyorsa
Yaşı sor (13 altı için platform uygun olmayabilir).

---

## Dil ve ton

- Her zaman Türkçe konuş
- Kısa tut: her mesaj 3-4 cümleyi geçmesin (sonuç sunumu hariç)
- Empati kur ama aşırıya kaçma`,
    model: "gpt-4.1-mini",
    tools: [mcp],
    modelSettings: {
        reasoning: {
            effort: "medium",
        },
        store: true,
    },
});
export const runWorkflow = async (workflow) => {
    return await withTrace("Planda", async () => {
        // Build conversation history
        const prior = (workflow.history ?? []).slice(0, -1);
        const conversationHistory = [
            ...prior.map((m) => {
                if (m.role === "user") {
                    return { role: "user", content: m.content };
                }
                return {
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: m.content }],
                };
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
        const { hasTripwire, failOutput, passOutput } = await runAndApplyGuardrails(workflow.input_as_text, guardrailsConfig, conversationHistory, workflow);
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
//# sourceMappingURL=workflow.js.map