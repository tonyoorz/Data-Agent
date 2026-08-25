import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const SUPPORTED_PYTHON_VERSION = Object.freeze({ major: 3, minor: 12 });

export function resolvePythonCommand({
  root,
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  const explicit = String(env.VIZION_ANALYTICS_PYTHON || env.DUPSEARCH_AGENT_PYTHON || "").trim();
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error("PYTHON_RUNTIME_OVERRIDE_INVALID");
    return explicit;
  }

  const executable = platform === "win32" ? "python.exe" : "python";
  const directory = platform === "win32" ? "Scripts" : "bin";
  const virtualEnvironmentPython = path.join(path.resolve(root || process.cwd()), ".venv", directory, executable);
  if (existsSync(virtualEnvironmentPython)) return virtualEnvironmentPython;
  throw new Error("PYTHON_RUNTIME_NOT_CONFIGURED");
}

export function sanitizePythonEnvironment(env = process.env) {
  const sanitized = { ...(env || {}) };
  for (const key of ["PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONINSPECT", "__PYVENV_LAUNCHER__"]) {
    delete sanitized[key];
  }
  sanitized.PYTHONIOENCODING = "utf-8";
  sanitized.PYTHONUTF8 = "1";
  sanitized.PYTHONNOUSERSITE = "1";
  return sanitized;
}

export function assertSupportedPythonCommand(
  command,
  { spawnSyncImpl = spawnSync, env = process.env } = {},
) {
  const probe = [
    "import json,sys",
    "import duckdb,fastapi,pandas,uvicorn",
    "print(json.dumps({'version': list(sys.version_info[:3]), 'executable': sys.executable}))",
  ].join(";");
  const result = spawnSyncImpl(command, ["-c", probe], {
    encoding: "utf8",
    env: sanitizePythonEnvironment(env),
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  if (result?.status !== 0) {
    throw new Error("PYTHON_RUNTIME_UNAVAILABLE");
  }
  let payload;
  try {
    payload = JSON.parse(String(result.stdout || "").trim());
  } catch {
    throw new Error("PYTHON_RUNTIME_PROBE_INVALID");
  }
  const version = Array.isArray(payload?.version) ? payload.version : [];
  if (
    Number(version[0]) !== SUPPORTED_PYTHON_VERSION.major
    || Number(version[1]) !== SUPPORTED_PYTHON_VERSION.minor
  ) {
    throw new Error("PYTHON_RUNTIME_UNSUPPORTED");
  }
  return {
    command,
    executable: String(payload.executable || ""),
    version: `${version[0]}.${version[1]}.${version[2] || 0}`,
  };
}
