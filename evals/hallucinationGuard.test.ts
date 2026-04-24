/**
 * Unit tests for shouldUseFallback — the policy that decides whether to
 * replace a suspect agent response with the safe fallback.
 *
 * Run:
 *   npm run test:unit
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldUseFallback,
  extractUserRequest,
  extractMismatchedUsernames,
  pruneMismatchedCards,
  buildMatchBlock,
  buildSpecialtyLine,
  buildLocationLine,
  detectMetaHallucination,
  stripPermissionTail,
} from "../src/guards/hallucinationGuard.js";
import {
  resolveLocation,
  therapistInDistrict,
  istanbulSide,
  matchesIstanbulSide,
} from "../src/services/locationNormalizer.js";
import type { Therapist } from "../src/types.js";

test("no violations → keep response", () => {
  assert.equal(shouldUseFallback([], 1), false);
  assert.equal(shouldUseFallback([], 0), false);
});

test("single unknown_therapist + no tool call → REPLACE (rule #2)", () => {
  assert.equal(
    shouldUseFallback([{ kind: "unknown_therapist", value: "Fake Name" }], 0),
    true
  );
});

test("single unknown_therapist + tool was called → keep (fuzzy edge)", () => {
  assert.equal(
    shouldUseFallback([{ kind: "unknown_therapist", value: "Fake Name" }], 1),
    false
  );
});

test("two unknown_therapist violations → REPLACE (rule #3)", () => {
  assert.equal(
    shouldUseFallback(
      [
        { kind: "unknown_therapist", value: "Fake One" },
        { kind: "unknown_therapist", value: "Fake Two" },
      ],
      2
    ),
    true
  );
});

// ─── Rule #5 — card-without-tool-call (NODE-2 regression) ────────────────────

test("bold header + no tool call → REPLACE (rule #5, NODE-2 class)", () => {
  const response =
    "**Yıldız Hacıevliyagil Cüceloğlu** — Uzman Psikolog\n" +
    "Ücret: 6500 TL\n" +
    "Görüşme: Online";
  assert.equal(shouldUseFallback([], 0, response), true);
});

test("expert tag + no tool call → REPLACE (rule #5)", () => {
  const response =
    "Sana uygun birini buldum:\n[[expert:ayse-demir]]";
  assert.equal(shouldUseFallback([], 0, response), true);
});

test("bold header + tool WAS called → keep (tool verified)", () => {
  const response = "**Real Therapist** — Psikolog";
  assert.equal(shouldUseFallback([], 1, response), false);
});

test("plain prose (no card) + no tool call → keep", () => {
  const response =
    "Kendiniz için destek aradığını anladım. Hangi konuda yardım almak istersin?";
  assert.equal(shouldUseFallback([], 0, response), false);
});

test("missing responseText arg — rule #5 skipped, #1–4 still apply", () => {
  // Only violation-based rules fire when responseText isn't provided
  assert.equal(shouldUseFallback([], 0), false);
  assert.equal(
    shouldUseFallback([{ kind: "unknown_therapist", value: "X" }], 0),
    true
  );
});

// ─── Fix A — extractUserRequest / pruneMismatchedCards ───────────────────────

test("extractUserRequest parses city, topic, budget, approach, online", () => {
  const r = extractUserRequest(
    "İstanbul'da anksiyete için BDT yapan online terapist, bütçem 3000"
  );
  assert.equal(r.city, "İstanbul");
  assert.ok(r.topics.includes("kaygi"));
  assert.equal(r.approach, "BDT / Bilişsel Davranışçı Terapi");
  assert.equal(r.prefersOnline, true);
  assert.equal(r.maxFee, 3000);
});

test("extractUserRequest returns empty when message is generic", () => {
  const r = extractUserRequest("terapi arıyorum");
  assert.equal(r.city, null);
  assert.equal(r.maxFee, null);
  assert.equal(r.approach, null);
  assert.equal(r.prefersOnline, null);
  assert.deepEqual(r.topics, []);
});

test("extractMismatchedUsernames pulls slugs from violation values", () => {
  const set = extractMismatchedUsernames([
    {
      kind: "specialty_mismatch",
      value: "ekin_alankus (user topic: iliski; therapist specialties: Travma)",
    },
    {
      kind: "specialty_mismatch",
      value: "yildiz_hacievliyagil_cuceloglu (user topic: iliski; ...)",
    },
    { kind: "unknown_therapist", value: "ignored" },
  ]);
  assert.equal(set.size, 2);
  assert.ok(set.has("ekin_alankus"));
  assert.ok(set.has("yildiz_hacievliyagil_cuceloglu"));
});

test("pruneMismatchedCards removes bad card, keeps good one", () => {
  const response =
    "Birkaç isim buldum:\n\n" +
    "**Yıldız Hacıevliyagil** — Uzman Psikolog\n" +
    "Uzmanlık: İlişkisel\n" +
    "Ücret: 6500 TL\n" +
    "[[expert:yildiz_hacievliyagil]]\n\n" +
    "**Ekin Alankuş** — Uzman Psikolog\n" +
    "Uzmanlık: Travma\n" +
    "[[expert:ekin_alankus]]\n";
  const result = pruneMismatchedCards(response, new Set(["ekin_alankus"]));
  assert.equal(result.removedCount, 1);
  assert.equal(result.keptCount, 1);
  assert.ok(result.response.includes("yildiz_hacievliyagil"));
  assert.ok(!result.response.includes("ekin_alankus"));
  assert.ok(result.response.includes("Birkaç isim buldum"));
});

test("pruneMismatchedCards with empty set is noop", () => {
  const text = "**Ekin Alankuş** — Uzman Psikolog\n[[expert:ekin_alankus]]";
  const result = pruneMismatchedCards(text, new Set());
  assert.equal(result.response, text);
  assert.equal(result.removedCount, 0);
});

test("pruneMismatchedCards can remove all cards (keptCount=0 signals fallback)", () => {
  const response =
    "**A B** — T\n[[expert:a_b]]\n\n**C D** — T\n[[expert:c_d]]\n";
  const result = pruneMismatchedCards(response, new Set(["a_b", "c_d"]));
  assert.equal(result.keptCount, 0);
  assert.equal(result.removedCount, 2);
});

// ─── Fix D — buildMatchBlock ─────────────────────────────────────────────────

const fakeTherapist: Therapist = {
  id: 1,
  name: "Ekin",
  surname: "Alankuş",
  full_name: "Ekin Alankuş",
  username: "ekin_alankus",
  specialties: [
    { id: 1, name: "İlişkisel Problemler" },
    { id: 2, name: "Depresyon" },
  ],
  branches: [
    { id: 10, type: "physical", name: "Nişantaşı", city: { id: 1, name: "İstanbul" } },
    { id: 11, type: "online", name: "Online" },
  ],
  services: [
    { id: 63, name: "Bireysel Terapi", fee: "6000.00" },
  ],
  approaches: [
    { id: 1, name: "Gestalt" },
  ],
};

test("buildMatchBlock shows ✓ lines for criteria the therapist matches", () => {
  const req = extractUserRequest(
    "İstanbul'da ilişki sorunu için terapist, bütçem 7000"
  );
  const block = buildMatchBlock(fakeTherapist, req);
  assert.match(block, /Eşleşme:/);
  assert.match(block, /✓ Uzmanlık: İlişkisel Problemler/);
  assert.match(block, /✓ Şehir: İstanbul — Nişantaşı/);
  assert.match(block, /✓ Bütçe: 6\.000 TL/);
});

test("buildMatchBlock shows — for approach when approaches[] not populated", () => {
  const therapistNoApproach: Therapist = { ...fakeTherapist, approaches: [] };
  const req = extractUserRequest("BDT yapan terapist");
  const block = buildMatchBlock(therapistNoApproach, req);
  assert.match(block, /— Yaklaşım.*BDT/);
});

test("buildMatchBlock shows ✗ when approach requested but not in approaches[]", () => {
  const req = extractUserRequest("EMDR yapan terapist");
  const block = buildMatchBlock(fakeTherapist, req);
  assert.match(block, /✗ Yaklaşım: EMDR/);
});

test("buildMatchBlock returns empty string when user asked nothing checkable", () => {
  const req = extractUserRequest("merhaba");
  const block = buildMatchBlock(fakeTherapist, req);
  assert.equal(block, "");
});

test("buildMatchBlock ✗ bütçe when therapist fee exceeds user cap", () => {
  const req = extractUserRequest("bütçem 3000");
  const block = buildMatchBlock(fakeTherapist, req);
  assert.match(block, /✗ Bütçe: 6\.000 TL.*talebin: 3\.000 TL altı/);
});

// ─── NODE-1 — meta-hallucination phrase detector ─────────────────────────────

test("detectMetaHallucination catches 'approaches[] listesini kontrol ettim'", () => {
  const text =
    "BDT olanları seçerken, Planda veritabanındaki terapistlerin terapötik " +
    "yaklaşımlarını gösteren 'approaches[]' listesini kontrol ettim.";
  assert.equal(detectMetaHallucination(text), true);
});

test("detectMetaHallucination catches 'Planda veritabanında kontrol'", () => {
  const text = "Planda veritabanında kontrol ettim ve uygun terapistleri buldum.";
  assert.equal(detectMetaHallucination(text), true);
});

test("detectMetaHallucination does NOT fire on normal therapist recommendation", () => {
  const text =
    "Anlattıklarına göre İstanbul'da yüz yüze görüşme yapabileceğin " +
    "iki isim buldum. Ekin Alankuş Gestalt yaklaşımıyla çalışıyor.";
  assert.equal(detectMetaHallucination(text), false);
});

test("detectMetaHallucination does NOT fire on fallback messages", () => {
  const text =
    "Önceki önerinin tam dayanağını şu an yeniden doğrulamam gerekiyor.";
  assert.equal(detectMetaHallucination(text), false);
});

// ─── Uzmanlık / Görüşme server-side override (Fix 1 + 2) ──────────────────────

test("buildSpecialtyLine uses specialties[] only — NOT service names", () => {
  const t: Therapist = {
    id: 99,
    name: "Test",
    full_name: "Test T",
    username: "test_t",
    specialties: [
      { id: 1, name: "İlişkisel Problemler" },
      { id: 2, name: "Depresyon" },
    ],
    services: [
      // These should NEVER appear in the specialty line
      { id: 10, name: "Çift ve Evlilik Terapisi", fee: "5000" },
      { id: 11, name: "Aile Danışmanlığı", fee: "3000" },
    ],
  };
  const line = buildSpecialtyLine(t, []);
  assert.match(line, /^Uzmanlık:/);
  assert.match(line, /İlişkisel Problemler/);
  assert.match(line, /Depresyon/);
  // services[] names must NOT leak into specialty line
  assert.doesNotMatch(line, /Çift ve Evlilik Terapisi/);
  assert.doesNotMatch(line, /Aile Danışmanlığı/);
});

test("buildSpecialtyLine surfaces user-matched topic first", () => {
  const t: Therapist = {
    id: 1, name: "T",
    specialties: [
      { id: 1, name: "Depresyon" },
      { id: 2, name: "İlişkisel Problemler" },
      { id: 3, name: "Kaygı(Anksiyete) ve Korku" },
    ],
  };
  const line = buildSpecialtyLine(t, ["iliski"]);
  // İlişkisel Problemler must appear before the others
  const idxRel = line.indexOf("İlişkisel Problemler");
  const idxDep = line.indexOf("Depresyon");
  assert.ok(idxRel < idxDep, "user-matched topic should be listed first");
});

test("buildSpecialtyLine returns empty when no specialties", () => {
  const t: Therapist = { id: 1, name: "T", specialties: [] };
  assert.equal(buildSpecialtyLine(t, []), "");
});

test("buildLocationLine uses branches[] only, never address string", () => {
  const t: Therapist = {
    id: 1, name: "T",
    branches: [
      {
        id: 10,
        type: "physical",
        name: "Psikoterapistanbul Danışmanlık Merkezi",
        city: { id: 1, name: "İstanbul" },
        // Dirty address with two districts glued together — this is the
        // Melisa Yılmaz Erdoğan case that used to produce "Beşiktaş, Şişli"
        address: "Dikilitaş Mahallesi Hakkı Yeten Caddesi Selenium Plaza No:10/C 6.kat Daire No:613 Beşiktaş Şişli",
      },
      { id: 11, type: "online", name: "Online" },
    ],
  };
  const line = buildLocationLine(t);
  // Should include both Online and the branch name
  assert.match(line, /Online/);
  assert.match(line, /Psikoterapistanbul Danışmanlık Merkezi/);
  // Must NOT leak the address hallucination
  assert.doesNotMatch(line, /Beşiktaş, Şişli/);
  assert.doesNotMatch(line, /Şişli/);
});

test("buildLocationLine renders multi-branch therapist correctly", () => {
  const t: Therapist = {
    id: 1, name: "T",
    branches: [
      { id: 10, type: "physical", name: "Nişantaşı", city: { id: 1, name: "İstanbul" } },
      { id: 11, type: "physical", name: "Göztepe", city: { id: 1, name: "İstanbul" } },
      { id: 12, type: "online", name: "Online" },
    ],
  };
  const line = buildLocationLine(t);
  assert.match(line, /Online/);
  assert.match(line, /Nişantaşı/);
  assert.match(line, /Göztepe/);
});

test("buildLocationLine online-only therapist", () => {
  const t: Therapist = {
    id: 1, name: "T",
    branches: [{ id: 10, type: "online", name: "Online" }],
  };
  const line = buildLocationLine(t);
  assert.equal(line, "Görüşme: Online");
});

// ─── Fix 1 — District normalization ──────────────────────────────────────────

test("resolveLocation: 'Göztepe' → city=İstanbul, district=goztepe", () => {
  const r = resolveLocation("Göztepe");
  assert.equal(r.city, "İstanbul");
  assert.equal(r.district, "goztepe");
});

test("resolveLocation: 'Kartal' → city=İstanbul, district=kartal", () => {
  const r = resolveLocation("Kartal");
  assert.equal(r.city, "İstanbul");
  assert.equal(r.district, "kartal");
});

test("resolveLocation: 'İstanbul' → passes through as city", () => {
  const r = resolveLocation("İstanbul");
  assert.equal(r.city, "İstanbul");
  assert.equal(r.district, null);
});

test("resolveLocation: unknown city passes through", () => {
  const r = resolveLocation("Mersin");
  assert.equal(r.city, "Mersin");
  assert.equal(r.district, null);
});

test("therapistInDistrict matches via branch.name", () => {
  const t: Therapist = {
    id: 1, name: "T",
    branches: [{ id: 10, type: "physical", name: "Göztepe" }],
  };
  assert.equal(therapistInDistrict(t, "goztepe"), true);
  assert.equal(therapistInDistrict(t, "nisantasi"), false);
});

test("therapistInDistrict matches via branch.address", () => {
  const t: Therapist = {
    id: 1, name: "T",
    branches: [{
      id: 10, type: "physical", name: "Merkez",
      address: "Bağdat Caddesi No:258, Göztepe/Kadıköy"
    }],
  };
  assert.equal(therapistInDistrict(t, "goztepe"), true);
  assert.equal(therapistInDistrict(t, "kadikoy"), true);
});

test("istanbulSide: Beşiktaş=avrupa, Göztepe=anadolu", () => {
  assert.equal(istanbulSide("Beşiktaş"), "avrupa");
  assert.equal(istanbulSide("besiktas"), "avrupa");
  assert.equal(istanbulSide("Göztepe"), "anadolu");
  assert.equal(istanbulSide("Kadıköy"), "anadolu");
  assert.equal(istanbulSide("İstanbul"), null);
});

test("matchesIstanbulSide: Göztepe-only therapist vs Avrupa request", () => {
  const t: Therapist = {
    id: 1, name: "T",
    branches: [{ id: 10, type: "physical", name: "Göztepe" }],
  };
  assert.equal(matchesIstanbulSide(t, "anadolu"), true);
  assert.equal(matchesIstanbulSide(t, "avrupa"), false);
});

test("matchesIstanbulSide: therapist with both sides matches either", () => {
  const t: Therapist = {
    id: 1, name: "T",
    branches: [
      { id: 10, type: "physical", name: "Nişantaşı" },
      { id: 11, type: "physical", name: "Göztepe" },
    ],
  };
  assert.equal(matchesIstanbulSide(t, "avrupa"), true);
  assert.equal(matchesIstanbulSide(t, "anadolu"), true);
});

// ─── Fix 3 — stripPermissionTail ─────────────────────────────────────────────

test("stripPermissionTail removes trailing 'Nasıl istersin?' after card", () => {
  const input =
    "Anlattıklarına göre 2 isim buldum:\n\n" +
    "**Ekin Alankuş** — Uzman Psikolog\n" +
    "[[expert:ekin_alankus]]\n\n" +
    "Nasıl istersin?";
  const out = stripPermissionTail(input);
  assert.doesNotMatch(out, /Nasıl istersin\?/);
  assert.match(out, /Ekin Alankuş/);
});

test("stripPermissionTail removes 'Ayrıca önermemi ister misin?'", () => {
  const input =
    "**Ekin Alankuş** — Uzman Psikolog\n[[expert:ekin_alankus]]\n\n" +
    "Ayrıca online seçenekleri de önermemi ister misin?";
  const out = stripPermissionTail(input);
  assert.doesNotMatch(out, /ister misin/i);
});

test("stripPermissionTail leaves greeting question intact (no card)", () => {
  const input = "Merhaba, sana nasıl yardımcı olayım?";
  const out = stripPermissionTail(input);
  assert.equal(out, input);
});

test("stripPermissionTail keeps mid-sentence 'istersen' untouched", () => {
  const input =
    "**Ekin Alankuş** — Uzman Psikolog\n[[expert:ekin_alankus]]\n\n" +
    "İstersen farklı bir ilçeye bakabilirim.";
  const out = stripPermissionTail(input);
  // "İstersen" at start without "ister misin" tail is preserved
  assert.match(out, /İstersen/);
});
