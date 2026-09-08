import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import multer, { MulterError } from "multer";
import * as fs from "fs";
import {
  createJob,
  getJob,
  saveConversionIssueReport,
} from "../lib/convert/store.js";
import { runPipeline, generateJobId } from "../lib/convert/pipeline.js";
import { ensureUploadDir, UPLOAD_DIR } from "../lib/convert/temp-files.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// 200 MB limit — large zips with many files stay under this comfortably
ensureUploadDir();
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (file.mimetype === "application/zip" || file.originalname.endsWith(".zip")) {
      cb(null, true);
    } else {
      cb(new Error("Only .zip files are accepted."));
    }
  },
});

const REPORT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_REPORT_LENGTH = 5000;

// POST /api/convert — accepts a .zip, starts the pipeline, returns jobId immediately
// Uses multer callback form so its errors are caught and returned as JSON (not HTML 500)
router.post("/convert", (req: Request, res: Response): void => {
  upload.single("file")(req, res, (err: unknown) => {
    if (err) {
      let message = "Upload failed.";
      if (err instanceof MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          message = "File too large. Maximum allowed size is 200 MB.";
        } else {
          message = `Upload error: ${err.message}`;
        }
      } else if (err instanceof Error) {
        message = err.message;
      }
      res.status(400).json({ error: message });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: "No file uploaded. Please select a .zip file." });
      return;
    }

    const jobId = generateJobId();
    createJob(jobId);

    // Run pipeline async. Use .catch() so an unhandled rejection never crashes the process.
    runPipeline(jobId, req.file.path).catch((unexpectedErr) => {
      logger.error({ jobId, err: unexpectedErr }, "Unhandled rejection from pipeline");
      // Try to mark the job as failed so the frontend stops polling
      try {
        const job = getJob(jobId);
        if (job && job.status !== "done") {
          job.status = "error";
          job.logs.push({ level: "error", message: "Internal server error during conversion." });
        }
      } catch {
        // ignore store errors
      }
    });

    res.json({ jobId, status: "pending" });
  });
});

// POST /api/convert/:jobId/report — records a user-reported conversion issue
router.post("/convert/:jobId/report", (req: Request, res: Response): void => {
  const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  const job = getJob(jobId);

  if (!job) {
    res.status(404).json({ error: "Conversion not found." });
    return;
  }

  if (job.status !== "done" || !job.analysis) {
    res.status(400).json({ error: "Reports are available after a conversion completes." });
    return;
  }

  const body =
    typeof req.body === "object" && req.body !== null
      ? (req.body as Record<string, unknown>)
      : {};
  const problem = typeof body.problem === "string" ? body.problem.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";

  if (!problem) {
    res.status(400).json({ error: "Please describe what went wrong." });
    return;
  }

  if (problem.length > MAX_REPORT_LENGTH) {
    res.status(400).json({ error: `Report details must be ${MAX_REPORT_LENGTH} characters or fewer.` });
    return;
  }

  if (email && (email.length > 254 || !REPORT_EMAIL_PATTERN.test(email))) {
    res.status(400).json({ error: "Please enter a valid email address or leave it blank." });
    return;
  }

  const reportId = generateJobId();
  const report = saveConversionIssueReport({
    reportId,
    jobId,
    problem,
    ...(email ? { email } : {}),
    analysis: job.analysis,
  });

  logger.info(
    {
      event: "conversion_issue_report",
      ...report,
    },
    "Conversion issue report received",
  );

  res.status(201).json({
    ok: true,
    reportId,
    message: "Report saved to persistent storage.",
  });
});

// GET /api/convert/:jobId/status — poll for status and logs
router.get("/convert/:jobId/status", (req: Request, res: Response): void => {
  const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  const job = getJob(jobId);

  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }

  res.json({
    jobId: job.jobId,
    status: job.status,
    logs: job.logs,
    analysis: job.analysis,
  });
});

// GET /api/convert/:jobId/download — download the result zip
router.get("/convert/:jobId/download", (req: Request, res: Response): void => {
  const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  const job = getJob(jobId);

  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }

  if (job.status !== "done" || !job.outputZipPath) {
    res.status(404).json({ error: "Job is not complete yet." });
    return;
  }

  if (!fs.existsSync(job.outputZipPath)) {
    res.status(404).json({ error: "Output file not found on server." });
    return;
  }

  res.download(job.outputZipPath, "replit-to-local.zip");
});

// Express error handler for this router (catches any errors that reach here)
router.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
  const message = err instanceof Error ? err.message : "Unexpected error";
  logger.error({ err }, "Unhandled error in convert router");
  res.status(500).json({ error: message });
});

export default router;
