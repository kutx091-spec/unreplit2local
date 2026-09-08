import * as fs from "fs";
import * as path from "path";

export interface StackInfo {
  hasNode: boolean;
  hasPython: boolean;
  isHybrid: boolean;
  nodeStartCommand: string | null;
  pythonEntrypoint: string | null;
  startCommands: string[];
  delegatedScripts: Record<string, { packageDir: string; rawScript: string }>;
  packageManager: "pnpm" | "yarn" | "npm";
  hasPackageLockfile: boolean;
  /** Python scripts that Node invokes via child_process.spawn/exec — never orphans */
  spawnedPythonScripts: string[];
  /** Python scripts referenced directly by the selected multi-process start script */
  startCommandPythonScripts: string[];
  nodeDependencies: string[];
  pythonDependencies: string[];
  envKeys: string[];
  needsDatabase: boolean;
  orphanedScripts: string[];
  replitPlugins: string[];
  hasChildProcessSpawn: boolean;
  startCommandHandlesPython: boolean;
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

const SKIPPED_DIRS = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  ".local",
  "attached_assets",
]);

function findAllFiles(dir: string, exts: string[]): string[] {
  const results: string[] = [];
  function walk(current: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (exts.includes(ext)) {
          results.push(full);
        }
      }
    }
  }
  walk(dir);
  return results;
}

function isUsableEnvKey(key: string): boolean {
  // Reject incomplete placeholders such as NEXT_PUBLIC_ while allowing the
  // normal uppercase and mixed-case names used by Node and Python projects.
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && /[A-Za-z0-9]$/.test(key);
}

