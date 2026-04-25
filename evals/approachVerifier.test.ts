/**
 * Unit tests for the server-side approach verifier.
 * Tests the pure helpers (substring resolution + match logic) — the
 * network-fetching path is exercised end-to-end via the eval harness.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../src/services/approachVerifier.js";
import type { Approach } from "../src/types.js";

const { approachSubstrings, approachMatches, normTR } = __test__;

// ─── normTR + approachSubstrings ─────────────────────────────────────────────

test("approachSubstrings: 'BDT' resolves to bilissel davranisci variants", () => {
  const subs = approachSubstrings("BDT");
  assert.ok(subs.includes("bilissel davranisci"));
  assert.ok(subs.includes("bdt"));
});

test("approachSubstrings: 'CBT' English form also resolves", () => {
  const subs = approachSubstrings("CBT");
  assert.ok(subs.includes("bilissel davranisci"));
});

test("approachSubstrings: 'EMDR' isolated", () => {
  assert.deepEqual(approachSubstrings("EMDR"), ["emdr"]);
});

test("approachSubstrings: 'Şema' matches Schema therapy", () => {
  const subs = approachSubstrings("Şema");
  assert.ok(subs.some((s) => s.includes("sema") || s.includes("schema")));
});

test("approachSubstrings: unknown approach falls back to literal", () => {
  const subs = approachSubstrings("Holotropic Breathing");
  assert.ok(subs.length === 1);
  assert.equal(subs[0], "holotropic breathing");
});

// ─── approachMatches ─────────────────────────────────────────────────────────

const bdtTherapist: Approach[] = [
  { id: 1, name: "Bilişsel Davranışçı Terapi (BDT)" },
  { id: 2, name: "Şema Terapi" },
];
const emdrTherapist: Approach[] = [
  { id: 3, name: "EMDR" },
  { id: 4, name: "Sistemik Terapi" },
];
const psikodinamikTherapist: Approach[] = [
  { id: 5, name: "Psikodinamik Psikoterapi" },
];

test("approachMatches: BDT therapist matches 'BDT' query", () => {
  assert.equal(approachMatches(bdtTherapist, "BDT"), true);
});

test("approachMatches: BDT therapist matches 'CBT' query (English alias)", () => {
  assert.equal(approachMatches(bdtTherapist, "CBT"), true);
});

test("approachMatches: BDT therapist DOES NOT match 'EMDR'", () => {
  assert.equal(approachMatches(bdtTherapist, "EMDR"), false);
});

test("approachMatches: psikodinamik therapist matches 'Psikanaliz' query", () => {
  // Psikanaliz rule covers psikodinamik substring
  assert.equal(approachMatches(psikodinamikTherapist, "Psikanaliz"), true);
});

test("approachMatches: empty approaches[] never matches anything", () => {
  assert.equal(approachMatches([], "BDT"), false);
});

test("approachMatches: unknown approach query falls back to literal substring", () => {
  const t: Approach[] = [{ id: 1, name: "Holotropic Breathing" }];
  assert.equal(approachMatches(t, "Holotropic"), true);
  assert.equal(approachMatches(t, "Yoga"), false);
});

test("normTR: 'Bilişsel Davranışçı Terapi (BDT)' → matches BDT key", () => {
  const n = normTR("Bilişsel Davranışçı Terapi (BDT)");
  assert.ok(n.includes("bilissel davranisci"));
  assert.ok(n.includes("bdt"));
});
