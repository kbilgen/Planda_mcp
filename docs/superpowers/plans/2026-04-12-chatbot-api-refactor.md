# Chatbot API Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat markdown `/api/chat` response with a typed `{ text, cards?, quickReplies?, crisis?, outOfScope? }` JSON envelope, and move session history management from iOS to the server.

**Architecture:** A new `src/routes/chat.ts` owns the POST `/api/chat` handler — it reads/writes session history via the existing `sessionStore.ts`, calls `workflow.ts`, and parses the agent's JSON output into a `ChatResponse`. The OpenAI agent in `workflow.ts` is retrained via an updated system prompt to always emit valid JSON instead of markdown + `[[expert:slug]]` tags.

**Tech Stack:** TypeScript, Express, OpenAI Agents SDK (`@openai/agents`), `sessionStore.ts` (ioredis + in-memory fallback), Zod (already installed)

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/types.ts` | Add `TherapistCard`, `QuickReply`, `ChatRequest`, `ChatResponse` |
| Modify | `src/workflow.ts` | JSON output, env-var MCP URL, add `planda_search_therapists` tool |
| Create | `src/routes/chat.ts` | `parseAgentOutput`, session read/write, POST `/api/chat` handler |
| Modify | `src/index.ts` | Remove inline `/api/chat` handler, mount `chatRouter` |

---

## Task 1: Add Chat Types to `src/types.ts`

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Open `src/types.ts` and append the following block at the end of the file**

```typescript
// ─── Chat API types ───────────────────────────────────────────────────────────

/** A therapist summary card sent to iOS */
export interface TherapistCard {
  id: number;
  name: string;
  title?: string | null;
  specialties: string[];
  fee?: number | null;
  city?: string | null;
  isOnline: boolean;
  profileUrl: string;
  photo?: string | null;
}

/** A quick-reply button sent to iOS when the assistant asks a question */
export interface QuickReply {
  label: string;  // Button label shown to user — e.g. "Online"
  value: string;  // Value sent as next message — e.g. "online"
}

/** Structured response envelope — iOS renders each field differently */
export interface ChatResponse {
  text: string;
  cards?: TherapistCard[] | null;
  quickReplies?: QuickReply[] | null;
  crisis?: boolean | null;
  outOfScope?: boolean | null;
}

