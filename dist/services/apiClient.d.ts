/**
 * Planda MCP Server — Shared API client
 */
/**
 * Generic HTTP request helper for the Planda API.
 *
 * Authentication: pass PLANDA_API_KEY via environment variable.  If present it
 * is sent as a Bearer token in the Authorization header. For public endpoints
 * (like the marketplace therapists list) no token is required.
 */
export declare function makeApiRequest<T>(endpoint: string, method?: "GET" | "POST" | "PUT" | "DELETE", body?: unknown, params?: Record<string, unknown>): Promise<T>;
/**
 * Converts any caught error into a human-readable, actionable string for the
 * MCP tool response.
 */
export declare function handleApiError(error: unknown): string;
//# sourceMappingURL=apiClient.d.ts.map