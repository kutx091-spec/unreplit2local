import type { StackInfo } from "./detect-stack.js";
import type { ReplitConfig } from "./parse-replit.js";

export interface OutputFiles {
  "run.sh": string;
  "run.bat": string;
  ".env.example": string;
  "README.md": string;
}

// Replit-internal variables that have no meaning outside Replit.
// These must NOT appear in .env.example — they're not values users can supply.
const REPLIT_INTERNAL_KEYS = new Set([
  "REPL_ID",
  "REPL_SLUG",
  "REPL_OWNER",
  "REPL_PUBKEYS",
  "REPL_IMAGE",
  "REPL_LANGUAGE",
  "REPL_CLUSTER",
  "REPL_HOME",
  "REPLIT_DB_URL",
  "REPLIT_DOMAINS",
  "REPLIT_DEV_DOMAIN",
  "REPLIT_NIX_CHANNEL",
]);

const SECRET_PATTERNS = ["DATABASE_URL", "SECRET", "API_KEY", "TOKEN", "PASSWORD", "PRIVATE"];
const SYSTEM_ENV_KEYS = new Set(["PATH"]);

function isSecret(key: string): boolean {
  return SECRET_PATTERNS.some((p) => key.includes(p));
}

function isUsableEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && /[A-Za-z0-9]$/.test(key);
}

function isApplicationEnvKey(key: string): boolean {
  return isUsableEnvKey(key) && !REPLIT_INTERNAL_KEYS.has(key) && !SYSTEM_ENV_KEYS.has(key);
}

function containsUnresolvedEnvReference(value: string): boolean {
  return /\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)|%[A-Za-z_][A-Za-z0-9_]*%/.test(
    value,
  );
}

function getNodeInstallCommand(stack: StackInfo): string {
  if (stack.packageManager === "pnpm") {
    return stack.hasPackageLockfile ? "pnpm install --frozen-lockfile" : "pnpm install";
  }
  if (stack.packageManager === "yarn") {
    return stack.hasPackageLockfile ? "yarn install --frozen-lockfile" : "yarn install";
  }
  return stack.hasPackageLockfile ? "npm ci" : "npm install";
}

function getStartCommands(stack: StackInfo, fallbackStartCommand: string): string[] {
  if (stack.startCommands.length > 0) return stack.startCommands;
  if (fallbackStartCommand.startsWith("echo 'No start command")) return [];
  return [fallbackStartCommand];
}

function getPrimaryStartCommand(stack: StackInfo): string {
  if (stack.startCommands.length > 0) return stack.startCommands[0];
  if (stack.hasNode && stack.nodeStartCommand) return stack.nodeStartCommand;
  if (stack.hasPython && stack.pythonEntrypoint) {
    return `python3 ${stack.pythonEntrypoint}`;
  }
  return "echo 'No start command detected — check your package.json scripts or .replit file'";
}

function getStandalonePythonEntrypoint(stack: StackInfo): string | null {
  if (!stack.pythonEntrypoint || stack.startCommandHandlesPython) return null;

  const entrypoint = stack.pythonEntrypoint.replace(/\\/g, "/");
  const nodeManagedScripts = new Set([
    ...stack.spawnedPythonScripts,
    ...stack.startCommandPythonScripts,
  ].map((script) => script.replace(/\\/g, "/")));

  // Node owns the lifecycle of Python scripts it spawns. Starting one here
  // would duplicate on-demand handlers and persistent bridge processes alike.
  if (nodeManagedScripts.has(entrypoint)) return null;

  return stack.pythonEntrypoint;
}

/**
 * Convert POSIX-style leading environment assignments into valid batch syntax.
 * For example, "export PORT=3000 && npm run dev" becomes
 * "set PORT=3000 && npm run dev".
 */
export function convertUnixEnvAssignmentsToBat(command: string): string {
  let remaining = command.trim();
  const assignments: string[] = [];

  while (true) {
    const match = remaining.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s&]+)(?:(?:\s*&&\s*)|(?:\s+))(.+)$/,
    );
    if (!match) break;

    const [, key, rawValue, rest] = match;
    const value =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1)
        : rawValue;
    assignments.push(`set ${key}=${value}`);
    remaining = rest;
  }

  return assignments.length > 0
    ? `${assignments.join(" && ")} && ${remaining}`
    : command;
}

