# Planda Therapist Finder — MCP Server

Real-time therapist search for **Planda** (planda.org), Turkey's leading online therapy marketplace. Any MCP-compatible AI assistant (ChatGPT, Gemini, Claude, etc.) can use this server to find licensed therapists, check availability, and book appointments.

**Live MCP endpoint:** `https://plandamcp-production.up.railway.app/mcp`

---

## What it does

When a user says *"I need a therapist"*, *"anksiyetem var"*, or *"depresyonla başa çıkamıyorum"*, the AI calls this server to:

- Search 60+ licensed therapists and psychologists
- Filter by specialty, city, online/in-person, gender, price, and therapy approach
- Verify specific approaches (CBT/BDT, EMDR, ACT, Schema, etc.) against live data
- Check a therapist's available days and appointment slots

---

## Connect to ChatGPT

1. Open ChatGPT → Settings → Connected apps → **Add MCP server**
2. Enter the server URL:
   ```
   https://plandamcp-production.up.railway.app/mcp
   ```
3. Done. ChatGPT will now suggest Planda therapists when you describe mental health struggles.

## Connect to Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "planda": {
      "type": "http",
      "url": "https://plandamcp-production.up.railway.app/mcp"
    }
  }
}
```

## Connect to Cursor / Windsurf / any MCP client

Use the streamable HTTP transport:

```
https://plandamcp-production.up.railway.app/mcp
```

---

## Tools

| Tool | When it's called |
|------|-----------------|
| `find_therapists` | User asks for a therapist or describes a mental health struggle |
| `get_therapist` | Verifying a therapist's therapy approaches (BDT, EMDR, ACT, etc.) |
| `list_specialties` | Looking up available specialty categories |
| `get_therapist_available_days` | Checking which days a therapist has open slots |
| `get_therapist_hours` | Getting appointment times for a specific date |

---

## Self-hosting

### Requirements

- Node.js ≥ 20
- (Optional) `PLANDA_API_KEY` for authenticated API calls

### Run locally

```bash
npm install
npm run build
node dist/index.js                        # stdio transport (default)
TRANSPORT=http PORT=3000 node dist/index.js  # HTTP transport
```

The MCP endpoint will be at `http://localhost:3000/mcp`.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TRANSPORT` | `stdio` | `stdio` or `http` |
| `PORT` | `3000` | HTTP server port |
| `PLANDA_API_KEY` | — | Bearer token for authenticated Planda API calls |
| `OPENAI_API_KEY` | — | Required for the assistant chat endpoint |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Model used by the assistant |

---

## Project structure

```
src/
├── index.ts              # Entry point, MCP server setup, HTTP routes
├── prompts.ts            # System prompt for the assistant endpoint
├── workflow.ts           # OpenAI Agents SDK integration
├── types.ts              # TypeScript interfaces
├── constants.ts          # API base URL, limits
├── services/
│   └── apiClient.ts      # Axios client + error handling
└── tools/
    └── therapists.ts     # All 5 tool registrations
```
