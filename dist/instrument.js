/**
 * Sentry preload — loaded via `node --import ./dist/instrument.js`.
 *
 * This file MUST be loaded before any other application module so that
 * @sentry/node's OpenTelemetry auto-instrumentation can patch http, express,
 * and @modelcontextprotocol/sdk at import time. Without this preload, those
 * modules are imported first and instrumentation becomes partial, causing
 * request hangs (see commit 8f0d7e3).
 *
 * Enables:
 *   - HTTP request tracing
 *   - Express middleware / route spans
 *   - MCP server & client tool-call tracing (Sentry AI → MCP Insights)
 *   - Automatic error capture
 *
 * Env:
 *   SENTRY_DSN           — required to activate; when absent, no-op
 *   SENTRY_ENVIRONMENT   — default: NODE_ENV
 *   SENTRY_RELEASE       — optional release tag
 *   SENTRY_TRACES_RATE   — 0..1 sample rate for performance spans.
 *                          Default 1.0 — MCP monitoring requires tracing
 *                          enabled and recommends capturing all spans.
 *                          Lower in prod if cost becomes a concern (0.2-0.5).
 */
import * as Sentry from "@sentry/node";
const dsn = process.env.SENTRY_DSN;
if (dsn) {
    Sentry.init({
        dsn,
        environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "production",
        release: process.env.SENTRY_RELEASE,
        tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_RATE ?? "1.0"),
        // Note: PII stays disabled. Our observability pipeline explicitly attaches
        // userMessage / response via Sentry scope; enabling sendDefaultPii would
        // additionally capture HTTP request data (IPs, cookies, headers) which
        // isn't useful for our quality-review use case and widens the PII surface.
        sendDefaultPii: false,
        // Default integrations active — include HTTP, Express, MCP instrumentation
    });
    console.log("[sentry] Preloaded (full auto-instrumentation active)");
}
else {
    console.log("[sentry] Preload skipped — SENTRY_DSN not set");
}
//# sourceMappingURL=instrument.js.map