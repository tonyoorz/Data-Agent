import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getTerminationCommand } from "./devHelpers.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const children = [];
let exiting = false;

function terminateChild(child, signal = "SIGTERM") {
  if (!child || child.killed) {
    return;
  }

  const termination = getTerminationCommand(process.platform, child.pid, signal);
  if (!termination) {
    return;
  }

  if (termination.command) {
    spawnSync(termination.command, termination.args, { stdio: "ignore" });
    return;
  }

  child.kill(termination.args[0]);
}

function resolvePythonCommand() {
  const candidates = [
    process.env.VIZION_ANALYTICS_PYTHON,
    process.env.DUPSEARCH_AGENT_PYTHON,
    path.join(repoRoot, ".venv", "Scripts", "python.exe"),
    "python",
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (candidate === "python" || fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "python";
}

function launch(command, args, name) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (exiting) {
      return;
    }

    exiting = true;
    for (const proc of children) {
      if (proc !== child && !proc.killed) {
        terminateChild(proc, signal || "SIGTERM");
      }
    }
    process.exit(code ?? 0);
  });

  children.push(child);
  console.log(`[vizion-dev] started ${name}`);
}

launch(
  resolvePythonCommand(),
  [
    "-m",
    "uvicorn",
    "backend.analytics.api:app",
    "--host",
    "127.0.0.1",
    "--port",
    process.env.VIZION_ANALYTICS_PORT || "3003",
  ],
  "analytics-api",
);
launch(process.execPath, [path.join(repoRoot, "server", "index.mjs")], "local-api");
launch(process.execPath, [path.join(repoRoot, "node_modules", "vite", "bin", "vite.js")], "vite");

function shutdown(signal) {
  if (exiting) {
    return;
  }

  exiting = true;
  for (const child of children) {
    terminateChild(child, signal);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => shutdown("SIGTERM"));
