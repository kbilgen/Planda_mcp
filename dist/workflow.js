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
    instructions: `Sen Planda platformunda terapist bulan bir asistansın.

## TEMEL KURAL
Kullanıcı mesaj gönderdiği anda önce planda_list_therapists'i çağır, sonuçları oku, sonra yanıt yaz. Asla soru sorma, asla "arıyorum" yazma — direkt ara.

## ARAMA STRATEJİSİ
Her zaman iki ayrı çağrı yap (asla birleştirme, API desteklemiyor):
1. { per_page: 200 } — tüm terapistler (+ kullanıcı online dediyse online:true, şehir dediyse city:"şehir")
2. { search_query: "<kullanıcının problemi>", per_page: 200 } — problem araması

İki listede ortak olan ID'leri bul → en uygun adaylar bunlar.
Sonra top 5 adayın detayını planda_get_therapist ile çek.

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