/**
 * Unit tests for therapistFilters — server-side filter helpers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchesOnline,
  matchesPhysical,
  matchesMaxFee,
  matchesGender,
  filterByFuzzyName,
  filterBySpecialtyName,
  buildSpecialtyMap,
  applyAiSideFilters,
} from "../src/services/therapistFilters.js";
import type { Therapist } from "../src/types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ayse: Therapist = {
  id: 1,
  name: "Ayşe",
  surname: "Demir",
  full_name: "Ayşe Demir",
  username: "ayse-demir",
  gender: "female",
  branches: [
    { id: 10, type: "physical", name: "Nişantaşı", city: { id: 1, name: "İstanbul" } },
    { id: 11, type: "online", name: "Online" },
  ],
  services: [
    { id: 63, name: "Bireysel Terapi", fee: "1500.00" },
    { id: 64, name: "Çift Terapisi", fee: "2500.00" },
  ],
  specialties: [
    { id: 26, name: "Kaygı(Anksiyete) ve Korku" },
    { id: 23, name: "İlişkisel Problemler" },
  ],
};

const mehmet: Therapist = {
  id: 2,
  name: "Mehmet",
  surname: "Kaya",
  full_name: "Mehmet Kaya",
  username: "mehmet-kaya",
  gender: "male",
  branches: [
    { id: 20, type: "physical", name: "Çankaya", city: { id: 6, name: "Ankara" } },
  ],
  services: [{ id: 63, name: "Bireysel Terapi", custom_fee: "3000.00" }],
  specialties: [
    { id: 18, name: "Depresyon" },
    { id: 22, name: "İletişim problemleri" },
  ],
};

const ekin: Therapist = {
  id: 3,
  name: "Ekin",
  surname: "Alankuş",
  full_name: "Ekin Alankuş",
  username: "ekin-alankus",
  gender: "female",
  branches: [
    { id: 30, type: "online", name: "Online" },
  ],
  services: [{ id: 63, name: "Bireysel Terapi", fee: "800.00" }],
  specialties: [
    { id: 35, name: "Travmatik Deneyim" },
    { id: 26, name: "Kaygı(Anksiyete) ve Korku" },
  ],
};

const noBranches: Therapist = {
  id: 4,
  name: "Test",
  full_name: "Test Kişi",
  branches: [],
  services: [],
};

const LIST = [ayse, mehmet, ekin, noBranches];

// ─── matchesOnline / matchesPhysical ─────────────────────────────────────────

test("matchesOnline true for therapist with online branch", () => {
  assert.equal(matchesOnline(ayse), true);
  assert.equal(matchesOnline(ekin), true);
});

test("matchesOnline false when no online branch", () => {
  assert.equal(matchesOnline(mehmet), false);
  assert.equal(matchesOnline(noBranches), false);
});

test("matchesPhysical true without city filter", () => {
  assert.equal(matchesPhysical(ayse), true);
  assert.equal(matchesPhysical(mehmet), true);
  assert.equal(matchesPhysical(ekin), false);
});

test("matchesPhysical respects city filter (Turkish-aware)", () => {
  assert.equal(matchesPhysical(ayse, "İstanbul"), true);
  assert.equal(matchesPhysical(ayse, "istanbul"), true);
  assert.equal(matchesPhysical(ayse, "Ankara"), false);
  assert.equal(matchesPhysical(mehmet, "Ankara"), true);
});

// ─── matchesMaxFee ───────────────────────────────────────────────────────────

test("matchesMaxFee uses cheapest service", () => {
  // Ayşe cheapest is 1500
  assert.equal(matchesMaxFee(ayse, 2000), true);
  assert.equal(matchesMaxFee(ayse, 1500), true);
  assert.equal(matchesMaxFee(ayse, 1499), false);
});

test("matchesMaxFee reads custom_fee when set", () => {
  // Mehmet's custom_fee is 3000
  assert.equal(matchesMaxFee(mehmet, 3000), true);
  assert.equal(matchesMaxFee(mehmet, 2999), false);
});

test("matchesMaxFee false when no services", () => {
  assert.equal(matchesMaxFee(noBranches, 10000), false);
});

// ─── matchesGender ───────────────────────────────────────────────────────────

test("matchesGender top-level field", () => {
  assert.equal(matchesGender(ayse, "female"), true);
  assert.equal(matchesGender(mehmet, "male"), true);
  assert.equal(matchesGender(ayse, "male"), false);
});

// ─── filterByFuzzyName ───────────────────────────────────────────────────────

test("filterByFuzzyName exact full name", () => {
  const result = filterByFuzzyName(LIST, "Ekin Alankuş");
  assert.equal(result.length, 1);
  assert.equal(result[0].username, "ekin-alankus");
});

test("filterByFuzzyName Turkish-character tolerant", () => {
  // "Alankus" without ş should still match "Alankuş"
  const result = filterByFuzzyName(LIST, "alankus");
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 3);
});

test("filterByFuzzyName lowercase input", () => {
  const result = filterByFuzzyName(LIST, "ayse demir");
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 1);
});

test("filterByFuzzyName partial matches all words", () => {
  // "ekin" alone matches only Ekin
  const result = filterByFuzzyName(LIST, "ekin");
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 3);
});

test("filterByFuzzyName empty query → returns list unchanged", () => {
  assert.equal(filterByFuzzyName(LIST, "").length, LIST.length);
});

test("filterByFuzzyName single letter ignored", () => {
  // Words shorter than 2 chars skipped
  assert.equal(filterByFuzzyName(LIST, "a").length, LIST.length);
});

test("filterByFuzzyName no match returns empty", () => {
  assert.equal(filterByFuzzyName(LIST, "zzzz xxxx").length, 0);
});

test("filterByFuzzyName matches via username", () => {
  const result = filterByFuzzyName(LIST, "mehmet-kaya");
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 2);
});

// ─── applyAiSideFilters composition ──────────────────────────────────────────

test("applyAiSideFilters: online only", () => {
  const result = applyAiSideFilters(LIST, { online: true });
  const ids = result.map((t) => t.id).sort();
  assert.deepEqual(ids, [1, 3]); // Ayşe + Ekin have online branches
});

test("applyAiSideFilters: online=false keeps only physical", () => {
  const result = applyAiSideFilters(LIST, { online: false });
  const ids = result.map((t) => t.id).sort();
  assert.deepEqual(ids, [1, 2]); // Ayşe + Mehmet have physical
});

test("applyAiSideFilters: gender + city (via online:false)", () => {
  const result = applyAiSideFilters(LIST, {
    online: false,
    gender: "female",
    city: "İstanbul",
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 1); // Only Ayşe — female, physical in İstanbul
});

test("applyAiSideFilters: max_fee budget", () => {
  const result = applyAiSideFilters(LIST, { max_fee: 1000 });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 3); // Only Ekin (800 TL)
});

test("applyAiSideFilters: name narrows first, then online", () => {
  // Target: an "alankus"-matching therapist AND online-capable → Ekin
  const result = applyAiSideFilters(LIST, { name: "alankus", online: true });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 3);
});

test("applyAiSideFilters: empty filters pass-through", () => {
  const result = applyAiSideFilters(LIST, {});
  assert.equal(result.length, LIST.length);
});

// ─── filterBySpecialtyName (Turkish-aware, derived from therapist.specialties[]) ─

test("filterBySpecialtyName: 'anksiyete' matches 'Kaygı(Anksiyete) ve Korku'", () => {
  const result = filterBySpecialtyName(LIST, "anksiyete");
  const ids = result.map((t) => t.id).sort();
  assert.deepEqual(ids, [1, 3]); // ayse + ekin
});

test("filterBySpecialtyName: 'kaygı' also matches via Turkish normalisation", () => {
  const result = filterBySpecialtyName(LIST, "kaygı");
  const ids = result.map((t) => t.id).sort();
  assert.deepEqual(ids, [1, 3]);
});

test("filterBySpecialtyName: 'kaygi' (no diacritic) still matches", () => {
  const result = filterBySpecialtyName(LIST, "kaygi");
  assert.equal(result.length, 2);
});

test("filterBySpecialtyName: 'travma' matches 'Travmatik Deneyim'", () => {
  const result = filterBySpecialtyName(LIST, "travma");
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 3);
});

test("filterBySpecialtyName: 'depresyon' matches only Mehmet", () => {
  const result = filterBySpecialtyName(LIST, "depresyon");
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 2);
});

test("filterBySpecialtyName: unknown specialty returns empty", () => {
  const result = filterBySpecialtyName(LIST, "hipnoterapi");
  assert.equal(result.length, 0);
});

test("filterBySpecialtyName: too-short query returns list unchanged", () => {
  const result = filterBySpecialtyName(LIST, "ka"); // < 3 chars
  assert.equal(result.length, LIST.length);
});

test("buildSpecialtyMap: extracts all unique id+name pairs", () => {
  const map = buildSpecialtyMap(LIST);
  // Kaygı(26), İlişkisel(23), Depresyon(18), İletişim(22), Travmatik(35) → 5 unique
  assert.equal(map.size, 5);
  // Keys are normalized
  assert.equal(map.get("kaygi anksiyete ve korku"), 26);
  assert.equal(map.get("depresyon"), 18);
  assert.equal(map.get("travmatik deneyim"), 35);
});

test("applyAiSideFilters: specialty_name + online composes correctly", () => {
  // Target: someone with anksiyete specialty AND online-capable
  // Both Ayşe (1) and Ekin (3) have anksiyete, but only they differ on branches
  // Ayşe has both online+physical, Ekin only online — both pass
  const result = applyAiSideFilters(LIST, {
    specialty_name: "anksiyete",
    online: true,
  });
  const ids = result.map((t) => t.id).sort();
  assert.deepEqual(ids, [1, 3]);
});

test("applyAiSideFilters: specialty_name + gender + city narrows correctly", () => {
  // İstanbul + female + kaygı → only Ayşe (1)
  const result = applyAiSideFilters(LIST, {
    specialty_name: "kaygı",
    gender: "female",
    online: false,
    city: "İstanbul",
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 1);
});
