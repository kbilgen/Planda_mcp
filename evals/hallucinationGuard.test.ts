/**
 * Unit tests for shouldUseFallback — the policy that decides whether to
 * replace a suspect agent response with the safe fallback.
 *
 * Run:
 *   npm run test:unit
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldUseFallback } from "../src/guards/hallucinationGuard.js";

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
