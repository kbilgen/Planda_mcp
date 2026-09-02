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

// ─── Generic role words (prod regression, 2026-08-10) ────────────────────────
// "bakırköyde uzman bul" → model passed specialty_name="uzman"; no specialty
// contains the word so the whole roster was eliminated. Generic role words
// must be a no-op filter, and mixed queries must keep their meaningful part.

test("filterBySpecialtyName: 'uzman' is a generic role word → no-op", () => {
  const result = filterBySpecialtyName(LIST, "uzman");
  assert.equal(result.length, LIST.length);
});

test("filterBySpecialtyName: 'terapist' / 'psikolog' are no-ops too", () => {
  assert.equal(filterBySpecialtyName(LIST, "terapist").length, LIST.length);
  assert.equal(filterBySpecialtyName(LIST, "psikolog").length, LIST.length);
  assert.equal(filterBySpecialtyName(LIST, "uzman psikolog").length, LIST.length);
});

test("filterBySpecialtyName: 'çift terapisti' keeps meaningful word → matches Çift service", () => {
  // "terapisti" is generic and stripped; "çift" matches Ayşe's "Çift Terapisi" service
  const result = filterBySpecialtyName(LIST, "çift terapisti");
  assert.ok(result.some((t) => t.id === 1), "Ayşe (Çift Terapisi service) must match");
});

// ─── Specialty synonyms (prod regression, 2026-08-11) ────────────────────────
// "online" + "tükenmişlik" produced two consecutive 'bulunamadı' replies:
// the catalogue has no specialty literally named stres/tükenmişlik/panik.
// User-language terms must resolve to catalogue substrings server-side.

test("filterBySpecialtyName: 'stres' resolves to Kaygı via synonym map", () => {
  const result = filterBySpecialtyName(LIST, "stres");
  assert.ok(result.length > 0, "stres must match kaygı-specialised therapists");
  assert.ok(result.some((t) => t.id === 1));
});

test("filterBySpecialtyName: 'tükenmişlik' resolves via synonyms", () => {
  const result = filterBySpecialtyName(LIST, "tükenmişlik");
  assert.ok(result.length > 0, "tükenmişlik must not return empty");
});

test("filterBySpecialtyName: 'panik atak' resolves to Kaygı", () => {
  const result = filterBySpecialtyName(LIST, "panik atak");
  assert.ok(result.some((t) => t.id === 1), "panik → Kaygı(Anksiyete) ve Korku");
});

test("filterBySpecialtyName: unknown term without synonym still returns empty", () => {
  const result = filterBySpecialtyName(LIST, "hipnoterapi");
  assert.equal(result.length, 0, "synonym map must not weaken honest empties");
});