/** Request body for POST /api/chat */
export interface ChatRequest {
  message: string;
  sessionId: string;
}
```

- [ ] **Step 2: Verify TypeScript compiles cleanly**

```bash
cd /path/to/planda-mcp-server && ./node_modules/.bin/tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add ChatResponse, TherapistCard, QuickReply, ChatRequest types"
```

---

## Task 2: Update `src/workflow.ts`

Three changes: (a) env-var for self-referencing MCP URL, (b) add `planda_search_therapists` to allowed tools, (c) replace inline agent instructions with JSON-output version, (d) return `output_json` instead of `output_text`.

**Files:**
- Modify: `src/workflow.ts`

- [ ] **Step 1: Replace the `hostedMcpTool` block (lines ~7-16) with the env-var version**

Find this block:
```typescript
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
```

Replace with:
```typescript
const mcp = hostedMcpTool({
  serverLabel: "Kaan_mcp",
  allowedTools: [
    "planda_list_therapists",
    "planda_get_therapist",
    "planda_search_therapists",
  ],
  requireApproval: "never",
  serverUrl:
    process.env.SELF_MCP_URL ??
    "https://plandamcp-production.up.railway.app/mcp",
});
```

- [ ] **Step 2: Replace the `agentplanda` instructions string**

Find the `agentplanda` Agent definition and replace its `instructions` field with:

```typescript
const agentplanda = new Agent({
  name: "Agentplanda",
  instructions: `Sen Planda platformunda terapist bulan bir asistansın.

## YANIT FORMATI — ZORUNLU JSON
Her yanıtını GEÇERLİ BİR JSON objesi olarak üret.
Asla düz metin, markdown, bold (**), link ([text](url)) veya [[expert:slug]] notasyonu KULLANMA.
Yanıt doğrudan { ile başlamalı, başka hiçbir karakter içermemeli.

Soru tipine göre format seç:

1. Bilgi sorusu (fiyat, isim, şehir, üniversite, sayı, açıklama):
{"text": "Yıldız Cüceloğlu bireysel seans ücreti 2.500 TL.", "cards": null}

2. Terapist önerisi (liste, eşleşme, "terapist bul/öner"):
{"text": "Kaygı için İstanbul'da 3 uzman buldum:", "cards": [{"id": 42, "name": "Dr. Ayşe Kaya", "title": "Klinik Psikolog", "specialties": ["Kaygı", "Depresyon"], "fee": 1800, "city": "İstanbul", "isOnline": true, "profileUrl": "https://www.planda.org/uzmanlar/ayse-kaya", "photo": null}]}

3. Asistan soru soruyor:
{"text": "Görüşmeyi online mı yüz yüze mi tercih edersin?", "quickReplies": [{"label": "Online", "value": "online"}, {"label": "Yüz yüze", "value": "yüz yüze"}, {"label": "Fark etmez", "value": "fark etmez"}]}

4. Kriz sinyali (kendine zarar, intihar ifadesi):
{"text": "Bunu paylaştığın için teşekkür ederim. Şu an yalnız kalmamanı ve hızlı destek almanı istiyorum.", "crisis": true}

5. Kapsam dışı:
{"text": "Bu konuda yardımcı olamıyorum. Sana uygun bir terapist bulmak için buradayım.", "outOfScope": true}

## KART ALANLARI (cards[])
Her kart şu alanları içerir — API'den olduğu gibi doldur:
- id: therapist.id (sayı)
- name: therapist.full_name veya name+" "+surname
- title: therapist.data?.title?.name (yoksa null)
- specialties: therapist.specialties[].name listesi (dizi)
- fee: parseFloat(services[0].custom_fee ?? services[0].fee) (yoksa null)
- city: branches'ta type=="physical" olan ilk kaydın city.name (yoksa null)
- isOnline: branches'ta type=="online" olan kayıt var mı (true/false)
- profileUrl: "https://www.planda.org/uzmanlar/"+therapist.username
- photo: therapist.profile_picture (yoksa null)

## TEMEL KURAL
Kullanıcı mesaj gönderdiği anda direkt ara, sonuçları oku, JSON yanıt üret.
Asla soru sorma, asla "arıyorum" yazma.

## API GERÇEĞİ (test edildi)
Sadece city ve per_page/page filtreleri çalışır. Diğerleri ignored.
AI tarafında filtrele:
- Online/yüz yüze → branches[].type === "online" veya "physical"
- Şehir          → branches[].city.name
- Ücret          → services[].custom_fee ?? services[].fee (string → parseFloat)
- Specialty      → specialties[].name veya specialties[].id ile eşleştir

## UZMANLIK ALANLARI (sabit liste — API çağrısı yapma)
ID:Adı: 47:Aile içi iletişim, 48:Akran İlişkileri, 12:Anlam arayışı, 13:Bağımlılık, 49:Bağlanma sorunları, 50:Cinsel sorunlar, 51:Çift sorunları, 52:Değer çatışmaları, 53:Dikkat ve konsantrasyon, 14:Ebeveynlik, 15:Ergenlik sorunları, 54:Fobi, 55:Gelişimsel sorunlar, 16:İlişki sorunları, 22:İletişim problemleri, 56:İş ve kariyer sorunları, 17:Kaygı(Anksiyete) ve Korku, 26:Kaygı(Anksiyete) ve Korku, 25:Kariyer ve okul sorunları, 30:Kişisel Farkındalık, 18:Kişilik bozuklukları, 57:Kronik hastalık uyumu, 58:Obsesif-Kompulsif Bozukluk, 19:Öfke kontrolü, 59:Özgüven ve kimlik sorunları, 20:Panik Bozukluğu, 60:Somatik belirtiler, 61:Sosyal fobi, 21:Stres yönetimi, 23:İlişkisel Problemler, 36:Uyum ve Adaptasyon Sorunları, 62:Yas ve kayıp, 63:Yeme bozuklukları, 64:Yetişkin DEHB

## ARAÇLAR
- planda_list_therapists      → her zaman tek çağrıyla başla (per_page: 500)
- planda_get_therapist        → SADECE approaches[] sorgusu varsa, EN FAZLA 2 ADAY için
- planda_search_therapists    → isim veya biyografi keyword araması için

## İSİM SORGUSU KURALI
Kullanıcı bir terapistin adını soruyorsa:
- city parametresi KULLANMA
- planda_list_therapists(per_page: 500) → full_name/name/surname ile AI eşleştir
- Büyük/küçük harf ve Türkçe karakter toleransı uygula (ş=s, ğ=g vb.)
- Bulunursa: bilgi sorusu → {"text": "...", "cards": null}
- Bulunmazsa: {"text": "Planda'da bu isimde kayıtlı bir terapist bulunamadı.", "cards": null}

## ŞEHİR KURALI
- Kullanıcı şehir belirtmediyse ASLA tahmin etme.
- Kullanıcı "online" istiyorsa şehir SORMA.
- Yüz yüze veya belirsiz tercihlerde şehri sor.

## SONUÇ SUNUM KURALI
En fazla 2-3 terapist öner. "En iyi", "mükemmel" gibi ifadeler kullanma.
Neden uygun olduğunu tek cümleyle açıkla.`,
  model: "gpt-4.1-mini",
  tools: [mcp],
  modelSettings: {
    store: true,
  },
});
```

- [ ] **Step 3: Change the return value from `output_text` to `output_json`**

Find:
```typescript
    return { output_text: agentResult.finalOutput };
