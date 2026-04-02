#!/usr/bin/env node
/**
 * Planda MCP Server
 *
 * Provides LLM tools to query the Planda marketplace therapist API.
 *
 * Tools:
 *   - planda_list_therapists   : Paginated list with filters
 *   - planda_get_therapist     : Single therapist profile by ID
 *   - planda_search_therapists : Free-text search
 *
 * Transport:
 *   - Set TRANSPORT=http to run as a Streamable HTTP server (default port 3000)
 *   - Leave unset (or set TRANSPORT=stdio) for stdio mode (local Claude integration)
 *
 * Optional env vars:
 *   - PLANDA_API_KEY  : Bearer token for authenticated Planda API calls
 *   - PORT            : HTTP server port (default 3000, only for HTTP transport)
 */
export {};
//# sourceMappingURL=index.d.ts.map