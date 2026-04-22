/**
 * Planda REST API Routes — iOS & Mobile Clients
 *
 * Exposes the Planda marketplace data as a simple REST API so that
 * mobile apps (iOS, Android) can consume it without implementing MCP.
 *
 * Endpoints:
 *   GET /api/therapists          — paginated list with optional filters
 *   GET /api/therapists/search   — free-text search
 *   GET /api/therapists/:id      — single therapist profile
 *   GET /api/specialties         — full specialty catalogue
 *
 * All responses follow the same envelope:
 *   Success: { data: T, pagination?: {...} }
 *   Error:   { error: { code: string, message: string } }
 */
export declare const therapistRouter: import("express-serve-static-core").Router;
//# sourceMappingURL=therapists.d.ts.map