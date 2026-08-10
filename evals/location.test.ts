/**
 * Unit tests for locationNormalizer — district resolution + semt aliases.
 *
 * Run:
 *   npm run test:unit
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveLocation,
  therapistInDistrict,
  istanbulSide,
  suggestNearbyDistricts,
  districtDisplayName,
} from "../src/services/locationNormalizer.js";
import type { Therapist } from "../src/types.js";

// Modeled on the real prod record that exposed the gap: branch labelled by
// semt ("Florya"), address mentioning "Şenlikköy Mah." — both in Bakırköy.
const floryaTherapist: Therapist = {
  id: 8283,
  full_name: "Gülşah Gürel",
  username: "gulsah_gurel",
  gender: "female",
  branches: [
    { id: 692, type: "online", name: "Online" },
    {
      id: 693,
      type: "physical",
      name: "Florya",
      address: "Şenlikköy Mah. Yeni Bağlar Sok. No.26/4 Cresta Apt. Florya",
      city: { id: 40, name: "İstanbul" },
    },
  ],
} as Therapist;

test("resolveLocation: 'Bakırköy' → İstanbul + bakirkoy district", () => {
  const r = resolveLocation("Bakırköy");
  assert.equal(r.city, "İstanbul");
  assert.equal(r.district, "bakirkoy");
});

test("resolveLocation: 'Florya' resolves as İstanbul district", () => {
  const r = resolveLocation("Florya");
  assert.equal(r.city, "İstanbul");
  assert.equal(r.district, "florya");
});

test("therapistInDistrict: Bakırköy query matches Florya branch via semt alias", () => {
  assert.equal(therapistInDistrict(floryaTherapist, "bakirkoy"), true);
});

test("therapistInDistrict: direct semt query still matches", () => {
  assert.equal(therapistInDistrict(floryaTherapist, "florya"), true);
});

test("therapistInDistrict: unrelated district does not match", () => {
  assert.equal(therapistInDistrict(floryaTherapist, "kadikoy"), false);
});

test("istanbulSide: florya is on the European side (same as bakirkoy)", () => {
  assert.equal(istanbulSide("florya"), "avrupa");
  assert.equal(istanbulSide("bakirkoy"), "avrupa");
});

// ─── Nearby-district suggestions (prod regression, 2026-08-10) ───────────────
// When Bakırköy had no in-district match, the model invented "nearby"
// districts from its own geography — recommending Kadıköy (opposite side of
// the Bosphorus). Suggestions must now come from the same-side adjacency map
// and only include districts where therapists actually exist.

const bahcelievlerTherapist: Therapist = {
  id: 2,
  full_name: "Test Bahçelievler",
  username: "test_bahcelievler",
  branches: [
    {
      id: 20,
      type: "physical",
      name: "Bahçelievler",
      address: "Bahçelievler Mah. Test Sok. No.1",
      city: { id: 40, name: "İstanbul" },
    },
  ],
} as Therapist;

const kadikoyTherapist: Therapist = {
  id: 3,
  full_name: "Test Kadıköy",
  username: "test_kadikoy",
  branches: [
    {
      id: 30,
      type: "physical",
      name: "Kadıköy",
      address: "Caferağa Mah. Moda Cad. No.2",
      city: { id: 40, name: "İstanbul" },
    },
  ],
} as Therapist;

test("suggestNearbyDistricts: bakirkoy suggests same-side Bahçelievler, never Kadıköy", () => {
  const suggestions = suggestNearbyDistricts(
    [bahcelievlerTherapist, kadikoyTherapist],
    "bakirkoy"
  );
  const districts = suggestions.map((s) => s.district);
  assert.ok(districts.includes("bahcelievler"), "Bahçelievler must be suggested");
  assert.ok(!districts.includes("kadikoy"), "Kadıköy is on the opposite side — never suggested");
});

test("suggestNearbyDistricts: only districts with actual therapists are returned", () => {
  const suggestions = suggestNearbyDistricts([kadikoyTherapist], "bakirkoy");
  assert.equal(suggestions.length, 0, "no same-side therapists → no suggestions");
});

test("suggestNearbyDistricts: counts and display names are populated", () => {
  const suggestions = suggestNearbyDistricts([bahcelievlerTherapist], "bakirkoy");
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].display_name, "Bahçelievler");
  assert.equal(suggestions[0].therapist_count, 1);
});

test("suggestNearbyDistricts: semt query (florya) suggests its parent-district ring", () => {
  const suggestions = suggestNearbyDistricts([bahcelievlerTherapist], "florya");
  assert.ok(suggestions.some((s) => s.district === "bahcelievler"));
});

test("districtDisplayName: normalized key → Turkish display form", () => {
  assert.equal(districtDisplayName("bakirkoy"), "Bakırköy");
  assert.equal(districtDisplayName("bahcelievler"), "Bahçelievler");
  assert.equal(districtDisplayName("Bilinmeyenİlçe"), "Bilinmeyenİlçe");
});