function extractEnvKeys(content: string): string[] {
  const keys = new Set<string>();
  // Node: process.env.KEY
  for (const m of content.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
    if (isUsableEnvKey(m[1])) keys.add(m[1]);
  }
  // Python: os.environ.get("KEY") or os.getenv("KEY")
  for (const m of content.matchAll(/os\.environ(?:\.get)?\(["']([A-Z_][A-Z0-9_]*)["']|os\.getenv\(["']([A-Z_][A-Z0-9_]*)["']/g)) {
    const key = m[1] ?? m[2];
    if (key && isUsableEnvKey(key)) keys.add(key);
  }
  return Array.from(keys);
}

function detectNeedsDatabase(content: string): boolean {
  const patterns = [
    /DATABASE_URL/,
    /require\(['"]pg['"]\)/,
    /from ['"]pg['"]/,
    /drizzle-orm/,
    /drizzle\(/,
    /sqlalchemy/,
    /import psycopg/,
    /import pg/,
    /postgresql/i,
  ];
  return patterns.some((p) => p.test(content));
}

function extractReplitPlugins(content: string): string[] {
  const plugins: string[] = [];
  for (const m of content.matchAll(/(?:from|require\(['"]|import\s+['"])((@replit\/[^'"]+))/g)) {
    const pkg = m[1] ?? m[2];
    if (pkg && !plugins.includes(pkg)) plugins.push(pkg);
  }
  return plugins;
}

/**
 * Extract .py file paths that Node invokes via child_process.spawn / exec / execFile / execSync.
 * Covers both literal paths and one-level variable assignments.
 * Normalises backslashes and deduplicates.
 */
function extractSpawnedPythonScripts(nodeCode: string): string[] {
  const found = new Set<string>();

  // ── 1. Direct literal in spawn / execFile array arg ──────────────────────
  // spawn('python3', ['server/brain_bridge.py', ...])
  // spawn(process.env.PYTHON || 'python3', ["worker.py"])
  for (const m of nodeCode.matchAll(
    /(?:spawn|execFile)\s*\(\s*[^,)]+,\s*\[\s*["']([^"']+\.py)["']/g
  )) {
    found.add(m[1].replace(/\\/g, "/"));
  }

  // ── 2. exec / execSync with inline python command ────────────────────────
  // exec('python3 server/brain_bridge.py --flag')
  // execSync(`python3 worker.py`)
  for (const m of nodeCode.matchAll(
    /\bexec(?:Sync)?\s*\(\s*[`"'][^`"']*python[^`"']*\s+([\w./\\-]+\.py)/g
  )) {
    found.add(m[1].replace(/\\/g, "/"));
  }

  // ── 3. Variable assigned a .py literal, then used in spawn/exec ──────────
  // const script = 'server/brain_bridge.py';       spawn('python3', [script])
  // const cmd    = 'python3 server/brain_bridge.py'; exec(cmd)
  const varLiterals = new Map<string, string>(); // varName → .py path
  for (const m of nodeCode.matchAll(
    /(?:const|let|var)\s+(\w+)\s*=\s*["'`]([^"'`]+)["'`]/g
  )) {
    const rawStr = m[2];
    // Extract just the .py path portion from the string value —
    // handles both 'path.py' and full command strings like 'python3 path.py'
    const pyInStr = rawStr.match(/((?:[\w./\\-]+\/)?[\w-]+\.py)/);
    if (pyInStr) {
      varLiterals.set(m[1], pyInStr[1].replace(/\\/g, "/"));
    }
  }
  if (varLiterals.size > 0) {
    // Check if the variable appears inside a spawn/exec call
    for (const m of nodeCode.matchAll(
      /(?:spawn|execFile|exec(?:Sync)?)\s*\([^)]{0,200}\b(\w+)\b[^)]{0,200}\)/g
    )) {
      const varName = m[1];
      if (varLiterals.has(varName)) {
        found.add(varLiterals.get(varName)!);
      }
    }
  }

  // ── 4. Any .py string literal in a file that contains spawn+python ───────
  // Fallback: if the file clearly spawns Python (has spawn/exec AND 'python')
  // and references a .py path as a string, treat it as a candidate.
  const fileSpawnsPython =
    /(?:spawn|exec(?:Sync|File)?)\s*\(/.test(nodeCode) &&
    /\bpython/.test(nodeCode);
  if (fileSpawnsPython) {
    for (const m of nodeCode.matchAll(/["'`]((?:[\w./\\-]+\/)?[\w-]+\.py)["'`]/g)) {
      const p = m[1].replace(/\\/g, "/");
      // Skip obvious non-path strings (no directory separator AND common non-script names)
      if (!p.includes("/") && ["requirements.py", "setup.py"].includes(p)) continue;
      found.add(p);
    }
  }

  return Array.from(found);
}

function extractPythonScriptsFromCommand(command: string): string[] {
  const found = new Set<string>();
  for (const match of command.matchAll(
    /(?:^|[\s"'`])((?:[\w./\\-]+\/)?[\w-]+\.py)(?=$|[\s"'`])/g,
  )) {
    found.add(match[1].replace(/\\/g, "/"));
  }
  return Array.from(found);
}

interface PythonImportReference {
  level: number;
  module: string;
  importedNames: string[];
}

function parsePythonImportedNames(rawNames: string): string[] {
  return rawNames
    .replace(/#.*$/, "")
    .replace(/[()]/g, "")
    .split(",")
    .map((name) => name.trim().split(/\s+as\s+/i)[0]?.trim() ?? "")
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(name));
}

/**
 * Extract Python import statements without trying to import or execute project code.
 * The result is intentionally syntax-focused; callers resolve only modules that
 * correspond to real .py files in the project.
 */
function extractPythonImportReferences(pythonCode: string): PythonImportReference[] {
  const references: PythonImportReference[] = [];
  let remaining = pythonCode;

  // Handle parenthesised imports such as:
  // from utils.helpers import (
  //   format_greeting,
  // )
  const parenthesisedFromImport = /^\s*from\s+(\.*)([A-Za-z_][A-Za-z0-9_.]*)?\s+import\s*\(([\s\S]*?)\)/gm;
  for (const match of pythonCode.matchAll(parenthesisedFromImport)) {
    references.push({
      level: match[1].length,
      module: match[2] ?? "",
      importedNames: parsePythonImportedNames(match[3]),
    });
  }
  remaining = remaining.replace(parenthesisedFromImport, "");

  // import utils.helpers, another_module as alias
  const importStatement = /^\s*import\s+([^\n#]+)/gm;
  for (const match of remaining.matchAll(importStatement)) {
    for (const rawName of match[1].split(",")) {
      const module = rawName.trim().split(/\s+as\s+/i)[0]?.trim() ?? "";
      if (/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(module)) {
        references.push({ level: 0, module, importedNames: [] });
      }
    }
  }

  // from utils.helpers import format_greeting
  // from .helpers import format_greeting
  // from . import helpers
  const fromImportStatement =
    /^\s*from\s+(\.*)([A-Za-z_][A-Za-z0-9_.]*)?\s+import\s+([^\n#]+)/gm;
  for (const match of remaining.matchAll(fromImportStatement)) {
    references.push({
      level: match[1].length,
      module: match[2] ?? "",
      importedNames: parsePythonImportedNames(match[3]),
    });
  }

  return references;
}

function moduleNameForPythonFile(projectDir: string, filePath: string): string {
  const relative = path.relative(projectDir, filePath).replace(/\\/g, "/");
  const withoutExtension = relative.replace(/\.py$/, "");
  if (withoutExtension === "__init__") return "";
  if (withoutExtension.endsWith("/__init__")) {
    return withoutExtension.slice(0, -"/__init__".length).replace(/\//g, ".");
  }
  return withoutExtension.replace(/\//g, ".");
}

function resolvePythonImportModules(
  importerPath: string,
  projectDir: string,
  reference: PythonImportReference,
): string[] {
  const importerRelative = path.relative(projectDir, importerPath).replace(/\\/g, "/");
  const importerParts = importerRelative.replace(/\.py$/, "").split("/");
  const packageParts = importerParts.slice(0, -1);
  const moduleParts = reference.module ? reference.module.split(".") : [];

  let baseParts: string[];
  if (reference.level > 0) {
    baseParts = packageParts.slice(0, Math.max(0, packageParts.length - (reference.level - 1)));
  } else {
    baseParts = [];
  }

  const importedModule = [...baseParts, ...moduleParts].filter(Boolean).join(".");
  const moduleBases = new Set<string>();
  if (importedModule) moduleBases.add(importedModule);

  // A script launched as `python server/brain_service.py` puts `server/` on
  // Python's import path, so `from agi_brain_v035 import ...` can resolve to
  // server/agi_brain_v035.py even though the import is not package-qualified.
  if (reference.level === 0 && packageParts.length > 0 && moduleParts.length > 0) {
    moduleBases.add([...packageParts, ...moduleParts].join("."));
  }

  const modules: string[] = [];
  for (const moduleBase of moduleBases) {
    modules.push(moduleBase);
    // `from utils import helpers` refers to utils.helpers, while
    // `from flask import Flask` produces no local module and is ignored later.
    for (const importedName of reference.importedNames) {
      if (importedName === "*") continue;
      modules.push([moduleBase, importedName].filter(Boolean).join("."));
    }
  }

  return modules;
}

function parsePythonDependencies(projectDir: string): string[] {
  // requirements.txt
  const req = readFileSafe(path.join(projectDir, "requirements.txt"));
  if (req) {
    return req
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split(/[>=<!=;]/)[0].trim())
      .filter(Boolean);
  }

  // pyproject.toml — read only [project.dependencies] or [tool.poetry.dependencies],
  // deliberately ignore [tool.uv.sources] (Replit-generated index mappings)
  const pyproject = readFileSafe(path.join(projectDir, "pyproject.toml"));
  if (pyproject) {
    const deps: string[] = [];

    // [project.dependencies] — PEP 517 / PEP 621 style
    const projectDepsMatch = pyproject.match(/\[project\.dependencies\]\s*\n([\s\S]*?)(?=\n\[|$)/);
    if (projectDepsMatch) {
      for (const line of projectDepsMatch[1].split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("[")) {
          const pkgName = trimmed.replace(/^["']/, "").split(/[>=<;!'"]/)[0].trim();
          if (pkgName) deps.push(pkgName);
        }
      }
    }

    // dependencies = [...] array form (also PEP 621)
    if (deps.length === 0) {
      const arrayMatch = pyproject.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m);
      if (arrayMatch) {
        for (const m of arrayMatch[1].matchAll(/["']([A-Za-z0-9_-]+)/g)) {
          deps.push(m[1]);
        }
      }
    }

    // [tool.poetry.dependencies]
    const poetryDepsMatch = pyproject.match(/\[tool\.poetry\.dependencies\]\s*\n([\s\S]*?)(?=\n\[|$)/);
    if (poetryDepsMatch) {
      for (const line of poetryDepsMatch[1].split("\n")) {
        const trimmed = line.trim();
        if (
          trimmed &&
          !trimmed.startsWith("#") &&
          !trimmed.startsWith("[") &&
          trimmed.includes("=")
        ) {
          const pkgName = trimmed.split("=")[0].trim();
          if (pkgName && pkgName !== "python") deps.push(pkgName);
        }
      }
    }

    if (deps.length) return deps;
  }

  return [];
}

interface NodeStartInfo {
  start: string | null;
  deps: string[];
  startCommandPythonScripts: string[];
  startCommandHandlesPython: boolean;
}

function expandNodeScriptReferences(
  command: string,
  scripts: Record<string, unknown>,
  seen = new Set<string>(),
): string {
  return command.replace(
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?([A-Za-z0-9:_-]+)/g,
    (reference, scriptName: string) => {
      const script = scripts[scriptName];
      if (typeof script !== "string" || seen.has(scriptName)) return reference;

      const nextSeen = new Set(seen);
      nextSeen.add(scriptName);
      return expandNodeScriptReferences(script, scripts, nextSeen);
    },
  );
}

function parseNodeDependencies(projectDir: string): NodeStartInfo {
  const pkg = readFileSafe(path.join(projectDir, "package.json"));
  if (!pkg) {
    return {
      start: null,
      deps: [],
      startCommandPythonScripts: [],
      startCommandHandlesPython: false,
    };
  }
  try {
    const parsed = JSON.parse(pkg) as Record<string, unknown>;
    const scripts = (parsed["scripts"] as Record<string, unknown> | undefined) ?? {};
    const entries = Object.entries(scripts).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    const orchestration = entries.find(([name, command]) => {
      const isMultiProcess = /\b(concurrently|npm-run-all|run-p|parallel-shell)\b/i.test(command);
      const isFullScript = /(?:full|all|both|parallel|concurrent)/i.test(name);
      return isMultiProcess && (isFullScript || /\bpython(?:3)?\b/i.test(command));
    });
    const selected = orchestration ?? entries.find(([name]) => name === "dev" || name === "start");
    const start = selected?.[1] ?? null;
    const expandedStart = start ? expandNodeScriptReferences(start, scripts) : "";
    const allDeps = {
      ...((parsed["dependencies"] as Record<string, string>) ?? {}),
      ...((parsed["devDependencies"] as Record<string, string>) ?? {}),
    };
    return {
      start,
      deps: Object.keys(allDeps),
      startCommandPythonScripts: expandedStart
        ? extractPythonScriptsFromCommand(expandedStart)
        : [],
      startCommandHandlesPython:
        /\bpython(?:3)?\b/i.test(expandedStart) &&
        /\b(concurrently|npm-run-all|run-p|parallel-shell)\b|&&|&/i.test(expandedStart),
    };
  } catch {
    return {
      start: null,
      deps: [],
      startCommandPythonScripts: [],
      startCommandHandlesPython: false,
    };
  }
}

function chooseNodeStartScript(
  scripts: Record<string, unknown>,
): [name: string, command: string] | null {
  const entries = Object.entries(scripts).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  const orchestration = entries.find(([name, command]) => {
    const isMultiProcess = /\b(concurrently|npm-run-all|run-p|parallel-shell)\b/i.test(command);
    const isFullScript = /(?:full|all|both|parallel|concurrent)/i.test(name);
    return isMultiProcess && (isFullScript || /\bpython(?:3)?\b/i.test(command));
  });
  return orchestration ?? entries.find(([name]) => name === "dev" || name === "start") ?? null;
}

function findPackageJsons(projectDir: string): string[] {
  const files: string[] = [];
  function walk(current: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && entry.name === "package.json") {
        files.push(full);
      }
    }
  }
  walk(projectDir);
  return files;
}

function detectPackageManager(projectDir: string): StackInfo["packageManager"] {
  if (
    fs.existsSync(path.join(projectDir, "pnpm-workspace.yaml")) ||
    fs.existsSync(path.join(projectDir, "pnpm-lock.yaml"))
  ) {
    return "pnpm";
  }
  if (fs.existsSync(path.join(projectDir, "yarn.lock"))) return "yarn";
  return "npm";
}

interface WorkspaceStartCommands {
  commands: string[];
  delegatedScripts: Record<string, { packageDir: string; rawScript: string }>;
}

function readWorkspaceStartCommands(projectDir: string): WorkspaceStartCommands {
  const packageFiles = findPackageJsons(projectDir);
  const rootPackage = path.join(projectDir, "package.json");
  const commands: string[] = [];
  const delegatedScripts: WorkspaceStartCommands["delegatedScripts"] = {};

  for (const packageFile of packageFiles) {
    const content = readFileSafe(packageFile);
    if (!content) continue;
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const scripts = (parsed.scripts as Record<string, unknown> | undefined) ?? {};
      const selected = chooseNodeStartScript(scripts);
      if (!selected) continue;
       const [scriptName, rawScript] = selected;

      const relativeDir = path.relative(projectDir, path.dirname(packageFile)).replace(/\\/g, "/");
      const isRoot = packageFile === rootPackage;
      const name = typeof parsed.name === "string" ? parsed.name : null;

      if (isRoot) {
        commands.push(`__ROOT__${scriptName}`);
      } else if (name) {
         const marker = `__PACKAGE_FILTER__${name}__${scriptName}`;
         commands.push(marker);
         delegatedScripts[marker] = {
           packageDir: relativeDir || ".",
           rawScript,
         };
      } else if (relativeDir) {
        commands.push(`__PACKAGE_DIR__${relativeDir}__${scriptName}`);
      }
    } catch {
      // Ignore malformed package manifests; the root pipeline will report no command.
    }
  }

  return { commands, delegatedScripts };
}

function readDocumentedStartCommands(projectDir: string): string[] {
  const commands: string[] = [];
  for (const filename of ["replit.md", "REPLIT.md"]) {
    const content = readFileSafe(path.join(projectDir, filename));
    if (!content) continue;
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line
        .trim()
        .replace(/^[-*]\s+/, "")
        .replace(/^`|`$/g, "");
      const match = trimmed.match(
        /^(?:(?:pnpm|yarn|npm)\s+(?:--filter\s+\S+\s+)?(?:run\s+)?(?:dev|start)|(?:node|python3?|uv\s+run)\s+\S+.*)$/
      );
      if (match) commands.push(trimmed.replace(/[`'"]/g, ""));
    }
  }
  return commands;
}

function isConverterInternalFile(projectDir: string, filePath: string): boolean {
  const relative = path.relative(projectDir, filePath).replace(/\\/g, "/");
  return (
    relative === "artifacts/api-server/src/lib/convert" ||
    relative.startsWith("artifacts/api-server/src/lib/convert/")
  );
}

interface ResolvedStartCommands {
  commands: string[];
  delegatedScripts: StackInfo["delegatedScripts"];
}

function resolveStartCommands(
  projectDir: string,
  packageManager: StackInfo["packageManager"],
  configuredCommands: string[],
): ResolvedStartCommands {
  const packageDetection = readWorkspaceStartCommands(projectDir);
  const packageCommands = packageDetection.commands;
  const documentedCommands = readDocumentedStartCommands(projectDir);
  const raw =
    configuredCommands.length > 0
      ? [...configuredCommands, ...documentedCommands]
      : [...documentedCommands, ...packageCommands];

  const normalizeMarker = (command: string): string =>
    command
      .replace(/^__ROOT__(.+)$/, `${packageManager} run $1`)
      .replace(/^__PACKAGE_FILTER__(.+)__([a-zA-Z0-9:_-]+)$/, `${packageManager} --filter $1 run $2`)
      .replace(/^__PACKAGE_DIR__(.+)__([a-zA-Z0-9:_-]+)$/, `cd $1 && ${packageManager} run $2`);

  // Replit often keeps "npm run dev" in .replit even when package.json has a
  // more complete dev:full/concurrently script. Preserve any leading POSIX
  // env assignments but point the configured command at the full script.
  const fullRootMarker = packageCommands.find((command) =>
    /^__ROOT__(?:.*(?:full|all|both|parallel|concurrent))/i.test(command),
  );
  const fullRootCommand = fullRootMarker ? normalizeMarker(fullRootMarker) : null;
  const adjustedConfiguredCommands =
    fullRootCommand && configuredCommands.length > 0
      ? configuredCommands.map((command) => {
          const envPrefix = command.match(/^((?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+)/)?.[1] ?? "";
          const bareCommand = command.slice(envPrefix.length);
          const isConventionalStart = /^(?:pnpm|yarn|npm)\s+(?:run\s+)?(?:dev|start)$/.test(
            bareCommand,
          );
          return isConventionalStart ? `${envPrefix}${fullRootCommand}` : command;
        })
      : configuredCommands;
  const adjustedRaw =
    configuredCommands.length > 0
      ? [...adjustedConfiguredCommands, ...documentedCommands]
      : [...documentedCommands, ...packageCommands];
  const commands = adjustedRaw.length > 0 ? adjustedRaw : packageCommands;

  const normalized = commands.map(normalizeMarker);
  const delegatedScripts = Object.fromEntries(
    Object.entries(packageDetection.delegatedScripts).map(([marker, delegatedScript]) => [
      normalizeMarker(marker),
      delegatedScript,
    ]),
  );

  // Deduplicate after normalization: documented commands are already concrete
  // while package.json commands start as internal filter markers.
  return {
    commands: Array.from(new Set(normalized)),
    delegatedScripts,
  };
}

function commandForEntrypoint(entrypoint: string): string {
  const normalized = entrypoint.trim().replace(/\\/g, "/");
  const quoted = /\s/.test(normalized) ? `"${normalized.replace(/"/g, '\\"')}"` : normalized;
  if (/\.(?:mjs|cjs|js|jsx|ts|tsx)$/i.test(normalized)) return `node ${quoted}`;
  if (/\.py$/i.test(normalized)) return `python3 ${quoted}`;
  return `./${quoted}`;
}

export function detectStack(
  projectDir: string,
  configuredCommands: string[] = [],
  entrypoint: string | null = null,
): StackInfo {
  const hasNode = fs.existsSync(path.join(projectDir, "package.json"));
  const hasPython =
    fs.existsSync(path.join(projectDir, "requirements.txt")) ||
    fs.existsSync(path.join(projectDir, "pyproject.toml")) ||
    fs.existsSync(path.join(projectDir, "main.py")) ||
    fs.existsSync(path.join(projectDir, "app.py")) ||
    (!!entrypoint &&
      /\.py$/i.test(entrypoint) &&
      fs.existsSync(path.resolve(projectDir, entrypoint)));

  const nodeInfo: NodeStartInfo = hasNode
    ? parseNodeDependencies(projectDir)
    : {
        start: null,
        deps: [],
        startCommandPythonScripts: [],
        startCommandHandlesPython: false,
      };
  const pythonDeps = hasPython ? parsePythonDependencies(projectDir) : [];
  const packageManager = detectPackageManager(projectDir);
  const hasPackageLockfile =
    fs.existsSync(path.join(projectDir, "pnpm-lock.yaml")) ||
    fs.existsSync(path.join(projectDir, "yarn.lock")) ||
    fs.existsSync(path.join(projectDir, "package-lock.json"));
  const resolvedStart = hasNode
    ? resolveStartCommands(projectDir, packageManager, configuredCommands)
    : { commands: configuredCommands, delegatedScripts: {} };
  const resolvedStartCommands = resolvedStart.commands;
  const startCommands =
    resolvedStartCommands.length > 0
      ? resolvedStartCommands
      : entrypoint
        ? [commandForEntrypoint(entrypoint)]
        : resolvedStartCommands;
  const startCommandHandlesPython =
    nodeInfo.startCommandHandlesPython ||
    startCommands.some(
      (command) =>
        /\bpython(?:3)?\b/i.test(command) &&
        /\b(concurrently|npm-run-all|run-p|parallel-shell)\b|&&|&/i.test(command),
    );

  // Collect source files
  const jsFiles = findAllFiles(projectDir, [".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"]).filter(
    (file) => !isConverterInternalFile(projectDir, file),
  );
  const pyFiles = findAllFiles(projectDir, [".py"]).filter(
    (file) => !isConverterInternalFile(projectDir, file),
  );

  // ── Step 1: find Python scripts that Node explicitly spawns ─────────────────
  // Collect raw references from spawn/exec calls, then resolve each one to the
  // actual project-relative path using the real pyFiles list.
  //
  // Spawn calls often use just a filename ('brain_bridge.py') while the file
  // lives in a subdirectory ('server/brain_bridge.py').  Without resolution,
  // fs.existsSync fails → pythonEntrypoint falls back to main.py, and the
  // spawnedNorm set never matches the real relative path → false orphan.
  const rawSpawned: string[] = [];
  if (hasNode) {
    for (const f of jsFiles) {
      const content = readFileSafe(f);
      if (content) rawSpawned.push(...extractSpawnedPythonScripts(content));
    }
  }
  const rawStartCommandPython = nodeInfo.startCommandPythonScripts;

  // Build a basename → full absolute path index from all real .py files
  const pyByBasename = new Map<string, string>(); // basename (no ext) → absolute path
  for (const f of pyFiles) {
    pyByBasename.set(path.basename(f, ".py"), f);
  }

  // Resolve each raw reference to a project-relative path
  const resolvedSet = new Set<string>();
  const resolvePythonReferences = (rawReferences: string[]): Set<string> => {
    const resolved = new Set<string>();
    for (const raw of rawReferences) {
      const exactAbs = path.join(projectDir, raw);
      if (fs.existsSync(exactAbs)) {
        resolved.add(path.relative(projectDir, exactAbs).replace(/\\/g, "/"));
      } else {
        const basename = path.basename(raw, ".py");
        const abs = pyByBasename.get(basename);
        if (abs) {
          resolved.add(path.relative(projectDir, abs).replace(/\\/g, "/"));
        }
      }
    }
    return resolved;
  };

  for (const raw of rawSpawned) {
    const exactAbs = path.join(projectDir, raw);
    if (fs.existsSync(exactAbs)) {
      // Exact match (spawn used a full relative path like 'server/brain_bridge.py')
      resolvedSet.add(path.relative(projectDir, exactAbs).replace(/\\/g, "/"));
    } else {
      // Basename-only match (spawn used just 'brain_bridge.py')
      const basename = path.basename(raw, ".py");
      const abs = pyByBasename.get(basename);
      if (abs) {
        resolvedSet.add(path.relative(projectDir, abs).replace(/\\/g, "/"));
      }
    }
  }
  // spawnedPythonScripts now contains resolved, project-relative paths — single source of truth
  const spawnedPythonScripts = Array.from(resolvedSet);
  const startCommandPythonScripts = Array.from(resolvePythonReferences(rawStartCommandPython));

  // ── Step 2: Python entrypoint ────────────────────────────────────────────────
  // Use the resolved spawned paths (guaranteed to exist and be project-relative).
  // Only fall back to guessed names if no spawn was detected or resolved.
  let pythonEntrypoint: string | null = null;
  if (hasPython) {
    if (spawnedPythonScripts.length > 0) {
      pythonEntrypoint = spawnedPythonScripts[0];
    } else if (startCommandPythonScripts.length > 0) {
      pythonEntrypoint = startCommandPythonScripts[0];
    } else {
      // Fallback to conventional filenames
      for (const candidate of ["app.py", "server.py", "run.py", "main.py"]) {
        if (fs.existsSync(path.join(projectDir, candidate))) {
          pythonEntrypoint = candidate;
          break;
        }
      }
    }
  }

  // ── Step 3: scan all source code ────────────────────────────────────────────
  const allCode: string[] = [];
  for (const f of [...jsFiles, ...pyFiles]) {
    const content = readFileSafe(f);
    if (content) allCode.push(content);
  }

  const combinedCode = allCode.join("\n");
  const envKeys = extractEnvKeys(combinedCode);
  const needsDatabase = detectNeedsDatabase(combinedCode);

  // Detect @replit/* imports that are NOT conditionally gated
  const replitPlugins: string[] = [];
  for (const content of allCode) {
    const plugins = extractReplitPlugins(content);
    for (const plugin of plugins) {
      const importLine = new RegExp(`import.*${plugin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(content);
      const isConditional = content.includes("REPL_ID") && content.includes(plugin);
      if (importLine && !isConditional && !replitPlugins.includes(plugin)) {
        replitPlugins.push(plugin);
      }
    }
  }

  const hasChildProcessSpawn =
    /child_process/.test(combinedCode) &&
    /spawn|exec/.test(combinedCode) &&
    /python/.test(combinedCode);

  // Resolve Python imports to real project files. This avoids treating local
  // modules such as `utils.helpers` as orphaned just because their basename
  // does not appear in a naive `import helpers` substring check.
  const pythonModuleFiles = new Map<string, string>();
  for (const pyFile of pyFiles) {
    const moduleName = moduleNameForPythonFile(projectDir, pyFile);
    if (moduleName) {
      pythonModuleFiles.set(
        moduleName,
        path.relative(projectDir, pyFile).replace(/\\/g, "/"),
      );
    }
  }

  const importedPythonFiles = new Set<string>();
  for (const pyFile of pyFiles) {
    const content = readFileSafe(pyFile);
    if (!content) continue;
    for (const reference of extractPythonImportReferences(content)) {
      for (const moduleName of resolvePythonImportModules(pyFile, projectDir, reference)) {
        const importedFile = pythonModuleFiles.get(moduleName);
        if (importedFile) importedPythonFiles.add(importedFile);
      }
    }
  }

  // ── Step 4: orphan detection ─────────────────────────────────────────────────
  // A .py file is an orphan if:
  //   - it is not the main entrypoint
  //   - it is NOT explicitly spawned by Node (those are real app components)
  //   - it is not imported anywhere through a resolvable local Python import
  const orphanedScripts: string[] = [];
  if (hasPython) {
    // Normalise spawned paths for comparison (forward slashes, relative to projectDir)
    const spawnedNorm = new Set(
      spawnedPythonScripts.map((s) => s.replace(/\\/g, "/"))
    );

    for (const pyFile of pyFiles) {
      const basename = path.basename(pyFile, ".py");
      const rel = path.relative(projectDir, pyFile).replace(/\\/g, "/");

      // Never orphan the main entrypoint or __init__ files
      if (rel === pythonEntrypoint?.replace(/\\/g, "/") || basename === "__init__") continue;

      // Never orphan a file that Node explicitly spawns
      if (spawnedNorm.has(rel) || startCommandPythonScripts.includes(rel)) continue;

      if (!importedPythonFiles.has(rel)) orphanedScripts.push(rel);
    }
  }

  return {
    hasNode,
    hasPython,
    isHybrid: hasNode && hasPython,
    nodeStartCommand: nodeInfo.start,
    pythonEntrypoint,
    startCommands,
    delegatedScripts: resolvedStart.delegatedScripts,
    packageManager,
    hasPackageLockfile,
    spawnedPythonScripts,
    startCommandPythonScripts,
    nodeDependencies: nodeInfo.deps,
    pythonDependencies: pythonDeps,
    envKeys,
    needsDatabase,
    orphanedScripts,
    replitPlugins,
    hasChildProcessSpawn,
    startCommandHandlesPython,
  };
}
