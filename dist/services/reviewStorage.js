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
import { readFile, writeFile, mkdir, readdir, appendFile, stat, } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
/**
 * Resolves the storage root. Railway sets RAILWAY_VOLUME_MOUNT_PATH when a
 * volume is attached. Locally we fall back to ./review-data so dev runs
 * don't pollute the repo and don't require any setup.
 */
export function getStorageRoot() {
    const railway = process.env.RAILWAY_VOLUME_MOUNT_PATH;
    if (railway && railway.trim())
        return railway.trim();
    if (process.env.REVIEW_STORAGE_PATH)
        return process.env.REVIEW_STORAGE_PATH;
    return resolve(process.cwd(), "review-data");
}
async function ensureDirs() {
    const root = getStorageRoot();
    await mkdir(join(root, "reports"), { recursive: true });
}
/**
 * Save a full eval report to disk. The `ts` from the report body is used
 * as the file id; if it's missing we synthesize one from the current time.
 */
export async function saveReport(reportJson) {
    await ensureDirs();
    const root = getStorageRoot();
    const r = reportJson;
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
export async function listReports() {
    await ensureDirs();
    const dir = join(getStorageRoot(), "reports");
    if (!existsSync(dir))
        return [];
    const files = await readdir(dir);
    const out = [];
    for (const f of files) {
        if (!f.endsWith(".json"))
            continue;
        const path = join(dir, f);
        try {
            const s = await stat(path);
            const raw = await readFile(path, "utf8");
            const r = JSON.parse(raw);
            out.push({
                ts: r.ts ?? f.replace(".json", ""),
                filename: f,
                size: s.size,
                totalCases: r.totalCases,
                passed: r.passed,
                failed: r.failed,
            });
        }
        catch {
            // Skip unreadable files silently — likely partial writes
        }
    }
    out.sort((a, b) => b.ts.localeCompare(a.ts));
    return out;
}
/** Fetch a report by its filename (e.g. "2026-04-25T19-00-00-000Z.json"). */
export async function getReport(filename) {
    // Defensive: prevent path traversal
    if (filename.includes("/") || filename.includes(".."))
        return null;
    const path = join(getStorageRoot(), "reports", filename);
    if (!existsSync(path))
        return null;
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
}
const DECISIONS_FILE = "decisions.jsonl";
/**
 * Append a decision to the log. Idempotent in spirit: latest entry per
 * (report, scenario, reviewer) wins on read — we don't dedupe on write
 * to keep a full audit trail of mind-changes.
 */
export async function appendDecision(decision) {
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
export async function listDecisions(reportFilename) {
    const path = join(getStorageRoot(), DECISIONS_FILE);
    if (!existsSync(path))
        return [];
    const raw = await readFile(path, "utf8");
    const all = [];
    for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t)
            continue;
        try {
            const d = JSON.parse(t);
            if (reportFilename && d.reportFilename !== reportFilename)
                continue;
            all.push(d);
        }
        catch { }
    }
    // Dedupe: keep latest per (scenarioId, reviewer)
    const map = new Map();
    for (const d of all) {
        const key = `${d.scenarioId}::${d.reviewer}`;
        const prev = map.get(key);
        if (!prev || d.ts > prev.ts)
            map.set(key, d);
    }
    return [...map.values()];
}
//# sourceMappingURL=reviewStorage.js.map