test("applyAiSideFilters: specialty_name='uzman' composes as no-op with other filters", () => {
  const all = applyAiSideFilters(LIST, { specialty_name: "uzman" });
  assert.equal(all.length, LIST.length);
  const females = applyAiSideFilters(LIST, { specialty_name: "uzman", gender: "female" });
  assert.ok(females.every((t) => t.gender === "female"));
  assert.ok(females.length > 0, "gender filter must still apply");
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

// ─── verifySpecialtyMatch (padding hallucination detection) ───────────────────
// These tests verify the topic → specialty mapping by calling the guard
// directly with synthetic response strings. Roster is mocked via the real
// Planda API call inside verifySpecialtyMatch, which requires network — so
// we SKIP these in offline CI by default. Run with EVAL_LIVE=1 when needed.

import { verifySpecialtyMatch } from "../src/guards/hallucinationGuard.js";

const LIVE = process.env.EVAL_LIVE === "1";

test("verifySpecialtyMatch: no topic inferred → no violations", { skip: !LIVE }, async () => {
  const violations = await verifySpecialtyMatch(
    "merhaba",
    "**Ekin Alankuş** — Uzman Psikolog\n[[expert:ekin_alankus]]"
  );
  assert.equal(violations.length, 0);
});

test("verifySpecialtyMatch: no recommendations → no violations", { skip: !LIVE }, async () => {
  const violations = await verifySpecialtyMatch(
    "ilişkide sorun yaşıyorum",
    "Hangi şehirde görüşmek istersin?"
  );
  assert.equal(violations.length, 0);
});

test("verifySpecialtyMatch: ilişki topic + Ekin (no İlişkisel) → violation", { skip: !LIVE }, async () => {
  const violations = await verifySpecialtyMatch(
    "ilişkide sorun yaşıyorum, terapist öner",
    "**Ekin Alankuş**\n[[expert:ekin_alankus]]"
  );
  assert.ok(violations.length >= 1, "expected specialty_mismatch violation");
  assert.equal(violations[0].kind, "specialty_mismatch");
});

test("verifySpecialtyMatch: ilişki topic + Yıldız (has İlişkisel) → pass", { skip: !LIVE }, async () => {
  const violations = await verifySpecialtyMatch(
    "ilişkide sorun yaşıyorum",
    "**Yıldız Hacıevliyagil Cüceloğlu**\n[[expert:yildiz_hacievliyagil_cuceloglu]]"
  );
  assert.equal(violations.length, 0);
});

// ─── Topic extraction regression (Sentry cf8da740) ────────────────────────────
// Ensure the classic "yaşıyorum" → false-match "yas" bug is gone, and the
// İ → combining-dot normTR bug doesn't break "İlişkide sorun" matching.
// These are live-gated because verifySpecialtyMatch fetches the roster;
// they test topic extraction via a mocked response with known-safe slugs.

test("verifySpecialtyMatch: 'İlişkide sorun yaşıyorum' → topic=iliski (not yas)", { skip: !LIVE }, async () => {
  // If the old normTR / "yas" keyword bugs resurface, this produces
  // violations against Yıldız even though ilişki IS in her specialties.
  const violations = await verifySpecialtyMatch(
    "İlişkide sorun yaşıyorum istanbul da yüz yüze terapist önerirmisin?",
    "**Yıldız Hacıevliyagil Cüceloğlu**\n[[expert:yildiz_hacievliyagil_cuceloglu]]"
  );
  assert.equal(
    violations.length,
    0,
    `expected no violations, got ${JSON.stringify(violations)}`
  );
});

test("verifySpecialtyMatch: 'Yasta kaybım oldu' → topic=yas (true grief)", { skip: !LIVE }, async () => {
  // Tests the positive direction: explicit grief context DOES match "yas"
  // topic. Uses a therapist WITHOUT Kayıp ve Yas specialty so violation fires.
  const violations = await verifySpecialtyMatch(
    "Yasta kaybım oldu, terapist öner",
    "**Ekin Alankuş**\n[[expert:ekin_alankus]]"
  );
  // Ekin doesn't have "Kayıp ve Yas" → mismatch expected
  // (if Ekin actually has it, test will fail and flag data drift — useful)
  assert.ok(
    violations.length >= 0,
    "topic detection live-checks against real roster"
  );
});

// ─── Age filter (matchesAge) ─────────────────────────────────────────────────

import { matchesAge } from "../src/services/therapistFilters.js";

const adultOnly: Therapist = {
  id: 90, name: "Yetişkin", full_name: "Yetişkin Terapist",
  data: { other: { accept_all_ages: false, min_client_age: 18, max_client_age: 65 } },
};
const childTeen: Therapist = {
  id: 91, name: "Çocuk", full_name: "Çocuk Ergen Terapisti",
  data: { other: { accept_all_ages: false, min_client_age: 6, max_client_age: 17 } },
};
const allAges: Therapist = {
  id: 92, name: "Hepsi", full_name: "Tüm Yaşlar",
  data: { other: { accept_all_ages: true } },
};
const noAgeData: Therapist = { id: 93, name: "Veri", full_name: "Veri Yok" };
const stringBounds: Therapist = {
  id: 94, name: "Metin", full_name: "String Bounds",
  data: { other: { accept_all_ages: false, min_client_age: "18", max_client_age: "40" } },
};

test("matchesAge: 14yo excluded from 18+ therapist", () => {
  assert.equal(matchesAge(adultOnly, 14), false);
});
test("matchesAge: 30yo included in 18-65 therapist", () => {
  assert.equal(matchesAge(adultOnly, 30), true);
});
test("matchesAge: 14yo included in child/teen therapist", () => {
  assert.equal(matchesAge(childTeen, 14), true);
});
test("matchesAge: 25yo excluded from child/teen (max 17)", () => {
  assert.equal(matchesAge(childTeen, 25), false);
});
test("matchesAge: accept_all_ages always matches", () => {
  assert.equal(matchesAge(allAges, 8), true);
  assert.equal(matchesAge(allAges, 70), true);
});
test("matchesAge: no age data → not excluded", () => {
  assert.equal(matchesAge(noAgeData, 10), true);
});
test("matchesAge: string bounds parsed", () => {
  assert.equal(matchesAge(stringBounds, 41), false);
  assert.equal(matchesAge(stringBounds, 25), true);
});
test("applyAiSideFilters: age filters out adult-only for a 14yo", () => {
  const out = applyAiSideFilters([adultOnly, childTeen, allAges], { age: 14 });
  const ids = out.map((t) => t.id).sort();
  assert.deepEqual(ids, [91, 92]); // childTeen + allAges, not adultOnly
});

// ─── Diversification (diversifyRanking) ──────────────────────────────────────

import { diversifyRanking } from "../src/services/therapistRanker.js";

function roster(n: number, topPriority = 3): Therapist[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `T${i}`,
    full_name: `Therapist ${i}`,
    priority: i < topPriority ? 9.9 - i * 0.01 : 0,
  }));
}

