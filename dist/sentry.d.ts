/**
 * Sentry integration — error tracking + structured events.
 *
 * Primary init happens in src/instrument.ts, preloaded via
 * `node --import ./dist/instrument.js`. This file provides helper functions
 * (reportTurnToSentry, withChatSpan) and a fallback init for when preload
 * didn't happen (e.g. running `node dist/index.js` directly or in tests).
 *
 * The fallback init is SAFE: it disables all auto-instrumentation so a late
 * init never hangs HTTP. When preload DID happen, initSentry() detects it
 * and becomes a no-op, letting the preload's full instrumentation remain.
 *
 * Env:
 *   SENTRY_DSN           — DSN from Sentry project settings (required for init)
 *   SENTRY_ENVIRONMENT   — default: NODE_ENV
 *   SENTRY_RELEASE       — release tag
 */
import * as Sentry from "@sentry/node";
import type { TurnLog } from "./logger.js";
export declare function initSentry(): void;
export declare function isSentryEnabled(): boolean;
/**
 * Send a completed turn to Sentry.
 *
 *   - Violations (hallucination, intent mismatch) → captureMessage(warning)
 *   - Errors                                      → captureException
 *   - Clean turns                                 → breadcrumb only (no event)
 *
 * Tags (searchable in Sentry UI): intent, endpoint, model, has_violations
 * Contexts: turn_details (full JSON minus long strings)
 */
export declare function reportTurnToSentry(turn: TurnLog): void;
/**
 * Wraps a chat turn in a performance span.
 * When Sentry is preloaded, this creates a real OpenTelemetry span visible
 * in Performance / Traces. In fallback mode it is a no-op pass-through.
 */
export declare function withChatSpan<T>(name: string, attrs: Record<string, string | number | boolean>, fn: () => Promise<T>): Promise<T>;
export { Sentry };
//# sourceMappingURL=sentry.d.ts.map