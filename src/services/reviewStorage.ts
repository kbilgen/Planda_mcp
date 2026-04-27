/**
 * File-based persistence for the human review system.
 *
 * Storage layout (rooted at the Railway volume mount or a local fallback):
 *
 *   <root>/
 *   ├── reports/
 *   │   └── <ts>.json         — full eval report uploaded from local
 *   └── decisions.jsonl       — append-only log of every reviewer decision
 *
 * Decisions are written as one JSON object per line so concurrent reviewers
 * never overwrite each other. The full set of decisions for a report is
 * obtained by reading the log and filtering by reportTs.
 */

import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  appendFile,
  stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";

/**
 * Validate a report filename so it can be safely joined onto the storage root.
 * Returns the safe basename, or null if the input is unsafe.
 *
 * Rejects: path separators, parent refs, null bytes, leading dots, and any
 * filename that doesn't end in `.json`. Also requires basename(input) to equal
 * the input — this catches encoded separators that decode to "/" before us.
 */
function safeReportFilename(input: unknown): string | null {
  if (typeof input !== "string") return null;
  if (!input || input.length > 128) return null;
  if (input.includes("\0") || input.includes("/") || input.includes("\\")) return null;
  if (input.includes("..") || input.startsWith(".")) return null;
  if (!input.endsWith(".json")) return null;
  if (basename(input) !== input) return null;
  return input;
}

/**
 * Resolves the storage root. Railway sets RAILWAY_VOLUME_MOUNT_PATH when a
 * volume is attached. Locally we fall back to ./review-data so dev runs
 * don't pollute the repo and don't require any setup.
 */
export function getStorageRoot(): string {
  const railway = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (railway && railway.trim()) return railway.trim();
  if (process.env.REVIEW_STORAGE_PATH) return process.env.REVIEW_STORAGE_PATH;
  return resolve(process.cwd(), "review-data");
}

async function ensureDirs(): Promise<void> {
  const root = getStorageRoot();
  await mkdir(join(root, "reports"), { recursive: true });
}

// ─── Reports ─────────────────────────────────────────────────────────────────

export interface UploadedReport {
  ts: string;
  filename: string;
  size: number;
  totalCases?: number;
  passed?: number;
  failed?: number;
}

/**
 * Save a full eval report to disk. The `ts` from the report body is used
 * as the file id; if it's missing we synthesize one from the current time.
 */
export async function saveReport(reportJson: unknown): Promise<UploadedReport> {
  await ensureDirs();
  const root = getStorageRoot();
  const r = reportJson as { ts?: string; totalCases?: number; passed?: number; failed?: number };
  const ts = (r.ts || new Date().toISOString()).replace(/[:.]/g, "-");
  const filename = `${ts}.json`;
  const path = join(root, "reports", filename);
  await writeFile(path, JSON.stringify(reportJson, null, 2), "utf8");
  return {
    ts,
    filename,
    size: JSON.stringify(reportJson).length,
    totalCases: r.totalCases,
    passed: r.passed,
    failed: r.failed,
  };
}

/** List all uploaded reports, newest first. */
export async function listReports(): Promise<UploadedReport[]> {
  await ensureDirs();
  const dir = join(getStorageRoot(), "reports");
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  const out: UploadedReport[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const path = join(dir, f);
    try {
      const s = await stat(path);
      const raw = await readFile(path, "utf8");
      const r = JSON.parse(raw) as { ts?: string; totalCases?: number; passed?: number; failed?: number };
      out.push({
        ts: r.ts ?? f.replace(".json", ""),
        filename: f,
        size: s.size,
        totalCases: r.totalCases,
        passed: r.passed,
        failed: r.failed,
      });
    } catch {
      // Skip unreadable files silently — likely partial writes
    }
  }
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return out;
}

/** Fetch a report by its filename (e.g. "2026-04-25T19-00-00-000Z.json"). */
export async function getReport(filename: string): Promise<unknown | null> {
  const safe = safeReportFilename(filename);
  if (!safe) return null;
  const reportsDir = resolve(getStorageRoot(), "reports");
  const path = resolve(reportsDir, safe);
  if (!path.startsWith(reportsDir + "/") && path !== reportsDir) return null;
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

// ─── Decisions ───────────────────────────────────────────────────────────────

export interface ReviewDecision {
  /** Filename of the report this decision belongs to (e.g. "2026-04-25...json") */
  reportFilename: string;
  /** Stable scenario id within the report (CaseResult.id) */
  scenarioId: string;
  /** Reviewer name (from basic auth username) */
  reviewer: string;
  /** "excellent" | "good" | "mid" | "bad" */
  decision: "excellent" | "good" | "mid" | "bad";
  /** Free-form note explaining the decision (optional) */
  note?: string;
  /** ISO timestamp when the decision was recorded */
  ts: string;
}

const DECISIONS_FILE = "decisions.jsonl";

/**
 * Append a decision to the log. Idempotent in spirit: latest entry per
 * (report, scenario, reviewer) wins on read — we don't dedupe on write
 * to keep a full audit trail of mind-changes.
 */
export async function appendDecision(decision: ReviewDecision): Promise<void> {
  await ensureDirs();
  const root = getStorageRoot();
  const path = join(root, DECISIONS_FILE);
  await appendFile(path, JSON.stringify(decision) + "\n", "utf8");
}

/**
 * Read all decisions, optionally filtered by report. Returns the most
 * recent entry per (scenario, reviewer) pair so that a reviewer who
 * changed their mind sees only their last call.
 */
export async function listDecisions(
  reportFilename?: string
): Promise<ReviewDecision[]> {
  if (reportFilename !== undefined && !safeReportFilename(reportFilename)) {
    return [];
  }
  const path = join(getStorageRoot(), DECISIONS_FILE);
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  const all: ReviewDecision[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const d = JSON.parse(t) as ReviewDecision;
      if (reportFilename && d.reportFilename !== reportFilename) continue;
      all.push(d);
    } catch {}
  }
  // Dedupe: keep latest per (scenarioId, reviewer)
  const map = new Map<string, ReviewDecision>();
  for (const d of all) {
    const key = `${d.scenarioId}::${d.reviewer}`;
    const prev = map.get(key);
    if (!prev || d.ts > prev.ts) map.set(key, d);
  }
  return [...map.values()];
}