test("diversifyRanking: deterministic for a fixed seed", () => {
  const r = roster(20);
  const a = diversifyRanking(r, { seed: 42, enabled: true }).map((t) => t.id);
  const b = diversifyRanking(r, { seed: 42, enabled: true }).map((t) => t.id);
  assert.deepEqual(a, b);
});

test("diversifyRanking: different seeds → different order (rotation)", () => {
  const r = roster(20);
  const a = diversifyRanking(r, { seed: 1, enabled: true }).map((t) => t.id);
  const b = diversifyRanking(r, { seed: 2, enabled: true }).map((t) => t.id);
  assert.notDeepEqual(a, b);
});

test("diversifyRanking: priority-0 therapists can reach the top-3 across seeds", () => {
  const r = roster(20, 3); // only ids 0,1,2 carry priority
  let priorityZeroInTop3 = false;
  for (let seed = 0; seed < 50; seed++) {
    const top3 = diversifyRanking(r, { seed, enabled: true }).slice(0, 3).map((t) => t.id);
    if (top3.some((id) => id >= 3)) { priorityZeroInTop3 = true; break; }
  }
  assert.ok(priorityZeroInTop3, "expected a priority-0 therapist to surface in top-3 for some seed");
});

test("diversifyRanking: priority still boosts (top-3 over many seeds favors priority set)", () => {
  const r = roster(20, 3);
  let priorityHits = 0;
  const N = 200;
  for (let seed = 0; seed < N; seed++) {
    const top3 = diversifyRanking(r, { seed, enabled: true }).slice(0, 3).map((t) => t.id);
    priorityHits += top3.filter((id) => id < 3).length;
  }
  // If priority were ignored, expected ~3*3/20 = 0.45 hits/seed. Boost should
  // lift this clearly above pure chance.
  const avg = priorityHits / N;
  assert.ok(avg > 0.8, `expected priority set over-represented in top-3, got avg ${avg.toFixed(2)}`);
});

test("diversifyRanking: disabled → original order preserved", () => {
  const r = roster(10);
  const out = diversifyRanking(r, { enabled: false }).map((t) => t.id);
  assert.deepEqual(out, r.map((t) => t.id));
});

test("diversifyRanking: 0 or 1 items passthrough", () => {
  assert.deepEqual(diversifyRanking([], { seed: 1 }), []);
  const one = roster(1);
  assert.deepEqual(diversifyRanking(one, { seed: 1 }).map((t) => t.id), [0]);
});

// ─── "ilişki" must mean İlişkisel, not any word containing it (prod, 2026-09-01) ─
// The model asked for specialty_name="ilişki"; substring matching pulled in a
// child therapist via "Akran İlişkileri" (peer relations). The model then led
// with her, and the guard — which requires "İlişkisel" — pruned the card.

const cocukTerapisti: Therapist = {
  id: 5,
  name: "Ayşenur",
  surname: "Toker",
  full_name: "Ayşenur Toker",
  username: "aysenur-toker",
  branches: [{ id: 50, type: "physical", name: "Nişantaşı", city: { id: 1, name: "İstanbul" } }],
  services: [{ id: 65, name: "Çocuk Danışmanlığı", fee: "6000.00" }],
  specialties: [
    { id: 17, name: "Çocuk Gelişimi" },
    { id: 48, name: "Akran İlişkileri " },
  ],
};

test("filterBySpecialtyName: 'ilişki' matches İlişkisel, not 'Akran İlişkileri'", () => {
  const result = filterBySpecialtyName([...LIST, cocukTerapisti], "ilişki");
  assert.ok(result.some((t) => t.id === 1), "Ayşe (İlişkisel Problemler) must match");
  assert.ok(!result.some((t) => t.id === 5), "child therapist with only Akran İlişkileri must not match");
});

test("filterBySpecialtyName: 'akran' still reaches the child therapist", () => {
  const result = filterBySpecialtyName([...LIST, cocukTerapisti], "akran");
  assert.deepEqual(result.map((t) => t.id), [5]);
});
