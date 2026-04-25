# Planda Assistant — Eval Harness

Automated quality checks for the therapist-matching assistant.

## Komutlar

```bash
# Tüm testleri çalıştır (deterministik assertion'lar)
npm run eval

# LLM-as-judge skorlamasıyla birlikte
npm run eval -- --judge

# Sadece belirli kategori / id
npm run eval -- --filter search
npm run eval -- --filter availability
```

## Dataset

`evals/dataset.jsonl` — her satır bir test case (JSON):

| alan | anlam |
|------|-------|
| `id` | benzersiz case id |
| `category` | `search` / `availability` / `approach` / `trap` / `oos` / `greeting` / `followup` |
| `input` | kullanıcı mesajı |
| `history` | (opsiyonel) önceki tur(lar) |
| `expected_tools` | çağrılması beklenen tool isimleri — boş array "hiç tool çağrılmamalı" |
| `expected_intent` | classifier'ın dönmesi gereken intent |
| `must_contain` / `must_contain_any` / `must_not_contain` | substring assertion'ları |
| `must_contain_tag` / `must_not_contain_tag` | `[[expert:...]]` tag varlığı |
| `notes` | case neyi test ediyor — judge'a ipucu |

## Yeni case ekleme

1. Production log'unda bir regresyon gör (`logs/conversations.jsonl`).
2. Davranışı bir satıra çevir — bkz. var olan örnekler.
3. `tsx evals/run.ts --filter <id>` ile tek case'i çalıştır, geçtiğini doğrula.
4. Commit.

## İnsan Review — İki Mod

LLM judge'a ek olarak insanlar `review.html` ile rapordaki cevapları
gözden geçirip kararını verir. İki kullanım modu var:

### Mod A — Sunucu (Ekip için, çoklu reviewer)

Production server review API'sini host eder. 5 kişilik ekip aynı
raporu görür, kararları sunucuda toplanır.

**Kurulum (bir kez):**

1. Railway'de bir **persistent volume** oluştur (Settings → Volumes).
   Mount path: `/data` (veya istediğin yer; `RAILWAY_VOLUME_MOUNT_PATH`
   env variable otomatik set olacak).
2. Aşağıdaki env variable'ı Railway dashboard'tan ekle:
   ```
   REVIEW_USERS=kaan:sifre1,ayse:sifre2,mehmet:sifre3,zeynep:sifre4,ali:sifre5
   ```
   Her kullanıcı kendi şifresiyle login olur, kararları kim verdiğine
   göre kayıt edilir.
3. Deploy.

**Akış:**

```bash
# 1. Lokal'de eval koş
npm run eval -- --judge

# 2. Raporu sunucuya yükle (.env'de REVIEW_BASE_URL, REVIEW_USER, REVIEW_PASS olmalı)
npm run eval:upload

# 3. Ekip URL'i açar
#    https://<host>/review
#    → Browser basic-auth popup'ı çıkar, kullanıcı adı + şifre yazılır
#    → En son rapor otomatik yüklenir, dataset.jsonl otomatik gelir
#    → Her reviewer kendi kararını verir, takım kararları yan tarafta görünür
```

**Env variable'lar (lokal `.env`):**
```
REVIEW_BASE_URL=https://plandamcp-production.up.railway.app
REVIEW_USER=kaan
REVIEW_PASS=sifre1
```

### Mod B — Lokal (Tek kişi için)

Sunucusuz — `review.html` dosyasını tarayıcıda aç:

```bash
# Çift tıkla veya:
cd evals && python3 -m http.server 8080
# → http://localhost:8080/review.html
```

UI'da:
1. **Eval rapor (JSON)** alanından `reports/<ts>.json`'u seç
2. **Dataset (JSONL)** alanından `dataset.jsonl`'i seç
3. Kararlar tarayıcı `localStorage`'ında saklanır

### Karar verme

- **Sadece şüpheliler** kutusu — judge ≤3 veya assertion fail olanlar
- 4 buton: **Mükemmel / İyi / Orta / Kötü** (klavyeden 1/2/3/4)
- Opsiyonel not — özellikle "Kötü" verirken **neden** yaz, regression
  senaryosuna otomatik geçer
- Klavye: `j`/`k` veya `↑`/`↓` ile senaryolar arası

### Export (her iki mod)

- **Kararları İndir** — tüm kararların JSON dökümü
- **Kötü/Orta → regression-additions.jsonl** — `dataset.jsonl`'e
  eklenebilecek hazır regression senaryoları
- **Mükemmel/İyi → good-examples.jsonl** — gelecekteki few-shot
  retrieval havuzu için

## CI

Her PR'de çalıştırmak için:

```yaml
- run: npm ci
- run: npm run eval
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Çıkış kodu: tüm case'ler geçerse 0, biri fail'se 1.

## Rapor

Her run sonunda `evals/reports/<timestamp>.json` yazılır. Pass/fail, latency, tool calls, judge skoru (kullanıldıysa), her başarısız assertion'ın detayı içerir. Trend izlemek için saklayın.
