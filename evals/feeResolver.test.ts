/**
 * Unit tests for resolveEffectiveFees — collapses the API's dual
 * fee / custom_fee pair into the single fee the model may quote.
 *
 * Regression: Planda API returns fee:"3000.00" (service default) and
 * custom_fee:"6000.00" (therapist's real price). The markdown text already
 * rendered 6000, but structuredContent leaked the raw pair and the model
 * quoted 3000 TL for Ekin Alankuş. After resolution only one number exists.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEffectiveFees } from "../src/services/feeResolver.js";
import type { Therapist } from "../src/types.js";

const ekin: Therapist = {
  id: 370,
  full_name: "Ekin Alankuş",
  username: "ekin_alankus",
  services: [
    { id: 63, name: "Bireysel Danışmanlık", fee: "3000.00", custom_fee: "6000.00" },
    { id: 66, name: "Ergen Danışmanlığı", fee: "3000.00", custom_fee: "6000.00" },
  ],
};

test("custom_fee wins over fee and custom_fee key is removed", () => {
  const [t] = resolveEffectiveFees([ekin]);
  assert.deepEqual(
    t.services!.map((s) => s.fee),
    ["6000.00", "6000.00"]
  );
  for (const s of t.services!) {
    assert.equal("custom_fee" in s, false, "raw custom_fee must not leak");
  }
});

test("falls back to fee when custom_fee is null/absent", () => {
  const t: Therapist = {
    id: 1,
    services: [
      { id: 1, name: "A", fee: "2500.00", custom_fee: null },
      { id: 2, name: "B", fee: "1800.00" },
    ],
  };
  const [out] = resolveEffectiveFees([t]);
  assert.deepEqual(out.services!.map((s) => s.fee), ["2500.00", "1800.00"]);
});

test("does not mutate input and tolerates missing services", () => {
  const before = JSON.stringify(ekin);
  const [noServices] = resolveEffectiveFees([{ id: 2 }]);
  resolveEffectiveFees([ekin]);
  assert.equal(JSON.stringify(ekin), before);
  assert.equal(noServices.services, undefined);
});
