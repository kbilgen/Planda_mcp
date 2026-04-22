/**
 * Planda MCP Server — Shared API client
 */
export declare function makeApiRequest<T>(endpoint: string, method?: "GET" | "POST" | "PUT" | "DELETE", body?: unknown, params?: Record<string, unknown>): Promise<T>;
/**
 * Converts any caught error into a human-readable, actionable string for the
 * MCP tool response.
 */
export declare function handleApiError(error: unknown): string;
//# sourceMappingURL=apiClient.d.ts.map