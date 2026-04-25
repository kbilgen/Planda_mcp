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
/**
 * Resolves the storage root. Railway sets RAILWAY_VOLUME_MOUNT_PATH when a
 * volume is attached. Locally we fall back to ./review-data so dev runs
 * don't pollute the repo and don't require any setup.
 */
export declare function getStorageRoot(): string;
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
export declare function saveReport(reportJson: unknown): Promise<UploadedReport>;
/** List all uploaded reports, newest first. */
export declare function listReports(): Promise<UploadedReport[]>;
/** Fetch a report by its filename (e.g. "2026-04-25T19-00-00-000Z.json"). */
export declare function getReport(filename: string): Promise<unknown | null>;
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
/**
 * Append a decision to the log. Idempotent in spirit: latest entry per
 * (report, scenario, reviewer) wins on read — we don't dedupe on write
 * to keep a full audit trail of mind-changes.
 */
export declare function appendDecision(decision: ReviewDecision): Promise<void>;
/**
 * Read all decisions, optionally filtered by report. Returns the most
 * recent entry per (scenario, reviewer) pair so that a reviewer who
 * changed their mind sees only their last call.
 */
export declare function listDecisions(reportFilename?: string): Promise<ReviewDecision[]>;
//# sourceMappingURL=reviewStorage.d.ts.map