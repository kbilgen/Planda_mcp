/**
 * LLM-as-judge — scores a response against a test case using GPT-4o.
 *
 * Called as a second pass after the runner. Only runs when OPENAI_API_KEY is set.
 * Returns {score: 1-5, rationale: string}.
 */

import { OpenAI } from "openai";
import type { TestCase, CaseResult } from "./types.js";

const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "gpt-4o-mini";

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  return _client;
}

const JUDGE_SYSTEM = `You evaluate a Turkish therapy-matching assistant's response quality.
Score 1-5 where:
  5 = excellent — follows all rules, correct tools, natural Turkish, clear recommendation
  4 = good — minor issues (wording, tone), core behavior correct
  3 = acceptable — borderline; missing one expectation but not harmful
  2 = poor — wrong tool usage, hallucinated therapist, or rule violation
  1 = broken — off-topic, fabricated data, or refusal when it should help

Return ONLY compact JSON: {"score": 1-5, "rationale": "<one sentence>"}`;

export async function judgeCase(
  tc: TestCase,
  result: CaseResult
): Promise<{ score: number; rationale: string } | null> {
  if (!process.env.OPENAI_API_KEY) return null;

  const userPrompt = [
    `TEST CASE: ${tc.id} (${tc.category})`,
    `INPUT: ${tc.input}`,
    tc.history?.length ? `HISTORY: ${JSON.stringify(tc.history)}` : "",
    tc.notes ? `EXPECTED BEHAVIOR: ${tc.notes}` : "",
    tc.expected_tools ? `EXPECTED TOOLS: ${tc.expected_tools.join(", ") || "(none)"}` : "",
    `ACTUAL TOOLS CALLED: ${result.toolCalls.join(", ") || "(none)"}`,
    `ACTUAL RESPONSE: ${result.response.slice(0, 2000)}`,
    `DETERMINISTIC ASSERTIONS: ${result.assertions.filter((a) => !a.passed).map((a) => a.name).join(", ") || "all passed"}`,
  ].filter(Boolean).join("\n\n");

  try {
    const resp = await getClient().chat.completions.create({
      model: JUDGE_MODEL,
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    });
    const content = resp.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content) as { score?: number; rationale?: string };
    const score = typeof parsed.score === "number" ? Math.max(1, Math.min(5, parsed.score)) : 0;
    return { score, rationale: parsed.rationale ?? "" };
  } catch (err) {
    console.error(`[judge] error for ${tc.id}:`, err);
    return null;
  }
}