function buildRunSh(
  startCommand: string,
  stack: StackInfo,
  replitConfig: ReplitConfig,
): string {
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "set -e",
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'cd "$SCRIPT_DIR"',
    "",
    "# Create .env from the template on first run",
    'if [ ! -f .env ] && [ -f .env.example ]; then',
    "  cp .env.example .env",
    "  echo 'Created .env from .env.example. Review it and fill in any real values required by the project (keys, database URLs, etc.).'",
    "fi",
    "",
    "# Load .env if it exists",
    'if [ -f .env ]; then',
    '  export $(grep -v "^#" .env | xargs)',
    "fi",
    "",
  ];

  // Export non-secret env vars from .replit [env]
  for (const [key, value] of Object.entries(replitConfig.envVars)) {
    if (isApplicationEnvKey(key) && !isSecret(key) && !containsUnresolvedEnvReference(value)) {
      lines.push(`export ${key}="${value}"`);
    }
  }
  if (Object.keys(replitConfig.envVars).length > 0) lines.push("");

  if (stack.hasPython) {
    lines.push("# Set up Python virtual environment");
    lines.push('if [ ! -d ".venv" ]; then');
    lines.push("  echo 'Creating virtual environment...'");
    lines.push("  python3 -m venv .venv");
    lines.push("fi");
    lines.push("");
    lines.push("# Activate venv");
    lines.push('source ".venv/bin/activate"');
    lines.push("");
    lines.push("# Install Python dependencies");
    lines.push("echo 'Installing Python dependencies...'");
    // requirements.txt → pip install -r (exact pins)
    // pyproject.toml with detected deps → install by name (avoids pip install . failures)
    // pyproject.toml without detected deps → pip install . as last resort
    lines.push("if [ -f requirements.txt ]; then");
    lines.push("  pip install -r requirements.txt --quiet");
    lines.push("elif [ -f pyproject.toml ]; then");
    if (stack.pythonDependencies.length > 0) {
      lines.push(`  pip install ${stack.pythonDependencies.join(" ")} --quiet`);
    } else {
      lines.push("  pip install . --quiet");
    }
    lines.push("fi");
    lines.push("");
  }

  if (stack.hasNode) {
    lines.push("# Install Node.js dependencies");
    lines.push('if [ ! -d node_modules ]; then');
    lines.push("  echo 'Installing Node dependencies...'");
    lines.push(`  ${getNodeInstallCommand(stack)} --silent`);
    lines.push("fi");
    lines.push("");
  }

  // If hybrid with child_process.spawn, ensure the venv Python is on the path
  if (stack.isHybrid && stack.hasChildProcessSpawn) {
    lines.push("# Ensure spawned Python subprocesses use the venv interpreter");
    lines.push('export PYTHON="$SCRIPT_DIR/.venv/bin/python"');
    lines.push("");
  }

  lines.push("echo 'Starting app...'");

  const startCommands = getStartCommands(stack, startCommand);
  const standalonePythonEntrypoint = getStandalonePythonEntrypoint(stack);
  if (stack.isHybrid) {
    lines.push("");
    if (standalonePythonEntrypoint) {
      lines.push("# Start Python process in background");
      lines.push(`python3 ${standalonePythonEntrypoint} &`);
      lines.push("PYTHON_PID=$!");
      lines.push("");
      lines.push("# Kill background Python when Node exits");
      lines.push('trap "kill $PYTHON_PID 2>/dev/null" EXIT');
      lines.push("");
    }
    if (startCommands.length === 1) {
      lines.push("# Start Node process (foreground)");
      lines.push(startCommands[0]);
    } else if (startCommands.length > 1) {
      lines.push("# Start all Node services in parallel");
      startCommands.forEach((command, index) => {
        lines.push(`echo 'Starting service ${index + 1}: ${command.replace(/'/g, "'\\''")}'`);
        lines.push(`${command} &`);
      });
      lines.push("wait");
    } else {
      lines.push("echo 'No start command detected — check README.md'");
      lines.push("exit 1");
    }
  } else {
    if (startCommands.length === 1) {
      lines.push(startCommands[0]);
    } else if (startCommands.length > 1) {
      lines.push("# Start all services in parallel");
      startCommands.forEach((command, index) => {
        lines.push(`echo 'Starting service ${index + 1}: ${command.replace(/'/g, "'\\''")}'`);
        lines.push(`${command} &`);
      });
      lines.push("wait");
    } else {
      lines.push("echo 'No start command detected — check README.md'");
      lines.push("exit 1");
    }
  }

  return lines.join("\n") + "\n";
}

