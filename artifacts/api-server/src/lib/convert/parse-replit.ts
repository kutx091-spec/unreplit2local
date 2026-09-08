import { parse } from "smol-toml";

export interface ReplitConfig {
  runCommand: string | null;
  runCommands: string[];
  envVars: Record<string, string>;
  entrypoint: string | null;
  localPort: number | null;
  modules: string[];
  nixPackages: string[];
}

export function parseReplitConfig(content: string): ReplitConfig {
  let parsed: Record<string, unknown>;
  try {
    parsed = parse(content) as Record<string, unknown>;
  } catch {
    return {
      runCommand: null,
      runCommands: [],
      envVars: {},
      entrypoint: null,
      localPort: null,
      modules: [],
      nixPackages: [],
    };
  }

  // Extract all runtime commands. Keep the first one as the legacy runCommand
  // field, while runCommands is the single source for multi-service projects.
  const runCommands: string[] = [];
  const addRunCommand = (value: unknown): void => {
    if (typeof value !== "string") return;
    const command = value.trim();
    if (command && !runCommands.includes(command)) runCommands.push(command);
  };
  const addRunValue = (value: unknown): void => {
    if (typeof value === "string") {
      addRunCommand(value);
      return;
    }
    if (!Array.isArray(value)) return;

    const args = value.filter((arg): arg is string => typeof arg === "string");
    if (args.length === 0) return;

    // Replit deployment commands commonly use ["sh", "-c", "node index.js"].
    // The final argument is already the complete shell command, so preserve it
    // instead of generating an invalid unquoted `sh -c ...` string.
    if (
      args.length >= 3 &&
      /^(?:sh|bash|zsh|fish|cmd|powershell|pwsh)$/i.test(args[0]) &&
      args[1] === "-c"
    ) {
      addRunCommand(args.slice(2).join(" "));
      return;
    }

    addRunCommand(args.join(" "));
  };

  if (typeof parsed["run"] === "string") {
    addRunCommand(parsed["run"]);
  }

  // Deployment configuration can contain the actual command even when the
  // root `run` key is absent. Its value may be a string or argv-style array.
  if (parsed["deployment"] && typeof parsed["deployment"] === "object") {
    addRunValue((parsed["deployment"] as Record<string, unknown>)["run"]);
  }

  // Also look inside [[workflows.workflow]] for shell.exec tasks
  if (parsed["workflows"]) {
    const wf = parsed["workflows"] as Record<string, unknown>;
    const workflow = wf["workflow"];
    const candidates: unknown[] = Array.isArray(workflow) ? workflow : workflow ? [workflow] : [];
    for (const wfEntry of candidates) {
      if (wfEntry && typeof wfEntry === "object") {
        const tasks = (wfEntry as Record<string, unknown>)["tasks"];
        if (Array.isArray(tasks)) {
          for (const task of tasks) {
            if (
              task &&
              typeof task === "object" &&
              (task as Record<string, unknown>)["task"] === "shell.exec"
            ) {
              const args = (task as Record<string, unknown>)["args"];
              if (args && typeof args === "object") {
                const cmd = (args as Record<string, unknown>)["cmd"];
                addRunCommand(cmd);
              }
            }
          }
        }
      }
    }
  }

  // Extract env vars from [env] section
  const envVars: Record<string, string> = {};
  if (parsed["env"] && typeof parsed["env"] === "object") {
    for (const [k, v] of Object.entries(parsed["env"] as Record<string, unknown>)) {
      if (typeof v === "string") {
        envVars[k] = v;
      }
    }
  }

  const entrypoint = typeof parsed["entrypoint"] === "string"
    ? parsed["entrypoint"].trim() || null
    : null;

  // Prefer a port exposed to the web over an arbitrary secondary port.
  // `localPort` is the port applications bind to on the local machine.
  let localPort: number | null = null;
  if (Array.isArray(parsed["ports"])) {
    const portEntries = parsed["ports"].filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === "object" && !Array.isArray(entry),
    );
    const preferredPort =
      portEntries.find((entry) => Number(entry["externalPort"]) === 80) ??
      portEntries[0];
    const candidate = preferredPort?.["localPort"];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      localPort = candidate;
    } else if (typeof candidate === "string" && /^\d+$/.test(candidate.trim())) {
      localPort = Number(candidate.trim());
    }
  }

  // Extract modules list
  const modules: string[] = [];
  if (Array.isArray(parsed["modules"])) {
    for (const m of parsed["modules"]) {
      if (typeof m === "string") modules.push(m);
    }
  }

  // Extract nix packages from [nix] section
  const nixPackages: string[] = [];
  if (parsed["nix"] && typeof parsed["nix"] === "object") {
    const nix = parsed["nix"] as Record<string, unknown>;
    if (Array.isArray(nix["pkgs"])) {
      for (const p of nix["pkgs"]) {
        if (typeof p === "string") nixPackages.push(p);
      }
    }
  }

  return {
    runCommand: runCommands[0] ?? null,
    runCommands,
    envVars,
    entrypoint,
    localPort,
    modules,
    nixPackages,
  };
}
