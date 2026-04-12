# Planda iOS Chatbot API — Tasarım Spesifikasyonu

**Tarih:** 2026-04-12
**Durum:** Onaylandı
**Kapsam:** Sunucu tarafı yeniden yapılandırma + iOS entegrasyon sözleşmesi

---

## Problem

Mevcut `/api/chat` endpoint'i her yanıtı düz markdown string olarak döndürüyor. iOS bu metni parse ederek her şeyi kart yapıyor — fiyat sorusu, isim sorgusu ve terapist önerisi arasında fark görmüyor. Kullanıcı "Yıldız Cüceloğlu seans ücreti ne kadar?" dediğinde "Uzman / Detaylar için tıklayın" kartı çıkıyor. Bu yanlış.

---

## Hedef

İki farklı etkileşim modunu düzgün desteklemek:

1. **Kısa chat cevabı** — fiyat, isim, şehir gibi bilgi sorularında sade metin balonu
2. **Terapist önerisi** — eşleşme sorgularında metin + native profil kartları

Ayrıca konuşma bağlamını sunucu tarafında tutmak (session), iOS'un her seferinde history göndermesini önlemek.

---

## API Sözleşmesi

### İstek

```
POST /api/chat
Content-Type: application/json

{
  "message": "Kaygı için İstanbul'da terapist arıyorum",
  "sessionId": "uuid-ios-tarafinda-uretilir"
}
```

`sessionId` iOS tarafında UUID olarak üretilir ve cihazda saklanır. Sunucu bu ID üzerinden konuşma geçmişini yönetir.

### Yanıt

```typescript
interface ChatResponse {
  text: string;             // Her zaman var — metin balonu olarak gösterilir
  cards?: TherapistCard[];  // Terapist önerisi varsa
  quickReplies?: QuickReply[]; // Asistan soru sorduğunda
  crisis?: boolean;         // Kriz sinyali tespit edildiğinde
  outOfScope?: boolean;     // Kapsam dışı sorularda
}
```

### Yanıt Tipleri ve Örnekler

**1. Kısa bilgi sorusu**
```json
{
  "text": "Yıldız Cüceloğlu bireysel seans ücreti 2.500 TL.",
  "cards": null
}
```

**2. Terapist önerisi**
```json
{
  "text": "Kaygı için İstanbul'da 3 uzman buldum:",
  "cards": [
    {
      "id": 42,
      "name": "Dr. Ayşe Kaya",
      "title": "Klinik Psikolog",
      "specialties": ["Kaygı", "Depresyon"],
      "fee": 1800,
      "city": "İstanbul",
      "isOnline": true,
      "profileUrl": "https://www.planda.org/uzmanlar/ayse-kaya",
      "photo": "https://..."
    }
  ]
}
```

**3. Asistan soru soruyor**
```json
{
  "text": "Görüşmeyi online mı yüz yüze mi tercih edersin?",
  "quickReplies": [
    { "label": "Online", "value": "online" },
    { "label": "Yüz yüze", "value": "yüz yüze" },
    { "label": "Fark etmez", "value": "fark etmez" }
  ]
}
```

**4. Kriz tespiti**
```json
{
  "text": "Zor bir dönemdeysin, yalnız değilsin. Hemen destek alabilirsin:",
  "crisis": true
}
```
iOS bu yanıtta "182 ALO Psikiyatri Hattı" arama butonu gösterir.

**5. Kapsam dışı**
```json
{
  "text": "Bu konuda yardımcı olamıyorum. Sana uygun bir terapist bulmak için buradayım.",
  "outOfScope": true
}
```

---

## Veri Tipleri

```typescript
interface TherapistCard {
  id: number;
  name: string;
  title?: string;
  specialties: string[];
  fee?: number;
  city?: string;
  isOnline: boolean;
  profileUrl: string;
  photo?: string;
}

interface QuickReply {
  label: string;   // Buton etiketi — "Online"
  value: string;   // Gönderilecek mesaj — "online"
}

interface ChatRequest {
  message: string;
  sessionId: string;
}
```

---

## Sunucu Mimarisi

### Bileşenler

```
iOS
 └── POST /api/chat { message, sessionId }
       │
       ▼
 routes/chat.ts          ← YENİ — session + parse mantığı buraya
       ├── sessionStore.getHistory(sessionId)
       ├── workflow.ts çağır
       │       └── OpenAI Agent (gpt-4.1-mini)
       │               └── MCP tools (planda_list_therapists, planda_get_therapist, planda_search_therapists)
       │                       └── app.planda.org/api/v1
       ├── parseAgentOutput(raw) → ChatResponse
       └── sessionStore.saveHistory(sessionId, updatedHistory)
       │
       ▼
iOS ← { text, cards?, quickReplies?, crisis?, outOfScope? }
```

### Parse Mantığı (Fallback'li)

