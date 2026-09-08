import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import unzipper from "unzipper";
import { ZipArchive } from "archiver";
import { v4 as uuidv4 } from "uuid";
import { getJob, updateJob } from "./store.js";
import { parseReplitConfig } from "./parse-replit.js";
import { detectStack } from "./detect-stack.js";
import { generateOutputFiles } from "./generate-output.js";
import type { LogLine, ProjectAnalysis } from "./types.js";
import { removeWorkDir } from "./temp-files.js";
import { logger } from "../logger.js";

// Directories/patterns to always exclude from the extracted project.
// Matched against every path segment, so they apply at any depth.
const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "__pycache__",
  ".config",
  ".cache",
  // All Replit-internal state: .local/state (agent state), .local/skills (agent library)
  ".local",
  // Uploaded assets stored by the Replit workspace, including any unzipped/ copies
  "attached_assets",
]);

const DEFAULT_MAX_ZIP_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_ZIP_COMPRESSION_RATIO = 100;

function readPositiveLimit(name: string, fallback: number): number {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

function getZipLimits(): {
  maxTotalUncompressedBytes: number;
  maxEntryUncompressedBytes: number;
  maxCompressionRatio: number;
} {
  return {
    maxTotalUncompressedBytes: readPositiveLimit(
      "MAX_ZIP_UNCOMPRESSED_BYTES",
      DEFAULT_MAX_ZIP_UNCOMPRESSED_BYTES,
    ),
    maxEntryUncompressedBytes: readPositiveLimit(
      "MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES",
      DEFAULT_MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
    ),
    maxCompressionRatio: readPositiveLimit(
      "MAX_ZIP_COMPRESSION_RATIO",
      DEFAULT_MAX_ZIP_COMPRESSION_RATIO,
    ),
  };
}

function shouldExclude(relPath: string): boolean {
  const parts = relPath.split(/[\\/]/);
  for (const seg of parts) {
    if (EXCLUDED_DIRS.has(seg)) return true;
  }
  return false;
}

function normalizeArchivePath(entryPath: string): string {
  return entryPath.replace(/\\/g, "/");
}

function isZipSymlink(file: unzipper.File): boolean {
  const unixMode = (file.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0xf000) === 0xa000;
}

function assertSafeDestination(
  projectDir: string,
  relPath: string,
  archivePath: string,
): void {
  const normalizedPath = normalizeArchivePath(relPath);
  if (
    path.posix.isAbsolute(normalizedPath) ||
    path.win32.isAbsolute(normalizedPath) ||
    /^[A-Za-z]:/.test(normalizedPath) ||
    normalizedPath.startsWith("//")
  ) {
    throw new Error(`ZIP rejected: unsafe entry path "${archivePath}".`);
  }

  const projectRoot = path.resolve(projectDir);
  const destination = path.resolve(projectRoot, normalizedPath);
  const relative = path.relative(projectRoot, destination);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`ZIP rejected: unsafe entry path "${archivePath}".`);
  }
}

function detectRootPrefix(files: unzipper.File[]): string {
  const firstFile = files.find((file) => file.type === "File");
  if (!firstFile) return "";

  const parts = normalizeArchivePath(firstFile.path).split("/");
  if (parts.length <= 1) return "";

  const candidate = parts[0] + "/";
  if (
    files.every(
      (file) =>
        normalizeArchivePath(file.path).startsWith(candidate) ||
        file.type === "Directory",
    )
  ) {
    return candidate;
  }

  return "";
}

function validateZipEntries(
  directory: unzipper.CentralDirectory,
  projectDir: string,
): string {
  const limits = getZipLimits();
  const rootPrefix = detectRootPrefix(directory.files);
  let totalUncompressedBytes = 0;

  for (const file of directory.files) {
    const archivePath = file.path;
    const normalizedArchivePath = normalizeArchivePath(archivePath);

    if (!normalizedArchivePath || normalizedArchivePath.includes("\0")) {
      throw new Error(`ZIP rejected: unsafe entry path "${archivePath}".`);
    }
    assertSafeDestination(projectDir, normalizedArchivePath, archivePath);

    if (isZipSymlink(file)) {
      throw new Error(`ZIP rejected: symbolic-link entry "${archivePath}" is not allowed.`);
    }

    const uncompressedSize = file.uncompressedSize;
    const compressedSize = file.compressedSize;
    if (
      !Number.isSafeInteger(uncompressedSize) ||
      !Number.isSafeInteger(compressedSize) ||
      uncompressedSize < 0 ||
      compressedSize < 0
    ) {
      throw new Error(`ZIP rejected: invalid size metadata for entry "${archivePath}".`);
    }

    if (uncompressedSize > limits.maxEntryUncompressedBytes) {
      throw new Error(`ZIP rejected: entry "${archivePath}" exceeds the maximum uncompressed size.`);
    }

    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
      throw new Error("ZIP rejected: total uncompressed size exceeds the configured limit.");
    }

    if (
      file.type === "File" &&
      uncompressedSize > 0 &&
      (compressedSize === 0 ||
        uncompressedSize / compressedSize > limits.maxCompressionRatio)
    ) {
      throw new Error(`ZIP rejected: suspicious compression ratio for entry "${archivePath}".`);
    }

    if (file.type !== "Directory") {
      let relPath = normalizedArchivePath;
      if (rootPrefix && relPath.startsWith(rootPrefix)) {
        relPath = relPath.slice(rootPrefix.length);
      }
      if (relPath) {
        assertSafeDestination(projectDir, relPath, archivePath);
      }
    }
  }

  return rootPrefix;
}

