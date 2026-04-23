/**
 * Eval CLI — loads dataset.jsonl, runs every case, optionally judges,
 * writes a report to evals/reports/<timestamp>.json, prints a summary table.
 *
 * Usage:
 *   tsx evals/run.ts                 — deterministic assertions only
 *   tsx evals/run.ts --judge         — also LLM-as-judge scoring
 *   tsx evals/run.ts --filter search — only run cases where category or id contains "search"
 *
 * Env:
 *   OPENAI_API_KEY   — required (runChat uses it)
 *   JUDGE_MODEL      — default "gpt-4o-mini"
 *   EVAL_CONCURRENCY — default 3 (parallel case execution)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCase } from "./runner.js";
import { judgeCase } from "./judge.js";
import type { TestCase, CaseResult, EvalReport } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const EVALS_DIR = dirname(__filename);

const DATASET_PATH = resolve(EVALS_DIR, "dataset.jsonl");
const REPORTS_DIR = resolve(EVALS_DIR, "reports");

const args = process.argv.slice(2);
const useJudge = args.includes("--judge");
const filterIdx = args.indexOf("--filter");
const filter = filterIdx >= 0 ? args[filterIdx + 1] ?? "" : "";

const CONCURRENCY = Math.max(1, parseInt(process.env.EVAL_CONCURRENCY ?? "3", 10));

async function loadDataset(): Promise<TestCase[]> {
  const raw = await readFile(DATASET_PATH, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//"));
  return lines.map((l, i) => {
    try {
      return JSON.parse(l) as TestCase;
    } catch (err) {
      throw new Error(`dataset line ${i + 1} parse error: ${err}`);
    }
  });
}

async function runBatch(cases: TestCase[]): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  let idx = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < CONCURRENCY; w++) {
    workers.push((async () => {
      while (true) {
        const i = idx++;
        if (i >= cases.length) return;
        const tc = cases[i];
        process.stdout.write(`  [${i + 1}/${cases.length}] ${tc.id} ... `);
        const result = await runCase(tc);
        if (useJudge) {
          const judged = await judgeCase(tc, result);
          if (judged) {
            result.judgeScore = judged.score;
            result.judgeRationale = judged.rationale;
          }
        }
        results.push(result);
        const status = result.passed ? "PASS" : "FAIL";
        const judge = result.judgeScore ? ` (judge=${result.judgeScore})` : "";
        process.stdout.write(`${status}${judge} [${result.latencyMs}ms]\n`);
      }
    })());
  }
  await Promise.all(workers);
  results.sort((a, b) => a.id.localeCompare(b.id));
  return results;
}

function summarize(results: CaseResult[]): EvalReport {
  const byCategory: Record<string, { passed: number; failed: number }> = {};
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = { passed: 0, failed: 0 };
    if (r.passed) { byCategory[r.category].passed++; passed++; }
    else          { byCategory[r.category].failed++; failed++; }
  }
  return {
    ts: new Date().toISOString(),
    totalCases: results.length,
    passed,
    failed,
    byCategory,
    cases: results,
  };
}

function printSummary(report: EvalReport): void {
  const line = "─".repeat(60);
  console.log("\n" + line);
  console.log(`Total: ${report.totalCases}  Passed: ${report.passed}  Failed: ${report.failed}`);
  console.log(`Pass rate: ${((report.passed / report.totalCases) * 100).toFixed(1)}%`);
  console.log(line);
  console.log("By category:");
  for (const [cat, stats] of Object.entries(report.byCategory)) {
    const total = stats.passed + stats.failed;
    const rate = ((stats.passed / total) * 100).toFixed(0);
    console.log(`  ${cat.padEnd(20)} ${stats.passed}/${total}  (${rate}%)`);
  }

  const failures = report.cases.filter((c) => !c.passed);
  if (failures.length > 0) {
    console.log("\n" + line);
    console.log("FAILURES:");
    for (const f of failures) {
      console.log(`\n  ${f.id} [${f.category}]`);
      console.log(`    input: ${f.input.slice(0, 80)}`);
      if (f.error) {
        console.log(`    ERROR: ${f.error}`);
      } else {
        const failed = f.assertions.filter((a) => !a.passed);
        for (const a of failed) {
          console.log(`    ✗ ${a.name}${a.detail ? ": " + a.detail : ""}`);
        }
      }
    }
  }

  const judged = report.cases.filter((c) => typeof c.judgeScore === "number");
  if (judged.length > 0) {
    const avg = judged.reduce((s, c) => s + (c.judgeScore ?? 0), 0) / judged.length;
    console.log("\n" + line);
    console.log(`Judge average: ${avg.toFixed(2)}/5  (n=${judged.length})`);
  }
  console.log(line);
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is required to run evals.");
    process.exit(1);
  }

  console.log(`Loading dataset from ${DATASET_PATH}`);
  let cases = await loadDataset();
  if (filter) {
    cases = cases.filter((c) => c.id.includes(filter) || c.category.includes(filter));
    console.log(`Filter "${filter}" → ${cases.length} cases`);
  }
  console.log(`Running ${cases.length} case(s), concurrency=${CONCURRENCY}${useJudge ? ", judge=on" : ""}\n`);

  const results = await runBatch(cases);
  const report = summarize(results);
  printSummary(report);

  await mkdir(REPORTS_DIR, { recursive: true });
  const stamp = report.ts.replace(/[:.]/g, "-");
  const outPath = resolve(REPORTS_DIR, `${stamp}.json`);
  await writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nReport: ${outPath}`);

  process.exit(report.failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
