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
 *   - Set TRANSPORT=http (or leave unset on Hostinger) to run as HTTP server
 *   - Set TRANSPORT=stdio for local Claude Desktop integration
 *
 * Environment variables:
 *   - PORT            : HTTP server port (Hostinger sets this automatically)
 *   - TRANSPORT       : "http" (default on Hostinger) or "stdio"
 *   - PLANDA_API_KEY  : Optional Bearer token for authenticated Planda API calls
 *   - CORS_ORIGIN     : Allowed CORS origin (default: "*" — open for OpenAI)
 */
export {};
//# sourceMappingURL=index.d.ts.map