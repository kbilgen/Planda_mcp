/**
 * Planda Assistant — Claude (Anthropic) provider path.
 *
 * Enabled with AI_PROVIDER=claude + ANTHROPIC_API_KEY. Runs the exact same
 * tool handlers (handlers.ts) as the OpenAI path through the Anthropic SDK's
 * beta tool runner, so guards, logging and post-processing see an identical
 * surface: same tool names, same ChatOutput shape.
 *
 * Model: CLAUDE_MODEL (default "claude-fable-5"). On Fable 5 thinking is
 * always on — the `thinking` parameter is intentionally omitted. Depth is
 * controlled with output_config.effort (CLAUDE_EFFORT, default "low": chat
 * latency matters here, and low effort on Fable 5 still outperforms prior
 * models' high settings).
 *
 * Safety: Fable 5's classifiers can decline a request (stop_reason
 * "refusal"). We opt into server-side fallbacks so a declined request is
 * transparently re-run on claude-opus-4-8; if the whole chain refuses we
 * return a safe Turkish message instead of crashing.
 */
import type { ChatInput, ChatOutput } from "./workflow.js";
export declare const CLAUDE_MODEL: string;
export declare function isClaudeEnabled(): boolean;
export declare function runClaudeChat(input: ChatInput): Promise<ChatOutput>;
//# sourceMappingURL=claudeWorkflow.d.ts.map