function log(jobId: string, level: LogLine["level"], message: string): void {
  const job = getJob(jobId);
  if (job) {
    job.logs.push({ level, message });
  }
  logger.info({ jobId, level }, message);
}

/**
 * Stream-extract the uploaded zip into projectDir.
 * Uses unzipper so only entry metadata (central directory) is loaded into memory —
 * actual file data is streamed from disk one entry at a time, not buffered in full.
 */
async function extractZip(
  zipPath: string,
  projectDir: string
): Promise<{ extracted: number; skipped: number }> {
  // Open only reads the zip's central directory (a few KB even for thousands of entries)
  const directory = await unzipper.Open.file(zipPath);
  const rootPrefix = validateZipEntries(directory, projectDir);
  fs.mkdirSync(projectDir, { recursive: true });

  let extracted = 0;
  let skipped = 0;

  for (const file of directory.files) {
    if (file.type === "Directory") continue;

    // Check the archive path before stripping a common project-root prefix.
    // Otherwise an archive rooted at "attached_assets/" could become
    // "project-file" after prefix removal and bypass the exclusion.
    if (shouldExclude(file.path)) {
      skipped++;
      continue;
    }

    let relPath = normalizeArchivePath(file.path);
    if (rootPrefix && relPath.startsWith(rootPrefix)) {
      relPath = relPath.slice(rootPrefix.length);
    }
    if (!relPath) continue;

    if (shouldExclude(relPath)) {
      skipped++;
      continue;
    }

    const destPath = path.resolve(projectDir, relPath);

    const destDir = path.dirname(destPath);
    fs.mkdirSync(destDir, { recursive: true });

    try {
      await new Promise<void>((resolve, reject) => {
        file
          .stream()
          .pipe(fs.createWriteStream(destPath))
          .on("finish", resolve)
          .on("error", reject);
      });
      extracted++;
    } catch {
      // Skip unreadable/corrupted entries silently
    }
  }

  return { extracted, skipped };
}

/**
 * Stream-pack the project directory into a zip using archiver.
 * Files are piped from disk directly into the output zip —
 * no in-memory buffer of the full zip content.
 */
async function packOutputZip(projectDir: string, outputZipPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputZipPath);
    const archive = new ZipArchive({ zlib: { level: 6 } });

    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(projectDir, "project");
    archive.finalize();
  });
}

