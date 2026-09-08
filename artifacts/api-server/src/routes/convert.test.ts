import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import app from "../app.js";
import { logger } from "../lib/logger.js";
import {
  createJob,
  listConversionIssueReports,
  updateJob,
} from "../lib/convert/store.js";
import type { ProjectAnalysis } from "../lib/convert/types.js";

const jobId = "report-analysis-test-job";
const analysis: ProjectAnalysis = {
  stack: ["node", "python"],
  startCommand: "pnpm dev",
  startCommands: ["pnpm dev", "python3 worker.py"],
  packageManager: "pnpm",
  isHybrid: true,
  needsDatabase: true,
  orphanedScripts: ["scripts/legacy-cleanup.ts"],
  replitPlugins: ["plugins/example"],
  envKeys: ["DATABASE_URL", "PORT"],
  nixPackages: ["postgresql"],
  runtimes: ["nodejs-20", "python-3.11"],
};

let server: Server;
let baseUrl: string;
const loggedEvents: Record<string, unknown>[] = [];
const originalLoggerInfo = logger.info;
const reportsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "replit-to-local-reports-"));
const reportsPath = path.join(reportsDirectory, "reports.jsonl");

before(async () => {
  process.env.CONVERSION_REPORTS_PATH = reportsPath;
  createJob(jobId);
  updateJob(jobId, { status: "done", analysis });

  Object.defineProperty(logger, "info", {
    configurable: true,
    value: (event: Record<string, unknown>) => {
      loggedEvents.push(event);
    },
  });

  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  delete process.env.CONVERSION_REPORTS_PATH;
  Object.defineProperty(logger, "info", {
    configurable: true,
    value: originalLoggerInfo,
  });

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  fs.rmSync(reportsDirectory, { recursive: true, force: true });
});

test("creates a report and preserves the complete conversion analysis", async () => {
  const response = await fetch(`${baseUrl}/api/convert/${jobId}/report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      problem: "  The generated worker command fails on startup.  ",
      email: "  reporter@example.com  ",
    }),
  });

  assert.equal(response.status, 201);
  const responseBody = (await response.json()) as Record<string, unknown>;
  assert.equal(responseBody.ok, true);
  assert.equal(responseBody.message, "Report saved to persistent storage.");
  assert.equal(typeof responseBody.reportId, "string");

  const reportEvent = loggedEvents.find(
    (event) => event.event === "conversion_issue_report",
  );
  assert.ok(reportEvent);
  assert.equal(reportEvent.problem, "The generated worker command fails on startup.");
  assert.equal(reportEvent.email, "reporter@example.com");
  assert.deepEqual(reportEvent.analysis, analysis);

  const reports = listConversionIssueReports();
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.reportId, responseBody.reportId);
  assert.equal(reports[0]?.jobId, jobId);
  assert.equal(reports[0]?.problem, "The generated worker command fails on startup.");
  assert.equal(reports[0]?.email, "reporter@example.com");
  assert.deepEqual(reports[0]?.analysis, analysis);
  assert.equal(typeof reports[0]?.createdAt, "string");
});

test("rejects an empty report and an invalid optional email", async (t) => {
  await t.test("empty report text", async () => {
    const response = await fetch(`${baseUrl}/api/convert/${jobId}/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ problem: "   " }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Please describe what went wrong.",
    });
  });

  await t.test("invalid email", async () => {
    const response = await fetch(`${baseUrl}/api/convert/${jobId}/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        problem: "The report has enough text.",
        email: "not-an-email",
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Please enter a valid email address or leave it blank.",
    });
  });
});

test("rejects reports for missing and incomplete conversions without saving anything", async (t) => {
  const incompleteJobs = [
    { jobId: "report-pending-test-job", status: "pending" as const },
    { jobId: "report-running-test-job", status: "running" as const },
    { jobId: "report-error-test-job", status: "error" as const },
  ];

  for (const { jobId: incompleteJobId, status } of incompleteJobs) {
    createJob(incompleteJobId);
    updateJob(incompleteJobId, { status });
  }

  const reportEventCount = loggedEvents.filter(
    (event) => event.event === "conversion_issue_report",
  ).length;
  const savedReportCount = listConversionIssueReports().length;
  const reportBody = JSON.stringify({ problem: "This conversion cannot be reported yet." });

  await t.test("job does not exist", async () => {
    const response = await fetch(`${baseUrl}/api/convert/report-missing-test-job/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: reportBody,
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "Conversion not found.",
    });
  });

  for (const { jobId: incompleteJobId, status } of incompleteJobs) {
    await t.test(`job with ${status} status`, async () => {
      const response = await fetch(`${baseUrl}/api/convert/${incompleteJobId}/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: reportBody,
      });

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: "Reports are available after a conversion completes.",
      });
    });
  }

  assert.equal(
    loggedEvents.filter((event) => event.event === "conversion_issue_report").length,
    reportEventCount,
  );
  assert.equal(listConversionIssueReports().length, savedReportCount);
});