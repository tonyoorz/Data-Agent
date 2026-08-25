import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  assertSupportedPythonCommand,
  resolvePythonCommand,
  sanitizePythonEnvironment,
} from "../../../scripts/pythonRuntime.mjs";

describe("qualified Python runtime", () => {
  it("prefers the POSIX virtual environment before global Python", () => {
    const root = path.resolve("/workspace/data-agent");
    const expected = path.join(root, ".venv", "bin", "python");

    expect(resolvePythonCommand({
      root,
      env: {},
      platform: "darwin",
      existsSync: (candidate) => candidate === expected,
    })).toBe(expected);
  });

  it("uses the Windows virtual environment layout on Windows", () => {
    const root = path.resolve("C:/workspace/data-agent");
    const expected = path.join(root, ".venv", "Scripts", "python.exe");

    expect(resolvePythonCommand({
      root,
      env: {},
      platform: "win32",
      existsSync: (candidate) => candidate === expected,
    })).toBe(expected);
  });

  it("preserves an explicit Python command so a bad override fails preflight", () => {
    expect(resolvePythonCommand({
      root: "/workspace/data-agent",
      env: { VIZION_ANALYTICS_PYTHON: "/missing/python" },
      existsSync: () => false,
    })).toBe("/missing/python");
  });

  it("requires a repository virtual environment or an explicit absolute override", () => {
    expect(() => resolvePythonCommand({
      root: "/workspace/data-agent",
      env: {},
      existsSync: () => false,
    })).toThrow("PYTHON_RUNTIME_NOT_CONFIGURED");
    expect(() => resolvePythonCommand({
      root: "/workspace/data-agent",
      env: { VIZION_ANALYTICS_PYTHON: "python" },
      existsSync: () => false,
    })).toThrow("PYTHON_RUNTIME_OVERRIDE_INVALID");
  });

  it("accepts only Python 3.12", () => {
    const spawnSyncImpl = vi.fn().mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ version: [3, 12, 7], executable: "/workspace/.venv/bin/python" }),
      stderr: "",
    });

    expect(assertSupportedPythonCommand("python", { spawnSyncImpl })).toEqual({
      command: "python",
      executable: "/workspace/.venv/bin/python",
      version: "3.12.7",
    });
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "python",
      ["-c", expect.stringContaining("import duckdb,fastapi,pandas,uvicorn")],
      expect.objectContaining({ shell: false }),
    );
  });

  it.each([
    {
      status: 0,
      stdout: JSON.stringify({ version: [3, 11, 9], executable: "/python" }),
      stderr: "",
      error: "PYTHON_RUNTIME_UNSUPPORTED",
    },
    { status: 1, stdout: "", stderr: "not found", error: "PYTHON_RUNTIME_UNAVAILABLE" },
  ])("fails closed for an unqualified Python command", ({ status, stdout, stderr, error }) => {
    expect(() => assertSupportedPythonCommand("python", {
      spawnSyncImpl: () => ({ status, stdout, stderr }),
    })).toThrow(error);
  });

  it("removes interpreter-injection variables from the exact preflight environment", () => {
    const sanitized = sanitizePythonEnvironment({
      PATH: "/usr/bin",
      PYTHONHOME: "/attacker/home",
      PYTHONPATH: "/attacker/modules",
      PYTHONSTARTUP: "/attacker/startup.py",
    });

    expect(sanitized).toMatchObject({
      PATH: "/usr/bin",
      PYTHONIOENCODING: "utf-8",
      PYTHONNOUSERSITE: "1",
      PYTHONUTF8: "1",
    });
    expect(sanitized).not.toHaveProperty("PYTHONHOME");
    expect(sanitized).not.toHaveProperty("PYTHONPATH");
    expect(sanitized).not.toHaveProperty("PYTHONSTARTUP");
  });
});
