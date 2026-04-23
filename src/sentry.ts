/**
 * Sentry integration — error tracking + structured events.
 *
 * Initialized at startup if SENTRY_DSN is set. All helpers are no-ops when
 * Sentry is not configured, so code can call them unconditionally.
 *
 * IMPORTANT: Auto-instrumentation (OpenTelemetry HTTP/Express patching) is
 * DISABLED. The @sentry/node v8+ auto-instrumentation requires Sentry.init()
 * to run BEFORE any other module imports — our setup imports express/http
 * first, which causes request hangs in production. We use manual capture
 * (captureException, captureMessage, withScope) which works regardless of
 * import order. Performance spans are no-ops.
 *
 * Env:
 *   SENTRY_DSN           — DSN from Sentry project settings
 *   SENTRY_ENVIRONMENT   — "production" | "staging" | ... (default: NODE_ENV)
 *   SENTRY_RELEASE       — release tag
 */

import * as Sentry from "@sentry/node";
import type { TurnLog } from "./logger.js";

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log("[sentry] SENTRY_DSN not set — Sentry disabled");
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "production",
    release: process.env.SENTRY_RELEASE,
    sendDefaultPii: false,
    // Disable performance tracing — no auto-spans, no module patching
    tracesSampleRate: 0,
    // Skip OpenTelemetry auto-setup — prevents HTTP/Express hang on late init
    skipOpenTelemetrySetup: true,
    // Don't register ESM loader hooks (we're already imported)
    registerEsmLoaderHooks: false,
    // Replace default integrations with a minimal set that doesn't patch modules
    defaultIntegrations: false,
    integrations: [
      Sentry.consoleIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.requestDataIntegration(),
    ],
  });

  initialized = true;
  console.log("[sentry] Initialized (manual capture mode)");
}

export function isSentryEnabled(): boolean {
  return initialized;
}

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
export function reportTurnToSentry(turn: TurnLog): void {
  if (!initialized) return;

  const toolNames = turn.toolCalls.map((c) => c.name);
  const violationCount = turn.violations?.length ?? 0;

  Sentry.withScope((scope) => {
    scope.setTag("intent", turn.intent ?? "unknown");
    scope.setTag("endpoint", turn.endpoint ?? "unknown");
    scope.setTag("model", turn.model ?? "unknown");
    scope.setTag("has_violations", String(violationCount > 0));
    scope.setTag("tool_count", String(turn.toolCalls.length));

    scope.setUser({ id: turn.sessionId });

    scope.setContext("turn", {
      sessionId: turn.sessionId,
      userMessage: turn.userMessage.slice(0, 500),
      response: turn.response.slice(0, 2000),
      toolCalls: turn.toolCalls.map((c) => ({
        name: c.name,
        arguments: c.arguments.slice(0, 500),
      })),
      latencyMs: turn.latencyMs,
      violations: turn.violations,
      intent: turn.intent,
    });

    // Breadcrumb for every turn (appears on any subsequent error)
    Sentry.addBreadcrumb({
      category: "chat.turn",
      level: "info",
      message: `${turn.intent ?? "unknown"} (${toolNames.join(",") || "no-tools"})`,
      data: {
        sessionId: turn.sessionId.slice(0, 8),
        latencyMs: turn.latencyMs,
      },
    });

    // Event only when something's worth flagging
    if (turn.error) {
      Sentry.captureException(new Error(turn.error), {
        tags: { kind: "chat_error" },
      });
    } else if (violationCount > 0) {
      const kinds = [...new Set((turn.violations ?? []).map((v) => v.kind))].join(",");
      Sentry.captureMessage(`Chat quality violation: ${kinds}`, {
        level: "warning",
        tags: { kind: "chat_violation", violation_kinds: kinds },
      });
    }
  });
}

/**
 * Wraps a chat turn — currently a no-op pass-through.
 * Performance spans require OpenTelemetry which we disable; kept for API
 * compatibility in case we re-enable tracing via --import preload later.
 */
export async function withChatSpan<T>(
  _name: string,
  _attrs: Record<string, string | number | boolean>,
  fn: () => Promise<T>
): Promise<T> {
  return fn();
}

export { Sentry };
