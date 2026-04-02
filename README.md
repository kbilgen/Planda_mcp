# planda-mcp-server

MCP (Model Context Protocol) server for the **Planda Marketplace Therapists API**.

Provides three tools that let any MCP-compatible LLM client (Claude, etc.) query therapist listings at `https://app.planda.org/api/v1/marketplace/therapists`.

---

## Tools

| Tool | Description |
|------|-------------|
| `planda_list_therapists` | Paginated list with optional filters (specialty, language, city, online, gender, price) |
| `planda_get_therapist` | Full profile of a single therapist by ID |
| `planda_search_therapists` | Free-text search across names, bios, and specialties |

---

## Quick Start

### 1. Install & Build

```bash
npm install
npm run build
```

### 2. Run (stdio — for local Claude / MCP clients)

```bash
node dist/index.js
```

### 3. Run (HTTP — for remote/multi-client deployments)

```bash
TRANSPORT=http PORT=3000 node dist/index.js
```

The MCP endpoint will be available at `http://localhost:3000/mcp`.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PLANDA_API_KEY` | No | Bearer token for authenticated Planda API calls. Omit for public endpoints. |
| `TRANSPORT` | No | `stdio` (default) or `http` |
| `PORT` | No | HTTP server port (default `3000`, only used when `TRANSPORT=http`) |

---

## Claude Desktop Integration (stdio)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "planda": {
      "command": "node",
      "args": ["/absolute/path/to/planda-mcp-server/dist/index.js"],
      "env": {
        "PLANDA_API_KEY": "your-token-here"
      }
    }
  }
}
```

---

## Project Structure

```
planda-mcp-server/
├── src/
│   ├── index.ts                  # Entry point — transport selection
│   ├── constants.ts              # API_BASE_URL, CHARACTER_LIMIT
│   ├── types.ts                  # TypeScript interfaces & ResponseFormat enum
│   ├── services/
│   │   └── apiClient.ts          # Shared Axios client + error handler
│   └── tools/
│       └── therapists.ts         # Tool registrations (list / get / search)
├── dist/                         # Compiled JavaScript (after npm run build)
├── package.json
└── tsconfig.json
```

---

## Development

```bash
npm run dev   # tsx watch mode — auto-reloads on source changes
npm run build # compile TypeScript → dist/
npm run clean # remove dist/
```
# Planda_mcp