Agent her yanıtı JSON olarak üretecek şekilde eğitilir. Sunucu bu JSON'u parse eder. Parse başarısız olursa (agent bazen düz metin üretebilir) tüm metin `text` alanına konur, diğer alanlar boş kalır — sistem çökmez.

```typescript
function parseAgentOutput(raw: string): ChatResponse {
  try {
    const json = JSON.parse(raw);
    return {
      text: json.text ?? raw,
      cards: json.cards ?? undefined,
      quickReplies: json.quickReplies ?? undefined,
      crisis: json.crisis ?? undefined,
      outOfScope: json.outOfScope ?? undefined,
    };
  } catch {
    return { text: raw }; // fallback
  }
}
```

---

## Session Yönetimi

`sessionStore.ts` zaten hazır (Redis + in-memory fallback). Değişen tek şey: `/api/chat` artık `sessionId` alır ve geçmişi kendisi yönetir.

- **TTL:** 30 dakika hareketsizlik → session silinir (mevcut ayar korunur)
- **Max geçmiş:** 40 tur (80 mesaj) — mevcut `MAX_HISTORY_TURNS` ayarı korunur
- **iOS:** `sessionId`'yi `UserDefaults`'a kaydeder, uygulama silinene kadar aynı ID kullanılır

---

## System Prompt Değişikliği

`prompts.ts`'e eklenecek zorunlu JSON format kuralı:

```
YANIT FORMATI — ZORUNLU
Her yanıtını geçerli bir JSON objesi olarak üret.
Asla düz metin, markdown, bold (**), link ([text](url)) kullanma.

Soru tipi → format:
- Bilgi sorusu:    {"text": "...", "cards": null}
- Terapist listesi: {"text": "...", "cards": [{id, name, title, specialties, fee, city, isOnline, profileUrl, photo}]}
- Soru sorma:      {"text": "...", "quickReplies": [{"label":"...","value":"..."}]}
- Kriz:            {"text": "...", "crisis": true}
- Kapsam dışı:     {"text": "...", "outOfScope": true}
```

---

## Değişen Dosyalar

| Dosya | Değişiklik |
|---|---|
| `src/types.ts` | `TherapistCard`, `QuickReply`, `ChatRequest`, `ChatResponse` tipleri eklenir |
| `src/prompts.ts` | JSON format kuralı system prompt'a eklenir |
| `src/routes/chat.ts` | YENİ — session yönetimi + parse mantığı |
| `src/index.ts` | `/api/chat` route'u `routes/chat.ts`'e devredilir |
| `src/workflow.ts` | `output_text` → `output_json` döndürecek şekilde güncellenir |

**Dokunulmayan dosyalar:** `auth.ts`, `sessionStore.ts`, `tools/therapists.ts`, `services/apiClient.ts`, `constants.ts`

---

## Mevcut vs Yeni — Özet

| | Şu an | Yeni |
|---|---|---|
| İstek formatı | `{ message, history[] }` | `{ message, sessionId }` |
| Yanıt formatı | `{ response: string }` | `{ text, cards?, quickReplies?, crisis? }` |
| Geçmiş kim tutar | iOS | Sunucu (Redis/memory) |
| Kart kararı | iOS markdown parse eder | Sunucu açıkça söyler |
| Kriz tespiti | Yok | `crisis: true` flag |
| Session | Her seferinde sıfır | `sessionId` ile sürekli |

---

## iOS Tarafı (Referans)

```swift
struct ChatResponse: Decodable {
    let text: String
    let cards: [TherapistCard]?
    let quickReplies: [QuickReply]?
    let crisis: Bool?
    let outOfScope: Bool?
}

// Render kararı:
showTextBubble(response.text)                          // her zaman
if let cards = response.cards { showCards(cards) }
if let replies = response.quickReplies { showQuickReplyButtons(replies) }
if response.crisis == true { showCrisisHotlineButton() }
```

---

## Deployment Notu

`workflow.ts` içinde MCP server URL'i hard-coded:
```typescript
serverUrl: "https://plandamcp-production.up.railway.app/mcp"
```
Bu sunucu kendi kendini çağırıyor. Railway'de URL değişirse bu satır da güncellenmeli. `SELF_MCP_URL` env var'ı olarak dışarı alınması önerilir.

---

## Desteklenen Soru Kategorileri

Bu tasarımla aşağıdaki tüm kategoriler doğru yanıtlanabilir:

- Terapist bulma (kriter bazlı) → `cards`
- İsim sorguları (fiyat, şehir, profil) → `text`
- Üniversite / eğitim sorguları → `text` veya `cards`
- Unvan / meslek sorguları → `cards`
- Yaş / danışan profili → `cards`
- Ücret bazlı sorgular → `text` veya `cards`
- Seans tipi / süresi → `cards`
- Lokasyon / semt → `cards`
- Puan sıralaması → `cards`
- Biyografi keyword arama → `cards` (planda_search_therapists)
- Asistan soru sorma → `quickReplies`
- Kriz sinyali → `crisis`
- Kapsam dışı → `outOfScope`
