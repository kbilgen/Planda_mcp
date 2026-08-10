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
