import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadLocalEnv } from "../server/loadLocalEnv.mjs";
import { resolveAnalyticsTaskEnvironment } from "./devHelpers.mjs";
import { assertSupportedNodeVersion } from "./nodeVersion.mjs";
import { assertSupportedPythonCommand, resolvePythonCommand } from "./pythonRuntime.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv();
assertSupportedNodeVersion();

const pythonCommand = resolvePythonCommand({ root: repoRoot, env: process.env });
const childEnvironment = resolveAnalyticsTaskEnvironment(process.env);
assertSupportedPythonCommand(pythonCommand, { env: childEnvironment });

const child = spawn(pythonCommand, process.argv.slice(2), {
  cwd: repoRoot,
  env: childEnvironment,
  stdio: "inherit",
  shell: false,
});

child.once("error", () => {
  process.exitCode = 1;
});
child.once("close", (code) => {
  process.exitCode = Number.isInteger(code) ? code : 1;
});