```

Replace with:
```typescript
    return { output_json: agentResult.finalOutput as string };
```

- [ ] **Step 4: Update the `WorkflowInput` export type (no change needed — history is already optional)**

Verify the exported type still matches:
```typescript
export type WorkflowInput = {
  input_as_text: string;
  history?: { role: "user" | "assistant"; content: string }[];
};
```
No change required — leave as-is.

- [ ] **Step 5: Compile check**

```bash
./node_modules/.bin/tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/workflow.ts
git commit -m "feat: agent emits JSON output, add search tool, externalize MCP URL"
```

---

## Task 3: Create `src/routes/chat.ts`

**Files:**
- Create: `src/routes/chat.ts`

- [ ] **Step 1: Create the file with the following content**

```typescript
/**
 * Planda Chat Route — POST /api/chat
 *
 * Handles the iOS chatbot endpoint:
 *   1. Reads conversation history from sessionStore (Redis or in-memory)
 *   2. Calls the OpenAI agent workflow
 *   3. Parses the agent's JSON output into a typed ChatResponse
 *   4. Saves updated history back to sessionStore
 *   5. Returns { text, cards?, quickReplies?, crisis?, outOfScope? }
 */

import { Router, Request, Response } from "express";
import { runWorkflow } from "../workflow.js";
import { getHistory, saveHistory, ChatMessage } from "../sessionStore.js";
import { ChatResponse, ChatRequest } from "../types.js";

export const chatRouter = Router();

// ─── parseAgentOutput ─────────────────────────────────────────────────────────
// Converts the raw string from the agent into a typed ChatResponse.
// Falls back to { text: raw } if JSON.parse fails — system never crashes.

export function parseAgentOutput(raw: string): ChatResponse {
  const trimmed = raw.trim();
  try {
    // Agent sometimes wraps JSON in markdown code fences — strip them
    const cleaned = trimmed
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const json = JSON.parse(cleaned) as Record<string, unknown>;
    return {
      text: typeof json["text"] === "string" ? json["text"] : trimmed,
      cards: Array.isArray(json["cards"]) ? json["cards"] as ChatResponse["cards"] : undefined,
      quickReplies: Array.isArray(json["quickReplies"]) ? json["quickReplies"] as ChatResponse["quickReplies"] : undefined,
      crisis: json["crisis"] === true ? true : undefined,
      outOfScope: json["outOfScope"] === true ? true : undefined,
    };
  } catch {
    // JSON parse failed — return raw text as a plain chat bubble
    return { text: trimmed };
  }
}

