import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadLocalEnv } from "../server/loadLocalEnv.mjs";
import { resolveCheckoutPackageEntrypoint } from "../server/nodeDependencyBoundary.mjs";
import { resolveViteChildEnvironment } from "./devHelpers.mjs";
import { assertSupportedNodeVersion } from "./nodeVersion.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv();
assertSupportedNodeVersion();

const viteEntrypoint = resolveCheckoutPackageEntrypoint(repoRoot, "vite", "bin/vite.js");
const child = spawn(process.execPath, [viteEntrypoint], {
  cwd: repoRoot,
  env: resolveViteChildEnvironment(process.env),
  stdio: "inherit",
  shell: false,
});

child.once("error", () => {
  process.exitCode = 1;
});
child.once("close", (code) => {
  process.exitCode = Number.isInteger(code) ? code : 1;
});
