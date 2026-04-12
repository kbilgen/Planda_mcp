/**
 * Planda Chat Route — POST /api/chat
 *
 * iOS chatbot endpoint:
 *   1. Reads conversation history from sessionStore (Redis or in-memory)
 *   2. Calls the OpenAI agent workflow
 *   3. Parses the agent's JSON output into a typed ChatResponse
 *   4. Saves updated history back to sessionStore
 *   5. Returns { text, cards?, quickReplies?, crisis?, outOfScope? }
 */

import { Router, Request, Response } from "express";
import { runWorkflow } from "../workflow.js";
import { getHistory, saveHistory, ChatMessage } from "../sessionStore.js";
import { ChatResponse, ChatRequest } from "../types.js";

export const chatRouter = Router();

// ─── parseAgentOutput ─────────────────────────────────────────────────────────
// Converts the raw string from the agent into a typed ChatResponse.
// Falls back to { text: raw } if JSON.parse fails — system never crashes.

export function parseAgentOutput(raw: string): ChatResponse {
  const trimmed = raw.trim();
  try {
    // Agent sometimes wraps JSON in markdown code fences — strip them
    const cleaned = trimmed
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const json = JSON.parse(cleaned) as Record<string, unknown>;
    return {
      text: typeof json["text"] === "string" ? json["text"] : trimmed,
      cards: Array.isArray(json["cards"]) ? json["cards"] as ChatResponse["cards"] : undefined,
      quickReplies: Array.isArray(json["quickReplies"]) ? json["quickReplies"] as ChatResponse["quickReplies"] : undefined,
      crisis: json["crisis"] === true ? true : undefined,
      outOfScope: json["outOfScope"] === true ? true : undefined,
    };
  } catch {
    // JSON parse failed — return raw text as a plain chat bubble
    return { text: trimmed };
  }
}

// ─── POST /api/chat ───────────────────────────────────────────────────────────

chatRouter.post("/chat", async (req: Request, res: Response) => {
  const { message, sessionId } = req.body as Partial<ChatRequest>;

  if (!message || typeof message !== "string" || message.trim() === "") {
    res.status(422).json({
      error: { code: "VALIDATION_ERROR", message: '"message" alanı zorunludur.' },
    });
    return;
  }

  if (!sessionId || typeof sessionId !== "string") {
    res.status(422).json({
      error: { code: "VALIDATION_ERROR", message: '"sessionId" alanı zorunludur.' },
    });
    return;
  }

  try {
    // 1. Load conversation history for this session
    const history = await getHistory(sessionId);

    // 2. Run the OpenAI agent workflow
    const result = await runWorkflow({
      input_as_text: message.trim(),
      history,
    });

    // 3. Parse agent JSON output
    const rawOutput =
      (result as { output_json?: string; output_text?: string }).output_json ??
      (result as { output_text?: string }).output_text ??
      "";

    const response = parseAgentOutput(rawOutput);

    // 4. Persist updated history
    const updated: ChatMessage[] = [
      ...history,
      { role: "user", content: message.trim() },
      { role: "assistant", content: rawOutput || response.text },
    ];
    await saveHistory(sessionId, updated);

    // 5. Return typed ChatResponse
    res.json(response);
  } catch (err: unknown) {
    console.error("[chat] Unhandled error:", err);
    res.status(502).json({
      error: {
        code: "UPSTREAM_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
});
