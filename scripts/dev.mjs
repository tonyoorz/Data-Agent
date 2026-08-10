import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadLocalEnv } from "../server/loadLocalEnv.mjs";

import {
  getTerminationCommand,
  hasHealthyServiceOnPort,
  hasTcpServiceOnPort,
  hasViteDevServerOnPort,
  resolveLocalApiEnvironment,
  waitForHealthyService,
} from "./devHelpers.mjs";
import { assertSupportedNodeVersion } from "./nodeVersion.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
loadLocalEnv();
Object.assign(process.env, resolveLocalApiEnvironment(process.env));
const analyticsPort = Number(process.env.VIZION_ANALYTICS_PORT || "3003");
const apiPort = Number(process.env.VIZION_API_PORT || "3004");
const webPort = Number(process.env.VIZION_WEB_PORT || "8080");

assertSupportedNodeVersion();

const children = [];
let exiting = false;
const serviceWaitOptions = { attempts: 30, delayMs: 500 };

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

function launch(command, args, name, isHealthy) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });

  child.on("exit", async (code, signal) => {
    if (exiting) {
      return;
    }

    if (await waitForHealthyService(isHealthy, serviceWaitOptions)) {
      console.warn(`[vizion-dev] ${name} process exited but service is still healthy; keeping dev stack running`);
      return;
    }

    const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    console.error(`[vizion-dev] ${name} exited with ${reason}`);
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

async function launchIfNeeded({ name, command, args, port, expectedService, isHealthy: checkHealth }) {
  const isHealthy = checkHealth || (() => hasHealthyServiceOnPort({ port, expectedService }));

  if (await isHealthy()) {
    console.log(`[vizion-dev] reusing existing ${name} on http://127.0.0.1:${port}`);
    return;
  }

  if (await hasTcpServiceOnPort({ port })) {
    console.log(`[vizion-dev] waiting for existing ${name} on http://127.0.0.1:${port} to become healthy`);
    if (await waitForHealthyService(isHealthy, serviceWaitOptions)) {
      console.log(`[vizion-dev] reusing existing ${name} on http://127.0.0.1:${port}`);
      return;
    }

    console.error(`[vizion-dev] port ${port} is already in use, but ${name} did not report a healthy /health response`);
    exiting = true;
    for (const child of children) {
      terminateChild(child);
    }
    process.exit(1);
  }

  launch(command, args, name, isHealthy);
}

await launchIfNeeded({
  name: "analytics-api",
  command: resolvePythonCommand(),
  args: [
    "-m",
    "uvicorn",
    "backend.analytics.api:app",
    "--host",
    "127.0.0.1",
    "--port",
    String(analyticsPort),
  ],
  port: analyticsPort,
  expectedService: "analytics",
});
await launchIfNeeded({
  name: "local-api",
  command: process.execPath,
  args: [path.join(repoRoot, "server", "devLocalApi.mjs")],
  port: apiPort,
});
await launchIfNeeded({
  name: "vite",
  command: process.execPath,
  args: [path.join(repoRoot, "node_modules", "vite", "bin", "vite.js"), "--port", String(webPort)],
  port: webPort,
  isHealthy: () => hasViteDevServerOnPort({ port: webPort }),
});

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
