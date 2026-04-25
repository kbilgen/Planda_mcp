/**
 * Upload the latest eval report to the deployed review server.
 *
 * Usage:
 *   npm run eval:upload            — uploads newest reports/<ts>.json
 *   tsx evals/upload.ts <file>     — uploads a specific report file
 *
 * Required env (load via .env or shell):
 *   REVIEW_BASE_URL  — e.g. https://plandamcp-production.up.railway.app
 *   REVIEW_USER      — basic auth username
 *   REVIEW_PASS      — basic auth password
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const EVALS_DIR = dirname(__filename);
const REPORTS_DIR = resolve(EVALS_DIR, "reports");

// Tiny .env loader — duplicated from run.ts to keep CLIs self-contained.
function loadDotEnv(): void {
  const candidates = [
    resolve(EVALS_DIR, "..", ".env"),
    resolve(process.cwd(), ".env"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = t.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
    return;
  }
}
loadDotEnv();

async function pickLatestReport(): Promise<string> {
  if (!existsSync(REPORTS_DIR)) {
    throw new Error(`No reports directory at ${REPORTS_DIR}. Run 'npm run eval -- --judge' first.`);
  }
  const files = (await readdir(REPORTS_DIR)).filter((f) => f.endsWith(".json"));
  if (files.length === 0) throw new Error("No report files found.");
  files.sort();  // ISO timestamps — lexical sort = chronological
  return resolve(REPORTS_DIR, files[files.length - 1]);
}

async function main(): Promise<void> {
  const baseUrl = (process.env.REVIEW_BASE_URL || "").replace(/\/$/, "");
  const user = process.env.REVIEW_USER;
  const pass = process.env.REVIEW_PASS;
  if (!baseUrl || !user || !pass) {
    console.error("Missing env: REVIEW_BASE_URL, REVIEW_USER, REVIEW_PASS");
    console.error("Add them to .env or export them, then retry.");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const path = args[0]
    ? (args[0].startsWith("/") ? args[0] : resolve(process.cwd(), args[0]))
    : await pickLatestReport();

  console.log(`Uploading ${path}`);
  const json = await readFile(path, "utf8");

  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  const url = `${baseUrl}/review/api/reports`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: json,
  });
  if (!r.ok) {
    const txt = await r.text();
    console.error(`Upload failed: ${r.status} ${r.statusText}`);
    console.error(txt);
    process.exit(1);
  }
  const meta = await r.json();
  console.log("Uploaded:", JSON.stringify(meta, null, 2));
  console.log(`Open: ${baseUrl}/review`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
