/**
 * Unit tests for the card-hold stream gate.
 *
 * Regression (iOS, 2026-08-31 video): the model skipped the modality rung
 * and answered with cards; /chat/stream forwarded that raw text to iOS as a
 * delta, then the ladder guard replaced it with a question via `corrected`.
 * Users saw cards flash for ~1.5s and vanish. The gate holds any delta once
 * a card marker shows up so nothing card-shaped reaches the client before
 * the guards have ruled on it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCardHold } from "../src/streamGate.js";

test("plain conversational text passes through untouched", () => {
  const gate = createCardHold();
  assert.equal(gate.push("Anlıyorum, bu gerçekten zorlayıcı olabilir. "), "Anlıyorum, bu gerçekten zorlayıcı olabilir. ");
  assert.equal(gate.push("Kaç yaşındasın?"), "Kaç yaşındasın?");
  assert.equal(gate.held, false);
  assert.equal(gate.streamed, "Anlıyorum, bu gerçekten zorlayıcı olabilir. Kaç yaşındasın?");
});

test("a single-shot delta carrying an expert tag is held entirely", () => {
  const gate = createCardHold();
  const full =
    "İstanbul'da kaygı alanında çalışanlara baktım:\n\n" +
    "**Ekin Alankuş** — Uzman Psikolog\nÜcret: 6000 TL\n[[expert:ekin_alankus]]";
  assert.equal(gate.push(full), null);
  assert.equal(gate.held, true);
  assert.equal(gate.streamed, "");
});

test("a bold card header with a dash is enough to hold, even without a tag yet", () => {
  const gate = createCardHold();
  assert.equal(gate.push("Şu 3 ismi öne çıkarıyorum:\n\n**Feyzanur Telli** — Klinik Psikolog"), null);
  assert.equal(gate.held, true);
});

test("token streaming: once held, every later delta is swallowed", () => {
  const gate = createCardHold();
  assert.equal(gate.push("Baktım; "), "Baktım; ");
  assert.equal(gate.push("[[expert:"), null);
  assert.equal(gate.push("ekin_alankus]]"), null);
  assert.equal(gate.push(" İlk önerim Ekin."), null);
  assert.equal(gate.streamed, "Baktım; ");
});

test("ordinary bold emphasis mid-sentence does not trigger the hold", () => {
  const gate = createCardHold();
  const text = "Bu konuda **en önemli** adım ilk görüşme — sonrasını birlikte planlarız.";
  assert.equal(gate.push(text), text);
  assert.equal(gate.held, false);
});
