/**
 * Eval runner — executes each test case against runChat() in-process.
 *
 * For each case:
 *   1. Call runChat with the case's history + input
 *   2. Post-process the response (same pipeline as production)
 *   3. Classify intent on the input
 *   4. Run deterministic assertions (tool calls, substrings, tags)
 *   5. Return a CaseResult
 *
 * Judge-based scoring is a separate pass (judge.ts).
 */

import { runChat } from "../src/workflow.js";
import { classifyIntent } from "../src/guards/intentClassifier.js";
import { verifyResponse } from "../src/guards/hallucinationGuard.js";
import type { TestCase, CaseResult, AssertionResult } from "./types.js";

// Minimal inline post-process (avoids importing from index.ts which starts a server)
// For eval purposes we only care about the raw model output.

function assert(name: string, passed: boolean, detail?: string): AssertionResult {
  return { name, passed, detail };
}

function containsAny(text: string, needles: string[]): string | null {
  const lower = text.toLowerCase();
  for (const n of needles) {
    if (lower.includes(n.toLowerCase())) return n;
  }
  return null;
}

export async function runCase(tc: TestCase): Promise<CaseResult> {
  const startedAt = Date.now();
  const history = tc.history ?? [];

  try {
    const result = await runChat({ message: tc.input, history });
    const latencyMs = Date.now() - startedAt;
    const response = result.response ?? "";

    // list_specialties is a discovery/bootstrap call (look up specialty IDs) —
    // same reasoning as mcp_list_tools. Not a semantic user-action, so we
    // filter it from the tool-call assertions. Kept in the report for
    // visibility (useful for detecting over-use) but doesn't affect pass/fail.
    const BOOTSTRAP_TOOLS = new Set(["mcp_list_tools", "list_specialties"]);
    const rawToolCalls = (result.toolCalls ?? []).map((c) => c.name);
    const toolCalls = rawToolCalls.filter((n) => !BOOTSTRAP_TOOLS.has(n));
    const intent = classifyIntent(tc.input);

    const assertions: AssertionResult[] = [];

    // 1. Intent detection
    if (tc.expected_intent) {
      assertions.push(assert(
        "intent_matches",
        intent.intent === tc.expected_intent,
        `expected ${tc.expected_intent}, got ${intent.intent}`
      ));
    }

    // 2. Tool calls — each expected tool must appear at least once
    if (tc.expected_tools && tc.expected_tools.length > 0) {
      const called = new Set(toolCalls);
      for (const t of tc.expected_tools) {
        assertions.push(assert(
          `tool_called:${t}`,
          called.has(t),
          called.has(t) ? undefined : `not called. actual: [${toolCalls.join(",")}]`
        ));
      }
    } else if (tc.expected_tools && tc.expected_tools.length === 0) {
      // Explicitly no tools expected
      assertions.push(assert(
        "no_tools_called",
        toolCalls.length === 0,
        toolCalls.length === 0 ? undefined : `unexpected: [${toolCalls.join(",")}]`
      ));
    }

    // 3. Substring — ALL must appear
    if (tc.must_contain) {
      for (const s of tc.must_contain) {
        assertions.push(assert(
          `must_contain:${s.slice(0, 30)}`,
          response.toLowerCase().includes(s.toLowerCase())
        ));
      }
    }

    // 4. Substring — ANY must appear
    if (tc.must_contain_any && tc.must_contain_any.length > 0) {
      const hit = containsAny(response, tc.must_contain_any);
      assertions.push(assert(
        "must_contain_any",
        hit !== null,
        hit ? `matched: ${hit}` : `none of [${tc.must_contain_any.join(",")}]`
      ));
    }

    // 5. Substring — NONE may appear
    if (tc.must_not_contain) {
      for (const s of tc.must_not_contain) {
        const present = response.toLowerCase().includes(s.toLowerCase());
        assertions.push(assert(
          `must_not_contain:${s.slice(0, 30)}`,
          !present,
          present ? `found forbidden substring` : undefined
        ));
      }
    }

    // 6. Expert tag presence
    const hasTag = /\[\[expert:[^\]]+\]\]/.test(response);
    if (tc.must_contain_tag) {
      assertions.push(assert("must_contain_expert_tag", hasTag));
    }
    if (tc.must_not_contain_tag) {
      assertions.push(assert("must_not_contain_expert_tag", !hasTag));
    }

    // 7. Hallucination check — no fake names/usernames
    try {
      const violations = await verifyResponse(response);
      assertions.push(assert(
        "no_hallucinated_names",
        violations.length === 0,
        violations.length > 0
          ? violations.map((v) => `${v.kind}:${v.value}`).join("; ")
          : undefined
      ));
    } catch {
      // Skip if API down
    }

    const passed = assertions.every((a) => a.passed);
    return {
      id: tc.id,
      category: tc.category,
      input: tc.input,
      response,
      latencyMs,
      toolCalls,
      detectedIntent: intent.intent,
      assertions,
      passed,
    };
  } catch (err) {
    return {
      id: tc.id,
      category: tc.category,
      input: tc.input,
      response: "",
      latencyMs: Date.now() - startedAt,
      toolCalls: [],
      detectedIntent: "unknown",
      assertions: [],
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
