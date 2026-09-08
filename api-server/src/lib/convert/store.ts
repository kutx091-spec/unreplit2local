import * as fs from "node:fs";
import * as path from "node:path";
import type { ConversionIssueReport, ConvertJob } from "./types.js";

// In-memory store for conversion jobs. Fine for v1 (no DB needed).
const jobs = new Map<string, ConvertJob>();

export function createJob(jobId: string): ConvertJob {
  const job: ConvertJob = {
    jobId,
    status: "pending",
    logs: [],
    createdAt: new Date(),
  };
  jobs.set(jobId, job);
  return job;
}

export function getJob(jobId: string): ConvertJob | undefined {
  return jobs.get(jobId);
}

export function updateJob(jobId: string, partial: Partial<ConvertJob>): void {
  const job = jobs.get(jobId);
  if (job) {
    Object.assign(job, partial);
  }
}

type NewConversionIssueReport = Omit<ConversionIssueReport, "createdAt"> & {
  createdAt?: string;
};

const DEFAULT_REPORTS_PATH = path.join(process.cwd(), "data", "conversion-reports.jsonl");

function getReportsPath(): string {
  return process.env.CONVERSION_REPORTS_PATH?.trim() || DEFAULT_REPORTS_PATH;
}

function readReports(): ConversionIssueReport[] {
  const reportsPath = getReportsPath();

  if (!fs.existsSync(reportsPath)) {
    return [];
  }

  const contents = fs.readFileSync(reportsPath, "utf8");
  return contents
    .split("\n")
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, index }) => {
      try {
        return JSON.parse(line) as ConversionIssueReport;
      } catch (error) {
        throw new Error(
          `Unable to read conversion report at line ${index + 1}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
}

export function saveConversionIssueReport(
  report: NewConversionIssueReport,
): ConversionIssueReport {
  const storedReport: ConversionIssueReport = {
    ...report,
    createdAt: report.createdAt ?? new Date().toISOString(),
  };
  const reportsPath = getReportsPath();

  fs.mkdirSync(path.dirname(reportsPath), { recursive: true });
  fs.appendFileSync(reportsPath, `${JSON.stringify(storedReport)}\n`, "utf8");

  return storedReport;
}

/**
 * Returns all saved reports, newest first.
 *
 * Reports are read from disk on every call so this remains useful after a
 * server restart and does not depend on the in-memory conversion job store.
 */
export function listConversionIssueReports(): ConversionIssueReport[] {
  return readReports().reverse();
}
