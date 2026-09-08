export type LogLevel = "info" | "warn" | "error" | "success";

export interface LogLine {
  level: LogLevel;
  message: string;
}

export type JobStatus = "pending" | "running" | "done" | "error";

export interface ProjectAnalysis {
  stack: string[];
  startCommand: string | null;
  startCommands?: string[];
  packageManager?: "pnpm" | "yarn" | "npm";
  isHybrid: boolean;
  needsDatabase: boolean;
  orphanedScripts: string[];
  replitPlugins: string[];
  envKeys: string[];
  nixPackages: string[];
  runtimes: string[];
}

export interface ConvertJob {
  jobId: string;
  status: JobStatus;
  logs: LogLine[];
  analysis?: ProjectAnalysis;
  outputZipPath?: string;
  createdAt: Date;
}

export interface ConversionIssueReport {
  reportId: string;
  jobId: string;
  problem: string;
  email?: string;
  analysis: ProjectAnalysis;
  createdAt: string;
}
