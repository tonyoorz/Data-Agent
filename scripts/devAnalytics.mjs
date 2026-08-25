import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadLocalEnv } from "../server/loadLocalEnv.mjs";
import { resolveAnalyticsChildEnvironment, resolveDevelopmentPort } from "./devHelpers.mjs";
import { assertSupportedNodeVersion } from "./nodeVersion.mjs";
import { assertSupportedPythonCommand, resolvePythonCommand } from "./pythonRuntime.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv();
assertSupportedNodeVersion();

const configuredPort = resolveDevelopmentPort(
  process.env.VIZION_ANALYTICS_PORT,
  3003,
  "VIZION_ANALYTICS_PORT",
);
const pythonCommand = resolvePythonCommand({ root: repoRoot, env: process.env });
const analyticsChildEnvironment = resolveAnalyticsChildEnvironment(process.env);
assertSupportedPythonCommand(pythonCommand, { env: analyticsChildEnvironment });

const child = spawn(pythonCommand, [
  "-m",
  "uvicorn",
  "backend.analytics.api:app",
  "--host",
  "127.0.0.1",
  "--port",
  String(configuredPort),
], {
  cwd: repoRoot,
  env: analyticsChildEnvironment,
  stdio: "inherit",
  shell: false,
});

child.once("error", () => {
  process.exitCode = 1;
});
child.once("close", (code) => {
  process.exitCode = Number.isInteger(code) ? code : 1;
});