// ─── POST /api/chat ───────────────────────────────────────────────────────────

chatRouter.post("/chat", async (req: Request, res: Response) => {
  const { message, sessionId } = req.body as Partial<ChatRequest>;

  if (!message || typeof message !== "string" || message.trim() === "") {
    res.status(422).json({
      error: { code: "VALIDATION_ERROR", message: '"message" alanı zorunludur.' },
    });
    return;
  }

  if (!sessionId || typeof sessionId !== "string") {
    res.status(422).json({
      error: { code: "VALIDATION_ERROR", message: '"sessionId" alanı zorunludur.' },
    });
    return;
  }

  try {
    // 1. Load conversation history for this session
    const history = await getHistory(sessionId);

    // 2. Run the OpenAI agent workflow
    const result = await runWorkflow({
      input_as_text: message.trim(),
      history,
    });

    // 3. Detect guardrail tripwire — result has pii/moderation keys instead of output_json
    const isGuardrailBlock =
      result !== null &&
      typeof result === "object" &&
      ("pii" in result || "moderation" in result);

    let response: ChatResponse;

    if (isGuardrailBlock) {
      response = {
        text: "Bu mesaj gönderilemedi. Lütfen farklı bir şekilde tekrar deneyin.",
        outOfScope: true,
      };
    } else {
      const rawOutput =
        (result as { output_json?: string; output_text?: string }).output_json ??
        (result as { output_text?: string }).output_text ??
        "";
      response = parseAgentOutput(rawOutput);
    }

    // 4. Persist updated history (only if not a guardrail block)
    if (!isGuardrailBlock) {
      const updated: ChatMessage[] = [
        ...history,
        { role: "user", content: message.trim() },
        {
          role: "assistant",
          content:
            (result as { output_json?: string; output_text?: string }).output_json ??
            (result as { output_text?: string }).output_text ??
            response.text,
        },
      ];
      await saveHistory(sessionId, updated);
    }

    // 5. Return typed ChatResponse
    res.json(response);
  } catch (err: unknown) {
    console.error("[chat] Unhandled error:", err);
    res.status(502).json({
      error: {
        code: "UPSTREAM_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
});
```

- [ ] **Step 2: Compile check**

```bash
./node_modules/.bin/tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/routes/chat.ts
git commit -m "feat: add chat route with session history and typed JSON response"
```

---

## Task 4: Wire Up in `src/index.ts`

Remove the inline `/api/chat` and `/api/create-session` handlers and replace with the new router.

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add the import at the top of `src/index.ts`**

Find:
```typescript
import { therapistRouter } from "./routes/therapists.js";
```

Replace with:
```typescript
import { therapistRouter } from "./routes/therapists.js";
import { chatRouter } from "./routes/chat.js";
```

- [ ] **Step 2: Register the chat router right after the therapistRouter line**

Find:
```typescript
  app.use("/api", therapistRouter);
```

Replace with:
```typescript
  app.use("/api", therapistRouter);
  app.use("/api", chatRouter);
```

- [ ] **Step 3: Remove the old inline `/api/create-session` and `/api/chat` handlers**

Delete everything between (and including) these two comment blocks:

```typescript
  // ── ChatKit session — exchanges workflow ID for a client secret ──────────────
  app.post("/api/create-session", async (req: Request, res: Response) => {
    ...
  });

  // ── Chat API — runs OpenAI Agents workflow ────────────────────────────────────
  app.post("/api/chat", async (req: Request, res: Response) => {
    ...
  });
```

These are now handled by `chatRouter`. `/api/create-session` (ChatKit) is unused by the iOS app and can be safely removed. If you need it later, it can be moved to a dedicated `routes/chatkit.ts`.

- [ ] **Step 4: Compile check**

```bash
./node_modules/.bin/tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Full build**

```bash
./node_modules/.bin/tsc
```
Expected: clean build, `dist/routes/chat.js` created.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: mount chatRouter, remove legacy /api/chat inline handler"
```

---

## Task 5: Manual Test (curl)

Verify all 5 response types work correctly before deploy.

**Files:** none — read-only testing

- [ ] **Step 1: Start the server locally**

```bash
TRANSPORT=http PORT=3001 OPENAI_API_KEY=<your-key> SELF_MCP_URL=https://plandamcp-production.up.railway.app/mcp node dist/index.js
```

- [ ] **Step 2: Test — health check**

```bash
curl http://localhost:3001/health
```
Expected:
```json
{"status":"ok","server":"planda-mcp-server","version":"1.0.0"}
```

- [ ] **Step 3: Test — bilgi sorusu (cards null)**

```bash
curl -s -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Yıldız Cüceloğlu seans ücreti ne kadar?","sessionId":"test-001"}' | python3 -m json.tool
```
Expected: `text` alanı dolu, `cards` yok veya `null`.

- [ ] **Step 4: Test — terapist önerisi (cards dolu)**

```bash
curl -s -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Kaygı için İstanbul'\''da terapist arıyorum","sessionId":"test-002"}' | python3 -m json.tool
```
Expected: `text` dolu, `cards` dizisi en az 1 öğe içeriyor, her öğede `id`, `name`, `profileUrl` var.

- [ ] **Step 5: Test — asistan soru soruyor (quickReplies)**

```bash
curl -s -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Terapist arıyorum","sessionId":"test-003"}' | python3 -m json.tool
```
Expected: `quickReplies` dizisi var (Online, Yüz yüze gibi seçenekler).

- [ ] **Step 6: Test — session sürekliliği**

```bash
# İlk mesaj
curl -s -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Kaygım var","sessionId":"test-session-99"}' | python3 -m json.tool

# İkinci mesaj — agent bağlamı hatırlamalı
curl -s -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Online tercih ediyorum","sessionId":"test-session-99"}' | python3 -m json.tool
```
Expected: İkinci yanıtta agent "kaygı için online terapist" bağlamıyla devam ediyor.

- [ ] **Step 7: Test — validation error**

```bash
curl -s -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"test"}' | python3 -m json.tool
```
Expected: HTTP 422, `{ "error": { "code": "VALIDATION_ERROR", ... } }`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "test: manual curl verification complete"
```

---

## Railway Deploy

After all tasks pass:

- [ ] Push to Railway branch

```bash
git push
```

- [ ] Add `SELF_MCP_URL` environment variable in Railway dashboard:

```
SELF_MCP_URL=https://plandamcp-production.up.railway.app/mcp
```

- [ ] Verify Railway deploy health:

```bash
curl https://plandamcp-production.up.railway.app/health
```

---

## iOS Tarafı (Referans — Sunucu değişikliği tamamlandıktan sonra)

```swift
// Eski istek:
// let body = ["message": msg, "history": history]

// Yeni istek:
let body: [String: String] = [
    "message": userMessage,
    "sessionId": storedSessionId  // UserDefaults'tan al, yoksa UUID().uuidString ile oluştur
]

// Yanıt modeli:
struct ChatResponse: Decodable {
    let text: String
    let cards: [TherapistCard]?
    let quickReplies: [QuickReply]?
    let crisis: Bool?
    let outOfScope: Bool?
}

struct TherapistCard: Decodable {
    let id: Int
    let name: String
    let title: String?
    let specialties: [String]
    let fee: Double?
    let city: String?
    let isOnline: Bool
    let profileUrl: String
    let photo: String?
}

struct QuickReply: Decodable {
    let label: String
    let value: String
}

// Render:
showTextBubble(response.text)
if let cards = response.cards { showTherapistCards(cards) }
if let replies = response.quickReplies { showQuickReplyButtons(replies) }
if response.crisis == true { showCrisisHotlineButton(number: "182") }
```
