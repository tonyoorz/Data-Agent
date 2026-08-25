import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadLocalEnv } from "../server/loadLocalEnv.mjs";
import { resolveCheckoutPackageEntrypoint } from "../server/nodeDependencyBoundary.mjs";

import {
  getTerminationCommand,
  hasHealthyServiceOnPort,
  hasTcpServiceOnPort,
  hasViteDevServerOnPort,
  resolveAnalyticsChildEnvironment,
  resolveDevelopmentPort,
  resolveLocalApiEnvironment,
  resolveViteChildEnvironment,
  waitForHealthyService,
} from "./devHelpers.mjs";
import { assertSupportedNodeVersion } from "./nodeVersion.mjs";
import { assertSupportedPythonCommand, resolvePythonCommand } from "./pythonRuntime.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const viteEntrypoint = resolveCheckoutPackageEntrypoint(repoRoot, "vite", "bin/vite.js");
loadLocalEnv();
Object.assign(process.env, resolveLocalApiEnvironment(process.env));
const analyticsPort = resolveDevelopmentPort(process.env.VIZION_ANALYTICS_PORT, 3003, "VIZION_ANALYTICS_PORT");
const apiPort = resolveDevelopmentPort(process.env.VIZION_API_PORT, 3004, "VIZION_API_PORT");
const webPort = resolveDevelopmentPort(process.env.VIZION_WEB_PORT, 8080, "VIZION_WEB_PORT");

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

function launch(command, args, name, isHealthy, childEnvironment = process.env) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: childEnvironment,
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

async function launchIfNeeded({
  name,
  command,
  args,
  port,
  expectedService,
  isHealthy: checkHealth,
  beforeLaunch,
  childEnvironment,
}) {
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

  beforeLaunch?.();
  launch(command, args, name, isHealthy, childEnvironment);
}

const analyticsPython = resolvePythonCommand({ root: repoRoot, env: process.env });
const analyticsChildEnvironment = resolveAnalyticsChildEnvironment(process.env);
await launchIfNeeded({
  name: "analytics-api",
  command: analyticsPython,
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
  beforeLaunch: () => assertSupportedPythonCommand(analyticsPython, { env: analyticsChildEnvironment }),
  childEnvironment: analyticsChildEnvironment,
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
  args: [viteEntrypoint, "--port", String(webPort)],
  port: webPort,
  isHealthy: () => hasViteDevServerOnPort({ port: webPort }),
  childEnvironment: resolveViteChildEnvironment(process.env),
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