function buildRunBat(
  startCommand: string,
  stack: StackInfo,
  replitConfig: ReplitConfig,
): string {
  const lines: string[] = [
    "@echo off",
    "setlocal",
    "cd /d %~dp0",
    "",
    "REM Create .env from the template on first run",
    'if not exist ".env" if exist ".env.example" (',
    '  copy /Y ".env.example" ".env" >nul',
    "  echo Created .env from .env.example. Review it and fill in any real values required by the project (keys, database URLs, etc.).",
    ")",
    "",
    "REM Load .env if it exists",
    "if exist .env (",
    "  for /f \"tokens=* delims=\" %%a in (.env) do (",
    "    set %%a",
    "  )",
    ")",
    "",
  ];

  for (const [key, value] of Object.entries(replitConfig.envVars)) {
    if (isApplicationEnvKey(key) && !isSecret(key) && !containsUnresolvedEnvReference(value)) {
      lines.push(`set ${key}=${value}`);
    }
  }
  if (Object.keys(replitConfig.envVars).length > 0) lines.push("");

  if (stack.hasPython) {
    lines.push("REM Set up Python virtual environment");
    lines.push("if not exist .venv (");
    lines.push("  echo Creating virtual environment...");
    lines.push("  python -m venv .venv");
    lines.push(")");
    lines.push("");
    lines.push("REM Activate venv");
    lines.push("call .venv\\Scripts\\activate.bat");
    lines.push("");
    lines.push("REM Install Python dependencies");
    lines.push("echo Installing Python dependencies...");
    lines.push("if exist requirements.txt (");
    lines.push("  pip install -r requirements.txt --quiet");
    lines.push(") else if exist pyproject.toml (");
    if (stack.pythonDependencies.length > 0) {
      lines.push(`  pip install ${stack.pythonDependencies.join(" ")} --quiet`);
    } else {
      lines.push("  pip install . --quiet");
    }
    lines.push(")");
    lines.push("");
  }

  if (stack.hasNode) {
    lines.push("REM Install Node.js dependencies");
    lines.push("if not exist node_modules (");
    lines.push("  echo Installing Node dependencies...");
    lines.push(`  ${getNodeInstallCommand(stack)} --silent`);
    lines.push(")");
    lines.push("");
  }

  lines.push("echo Starting app...");

  const startCommands = getStartCommands(stack, startCommand);
  const batStartCommands = startCommands.map((command) => {
    const delegatedScript = stack.delegatedScripts[command];
    if (!delegatedScript) return convertUnixEnvAssignmentsToBat(command);

    const convertedScript = convertUnixEnvAssignmentsToBat(delegatedScript.rawScript);
    if (convertedScript === delegatedScript.rawScript) {
      return command;
    }

    const packageDir = delegatedScript.packageDir.replace(/\//g, "\\");
    return `cd /d "${packageDir}" && ${convertedScript}`;
  });
  const standalonePythonEntrypoint = getStandalonePythonEntrypoint(stack);
  if (stack.isHybrid && standalonePythonEntrypoint) {
    lines.push("");
    lines.push("REM Start Python process in a separate window");
    lines.push(`start "Python" .venv\\Scripts\\python.exe ${standalonePythonEntrypoint}`);
    lines.push("");
    lines.push("REM Start Node process");
  }

  if (batStartCommands.length === 1) {
    lines.push(batStartCommands[0]);
  } else if (batStartCommands.length > 1) {
    lines.push("REM Start all services in parallel");
    batStartCommands.forEach((command, index) => {
      lines.push(`echo Starting service ${index + 1}: ${command}`);
      lines.push(`start "Service ${index + 1}" cmd /c "${command}"`);
    });
  } else {
    lines.push("echo No start command detected - check README.md");
    lines.push("exit /b 1");
  }
  lines.push("");
  lines.push("endlocal");

  return lines.join("\r\n") + "\r\n";
}

function buildEnvExample(envKeys: string[], replitConfig: ReplitConfig): string {
  // Merge code-scanned keys with .replit [env] keys, stripping Replit-internal ones
  const userKeys = new Set([
    ...envKeys.filter(isApplicationEnvKey),
    ...Object.keys(replitConfig.envVars).filter(
      isApplicationEnvKey,
    ),
  ]);
  const hasExplicitPort = Object.prototype.hasOwnProperty.call(replitConfig.envVars, "PORT");
  if (!hasExplicitPort && replitConfig.localPort !== null) userKeys.add("PORT");

  if (userKeys.size === 0) return "# No environment variables detected\n";

  const lines = ["# Copy this file to .env and fill in the values", ""];

  for (const key of userKeys) {
    // Show the real default value from .replit [env] when it's not a secret
    const defaultValue =
      replitConfig.envVars[key] ??
      (key === "PORT" && replitConfig.localPort !== null
        ? String(replitConfig.localPort)
        : undefined);
    if (
      defaultValue &&
      !isSecret(key) &&
      !containsUnresolvedEnvReference(defaultValue)
    ) {
      lines.push(`${key}=${defaultValue}`);
    } else {
      // Secrets and code-detected-only keys get a blank placeholder
      lines.push(`${key}=`);
    }
  }

  return lines.join("\n") + "\n";
}

function buildReadme(
  stack: StackInfo,
  replitConfig: ReplitConfig,
  startCommand: string,
  analysis: {
    needsDatabase: boolean;
    orphanedScripts: string[];
    replitPlugins: string[];
    nixPackages: string[];
    runtimes: string[];
  }
): string {
  const lines: string[] = [
    "# Replit-to-Local Conversion",
    "",
    "## Run",
    "",
    "**Linux/macOS:**",
    "`./run.sh`",
    "",
    "**Windows:**",
    "`run.bat`",
    "",
    "That's it — the script installs dependencies and starts the app automatically.",
    "",
    "---",
    "",
    "This project was exported from Replit and converted to run locally.",
    "",
    "## Quick Start",
    "",
  ];

  if (stack.hasPython || stack.hasNode) {
    lines.push("### Prerequisites");
    lines.push("");
    if (stack.hasPython) lines.push("- Python 3.10+ installed");
    if (stack.hasNode) lines.push(`- Node.js 18+ and ${stack.packageManager} installed`);
    lines.push("");
  }

  lines.push("### Run the app");
  lines.push("");
  lines.push("**Mac/Linux:**");
  lines.push("```bash");
  lines.push("chmod +x run.sh");
  lines.push("./run.sh");
  lines.push("```");
  lines.push("");
  lines.push("**Windows:**");
  lines.push("```");
  lines.push("run.bat");
  lines.push("```");
  lines.push("");
  if (stack.startCommands.length > 1) {
    lines.push("This project contains multiple services. `run.sh` and `run.bat` start them in parallel.");
    lines.push("");
    lines.push("To start them manually:");
    lines.push("```bash");
    for (const command of stack.startCommands) lines.push(command);
    lines.push("```");
  } else {
    lines.push("Or manually:");
    lines.push("```bash");
    lines.push(startCommand);
    lines.push("```");
  }
  lines.push("");

  if (stack.envKeys.length > 0 || Object.keys(replitConfig.envVars).length > 0) {
    lines.push("## Environment Variables");
    lines.push("");
    lines.push("Copy `.env.example` to `.env` and fill in the required values:");
    lines.push("```bash");
    lines.push("cp .env.example .env");
    lines.push("```");
    lines.push("");
  }

  if (analysis.needsDatabase) {
    lines.push("## ⚠️  Database Required");
    lines.push("");
    lines.push(
      "This project needs a PostgreSQL database. Set up a local Postgres instance or use a free hosted service like [Neon](https://neon.tech) or [Supabase](https://supabase.com), then add the connection URL to your `.env`:"
    );
    lines.push("");
    lines.push("```");
    lines.push("DATABASE_URL=postgresql://user:password@host:5432/dbname");
    lines.push("```");
    lines.push("");
  }

  if (stack.isHybrid) {
    lines.push("## Hybrid Stack (Node + Python)");
    lines.push("");
    lines.push(
      "This project uses both Node.js and Python. The generated scripts prepare both runtimes and start the detected application commands."
    );
    if (stack.spawnedPythonScripts.length > 0) {
      lines.push("");
      lines.push(
        `Node controls \`${stack.spawnedPythonScripts.join("`, `")}\` via \`child_process\`; the generated startup scripts do not launch these Python scripts separately. The venv Python is exported as \`$PYTHON\` so the spawn call resolves correctly.`
      );
    }
    lines.push("");
  }

  if (stack.startCommands.length > 1) {
    lines.push("## Multiple Services");
    lines.push("");
    lines.push(
      "This is a multi-service project. The generated startup scripts launch all detected services in parallel:",
    );
    lines.push("");
    for (const command of stack.startCommands) {
      lines.push(`- \`${command}\``);
    }
    lines.push("");
  }

  if (analysis.replitPlugins.length > 0) {
    lines.push("## ⚠️  Replit-specific Packages");
    lines.push("");
    lines.push(
      "The following `@replit/*` packages are imported unconditionally. If the build fails, you may need to remove or replace them:"
    );
    lines.push("");
    for (const plugin of analysis.replitPlugins) {
      lines.push(`- \`${plugin}\``);
    }
    lines.push("");
  }

  if (analysis.orphanedScripts.length > 0) {
    lines.push("## Orphaned Scripts");
    lines.push("");
    lines.push(
      "The following Python files are not imported or spawned from the detected entry point and are likely not part of the running app. Their dependencies were not included:"
    );
    lines.push("");
    for (const script of analysis.orphanedScripts) {
      lines.push(`- \`${script}\``);
    }
    lines.push("");
  }

  if (analysis.nixPackages.length > 0) {
    lines.push("## System Packages (Nix)");
    lines.push("");
    lines.push(
      "This project declared these Nix packages in `.replit`. Most are Replit environment tools and may not be needed locally. Install if your app fails to start:"
    );
    lines.push("");
    for (const pkg of analysis.nixPackages) {
      lines.push(`- \`${pkg}\``);
    }
    lines.push("");
  }

  lines.push("## Detected Stack");
  lines.push("");
  lines.push(
    `- **Stacks:** ${stack.hasNode && stack.hasPython ? "Node.js + Python (hybrid)" : stack.hasNode ? "Node.js" : "Python"}`
  );
  if (replitConfig.runCommand) {
    lines.push(`- **Original Replit command:** \`${replitConfig.runCommand}\``);
  }
  if (stack.nodeStartCommand) {
    lines.push(`- **Node start command:** \`${stack.nodeStartCommand}\``);
  }
  if (analysis.runtimes.length > 0) {
    lines.push(`- **Runtimes declared in .replit:** ${analysis.runtimes.join(", ")}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("*Generated by [Replit-to-Local](https://github.com)*");

  return lines.join("\n") + "\n";
}

export function generateOutputFiles(
  stack: StackInfo,
  replitConfig: ReplitConfig
): OutputFiles {
  // The detector is the only source of truth for start commands.
  const startCommand = getPrimaryStartCommand(stack);

  const analysis = {
    needsDatabase: stack.needsDatabase,
    orphanedScripts: stack.orphanedScripts,
    replitPlugins: stack.replitPlugins,
    nixPackages: replitConfig.nixPackages,
    runtimes: replitConfig.modules,
  };

  return {
    "run.sh": buildRunSh(startCommand, stack, replitConfig),
    "run.bat": buildRunBat(startCommand, stack, replitConfig),
    ".env.example": buildEnvExample(stack.envKeys, replitConfig),
    "README.md": buildReadme(stack, replitConfig, startCommand, analysis),
  };
}
