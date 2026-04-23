# Planda Fine-Tuning Datasets

Bu klasör Sentry violation event'lerinden türetilmiş fine-tuning veri setini içerir.

## Dosyalar

| Dosya | Amaç | Format | Satır |
|---|---|---|---|
| `sentry_raw_events.jsonl` | Ham Sentry turn verileri — referans ve QA için | JSON | 9 |
| `intent_classification.jsonl` | Intent sınıflandırma fine-tune | OpenAI chat format | 7 |
| `tool_use_corrections.jsonl` | Tool use davranış düzeltmesi — ideal cevaplar | OpenAI chat format | 5 |
| `extract_from_sentry.py` | Sentry API'dan taze veri çeken script | Python 3.10+ | — |

## Mevcut Dataset Özeti (2026-04-23 itibarıyla)

**Toplam violation event:** 9  
**Unique session:** 5  
**Zaman aralığı:** 1 saat 00 dakika (08:41 — 09:41 UTC)

### Violation türleri

- `intent_mismatch` (7 event): classifier bir tool bekliyordu ama model çağırmadı
- `intent_mismatch + unknown_therapist` (2 event): model terapist kartı uydurdu

### Kritik bulgular

**Aynı mesaj, farklı sonuç:** "Kendim için psikolog arıyorum" 3 kez geldi:
- 1 kez tool çağırıp netleştirici soru sordu (doğru)
- 2 kez tool çağırmadan netleştirici soru sordu (guard tetikledi)

Bu aslında **doğru davranış** — belirsiz istek → netleştirme. Classifier yanlışlıkla violation üretmiş. `intentClassifier.ts`'teki `hasEnoughInfo` kontrolü bunu zaten düzeltti (`expectedTools: []` vague search'te).

**Uydurma kart (NODE-2 class):** "Kaygı için hangi terapist uygun?" ve "İstanbul yuzyuze" → model 3 terapist kartı üretti, hiç tool çağırmadı. Fees/lokasyon bilgileri uydurma.

**Availability tool bypass:** "Ekin'in müsait günü?" → model "müsait değil" cevabı verdi, hiç `get_therapist_available_days` çağırmadan. Bu dangerous — kullanıcıya yanlış bilgi veriyor.

## Fine-Tuning İçin Yeterli mi?

**Hayır — henüz değil.**

OpenAI fine-tuning minimum **10 örnek** istiyor, önerilen **50-100 örnek**. Elimizde sadece 9 violation var. İki çözüm:

### A) Data augmentation (bu hafta yapılabilir)

`intent_classification.jsonl`'e manuel olarak **pozitif örnekler** ekleyin:
- Her intent kategorisi için 10-15 sentetik örnek
- `evals/dataset.jsonl` (mevcut eval datası) zaten iyi bir kaynak
- Hedef: 80-100 örnek

### B) Production telemetry (2-4 hafta sürer)

Railway'deki `logs/conversations.jsonl` dosyası **tüm** turn'leri (violation olsun olmasın) saklıyor. Bu production'da birikiyor. Railway CLI ile çekilebilir:

```bash
railway logs --service planda-mcp-server --json > prod_turns.jsonl
```

Bu dosyadan "violations yok + intent doğru + tool_count beklenen" turn'leri filtreleyerek **500+ pozitif örnek** birikebilir.

## Kullanım

### Sentry'den taze veri çekmek

```bash
cd evals/datasets
export SENTRY_AUTH_TOKEN="sntryu_..."   # sentry.io/settings/account/api/auth-tokens
python3 extract_from_sentry.py
```

Bu script `intent_classification.jsonl`'i üzerine yazar. Son 90 günlük tüm violation'ları çeker.

### OpenAI fine-tune başlatmak (yeterli veri olunca)

```bash
# 1. Veriyi validate et
openai tools fine_tunes.prepare_data -f intent_classification.jsonl

# 2. Upload
openai api files.create -f intent_classification.jsonl -p fine-tune

# 3. Fine-tune başlat (dosya ID'si prev komuttan döner)
openai api fine_tuning.jobs.create \
  -t file-XXXXX \
  -m gpt-4.1-mini-2024-07-18
```

Fine-tune tamamlandığında yeni model ID'sini (`ft:gpt-4.1-mini:planda:v1` gibi) `src/workflow.ts`'deki `OPENAI_MODEL` env'ine yazın.

### Eval harness ile test

Mevcut `evals/run.ts` dataset üzerinde LLM judge ile skor üretiyor. Fine-tune'dan önce ve sonra çalıştırıp karşılaştırın:

```bash
OPENAI_MODEL=gpt-4.1-mini npm run eval:judge > before.txt
OPENAI_MODEL=ft:gpt-4.1-mini:planda:v1 npm run eval:judge > after.txt
diff before.txt after.txt
```

## Bir sonraki adımlar

1. **Bu hafta:** Intent classification dataset'ini 50 örneğe çıkar (sentetik + mevcut `dataset.jsonl`)
2. **1-2 hafta sonra:** Railway logs'tan pozitif örnekleri toplamaya başla (yeni guard'lar sayesinde hatalar düştü → temiz veri artacak)
3. **3-4 hafta sonra:** 500+ örnek biriktiğinde ilk fine-tune'u intent classifier için dene
4. **Ölçüm:** Sentry'deki `intent=*` tag'ini gruplandır, fine-tune öncesi/sonrası violation oranını karşılaştır

## Referanslar

- OpenAI fine-tuning guide: https://platform.openai.com/docs/guides/fine-tuning
- Sentry Events API: https://docs.sentry.io/api/events/
- Chat format şeması: https://platform.openai.com/docs/guides/fine-tuning/example-format