export async function runPipeline(jobId: string, uploadedZipPath: string): Promise<void> {
  const workDir = path.join(os.tmpdir(), `rtl-${jobId}`);

  try {
    updateJob(jobId, { status: "running" });
    log(jobId, "info", "Starting conversion pipeline...");

    // ── Step 1: Extract & clean ──────────────────────────────────────────────
    log(jobId, "info", "Extracting uploaded zip (streaming — no full-file buffer)...");
    const projectDir = path.join(workDir, "project");

    const { extracted, skipped } = await extractZip(uploadedZipPath, projectDir);
    log(jobId, "info", `Extracted ${extracted} files (skipped ${skipped} excluded entries).`);

    // ── Step 2: Parse .replit ────────────────────────────────────────────────
    log(jobId, "info", "Parsing .replit configuration...");
    const replitPath = path.join(projectDir, ".replit");
    const replitContent = fs.existsSync(replitPath)
      ? fs.readFileSync(replitPath, "utf-8")
      : "";

    const replitConfig = parseReplitConfig(replitContent);

    if (replitConfig.runCommand) {
      log(jobId, "info", `  Start command: ${replitConfig.runCommand}`);
    } else {
      log(jobId, "warn", "  No run command found in .replit — will infer from package.json/pyproject.toml.");
    }
    if (replitConfig.modules.length > 0) {
      log(jobId, "info", `  Runtimes: ${replitConfig.modules.join(", ")}`);
    }
    if (replitConfig.nixPackages.length > 0) {
      log(jobId, "info", `  Nix packages declared: ${replitConfig.nixPackages.join(", ")}`);
    }

    // ── Step 3: Detect stack ─────────────────────────────────────────────────
    log(jobId, "info", "Detecting project stack...");
    const stack = detectStack(projectDir, replitConfig.runCommands, replitConfig.entrypoint);

    const detectedStacks: string[] = [];
    if (stack.hasNode) detectedStacks.push("Node.js");
    if (stack.hasPython) detectedStacks.push("Python");
    log(
      jobId,
      stack.isHybrid ? "warn" : "info",
      `  Stack: ${detectedStacks.join(" + ") || "unknown"}`
    );
    if (stack.hasNode) {
      log(jobId, "info", `  Package manager: ${stack.packageManager}`);
    }
    if (stack.startCommands.length > 0) {
      log(jobId, "info", `  Start commands detected: ${stack.startCommands.join(" | ")}`);
    } else {
      log(jobId, "warn", "  No start command detected — generated scripts will stop with a README warning.");
    }

    if (stack.isHybrid) {
      log(jobId, "info", "  Hybrid project — will generate both venv and node_modules setup.");
    }
    if (stack.needsDatabase) {
      log(jobId, "warn", "  Database dependency detected (PostgreSQL). See README for setup instructions.");
    }
    if (stack.replitPlugins.length > 0) {
      log(jobId, "warn", `  Unconditional @replit/* imports: ${stack.replitPlugins.join(", ")} — may need manual removal.`);
    }
    if (stack.orphanedScripts.length > 0) {
      log(jobId, "info", `  Orphaned scripts (not part of app): ${stack.orphanedScripts.join(", ")}`);
    }
    if (stack.hasChildProcessSpawn) {
      log(jobId, "info", "  Node→Python child_process.spawn detected — run.sh will use venv Python.");
    }
    if (stack.pythonDependencies.length > 0) {
      log(
        jobId,
        "info",
        `  Python deps: ${stack.pythonDependencies.slice(0, 8).join(", ")}${stack.pythonDependencies.length > 8 ? "..." : ""}`
      );
    }
    if (stack.nodeDependencies.length > 0) {
      log(
        jobId,
        "info",
        `  Node deps: ${stack.nodeDependencies.slice(0, 8).join(", ")}${stack.nodeDependencies.length > 8 ? "..." : ""}`
      );
    }

    // ── Step 4: Scan env keys ────────────────────────────────────────────────
    if (stack.envKeys.length > 0) {
      log(jobId, "info", `  Env variables referenced: ${stack.envKeys.join(", ")}`);
    }

    // ── Step 5: Generate output files ────────────────────────────────────────
    log(jobId, "info", "Generating run.sh, run.bat, .env.example, README.md...");
    const outputFiles = generateOutputFiles(stack, replitConfig);

    for (const [filename, content] of Object.entries(outputFiles)) {
      fs.writeFileSync(path.join(projectDir, filename), content);
    }
    log(jobId, "success", "Generated startup scripts and documentation.");

    // ── Step 6: Package final zip (streaming) ────────────────────────────────
    log(jobId, "info", "Packaging output zip (streaming)...");
    const outputZipPath = path.join(workDir, "output.zip");
    await packOutputZip(projectDir, outputZipPath);
    log(jobId, "success", "Output zip ready.");

    // ── Build analysis object ────────────────────────────────────────────────
    const stacks: string[] = [];
    if (stack.hasNode) stacks.push("node");
    if (stack.hasPython) stacks.push("python");

    const analysis: ProjectAnalysis = {
      stack: stacks,
      startCommand:
        stack.startCommands[0] ??
        (stack.pythonEntrypoint ? `python3 ${stack.pythonEntrypoint}` : null),
      startCommands: stack.startCommands,
      packageManager: stack.packageManager,
      isHybrid: stack.isHybrid,
      needsDatabase: stack.needsDatabase,
      orphanedScripts: stack.orphanedScripts,
      replitPlugins: stack.replitPlugins,
      envKeys: stack.envKeys,
      nixPackages: replitConfig.nixPackages,
      runtimes: replitConfig.modules,
    };

    updateJob(jobId, { status: "done", outputZipPath, analysis });
    log(jobId, "success", "Conversion complete! Download your zip below.");
    scheduleWorkDirCleanup(jobId, workDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ jobId, err }, "Pipeline error");
    log(jobId, "error", `Pipeline failed: ${message}`);
    updateJob(jobId, { status: "error" });
    removeWorkDir(workDir);
  } finally {
    // Clean up the uploaded zip
    try {
      fs.unlinkSync(uploadedZipPath);
    } catch {
      // ignore
    }
  }
}

const JOB_FILE_RETENTION_MS = 24 * 60 * 60 * 1000;

function scheduleWorkDirCleanup(jobId: string, workDir: string): void {
  const timer = setTimeout(() => {
    try {
      removeWorkDir(workDir);
      logger.info(
        { jobId, retentionHours: 24 },
        "Conversion files deleted after retention period",
      );
    } catch (err) {
      logger.warn({ jobId, err }, "Unable to delete conversion files after retention period");
    }
  }, JOB_FILE_RETENTION_MS);

  timer.unref();
}

export function generateJobId(): string {
  return uuidv4();
}
