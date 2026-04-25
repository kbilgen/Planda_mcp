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

## İnsan Review (`review.html`)

LLM judge'a ek olarak proje sahibi rapordaki cevapları gözden geçirip
kendi kararını verebilir. Akış:

```bash
# 1. Eval'i koş (judge ile)
npm run eval -- --judge

# 2. review.html'i tarayıcıda aç (dosyayı çift tıkla veya basit bir
#    static server kullan)
cd evals && python3 -m http.server 8080
# → http://localhost:8080/review.html
```

UI'da:
1. **Eval rapor (JSON)** alanından az önce üretilen `reports/<ts>.json`'u seç
2. **Dataset (JSONL)** alanından `dataset.jsonl`'i seç (beklenen davranış görünsün)
3. **Sadece şüpheliler** kutusunu işaretle — judge skoru ≤3 ya da assertion fail olanlar
4. Her senaryo için **Mükemmel / İyi / Orta / Kötü** seç + opsiyonel not yaz
5. Bitirince **Dışa aktar**:
   - `review-decisions-*.json` — tüm kararların kaydı
   - `regression-additions-*.jsonl` — Kötü/Orta kararlar otomatik regression senaryosuna dönüşür, `dataset.jsonl`'in sonuna kopyalayabilirsin
   - `good-examples-*.jsonl` — Mükemmel/İyi olanlar few-shot havuzuna eklenebilir

Kararlar tarayıcı `localStorage`'ında saklanır — sayfayı kapatırsan
kaybolmaz. Klavye kısayolları: `1`/`2`/`3`/`4` karar, `j`/`k` veya
ok tuşları senaryo değiştir.

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
