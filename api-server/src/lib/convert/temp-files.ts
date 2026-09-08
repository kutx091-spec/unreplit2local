import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const JOB_WORK_DIR_PREFIX = "rtl-";
export const UPLOAD_DIR = path.join(os.tmpdir(), "replit-to-local-uploads");

export function ensureUploadDir(): void {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

export function removeWorkDir(workDir: string): void {
  fs.rmSync(workDir, { recursive: true, force: true });
}

/**
 * Jobs are kept in memory, so no job can still be active when a fresh
 * process starts. Remove temp files left by an interrupted previous process.
 */
export function cleanupOrphanedTempFiles(): {
  uploadEntriesRemoved: number;
  workDirsRemoved: number;
} {
  ensureUploadDir();

  let uploadEntriesRemoved = 0;
  for (const entry of fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })) {
    fs.rmSync(path.join(UPLOAD_DIR, entry.name), { recursive: true, force: true });
    uploadEntriesRemoved += 1;
  }

  let workDirsRemoved = 0;
  for (const entry of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) {
    if (!entry.name.startsWith(JOB_WORK_DIR_PREFIX)) continue;
    fs.rmSync(path.join(os.tmpdir(), entry.name), { recursive: true, force: true });
    workDirsRemoved += 1;
  }

  return { uploadEntriesRemoved, workDirsRemoved };
}