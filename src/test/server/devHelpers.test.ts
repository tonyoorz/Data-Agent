import { describe, expect, it } from "vitest";

import {
  getTerminationCommand,
  hasHealthyServiceOnPort,
  hasViteDevServerOnPort,
  waitForHealthyService,
} from "../../../scripts/devHelpers.mjs";

describe("getTerminationCommand", () => {
  it("uses taskkill tree termination on Windows", () => {
    expect(getTerminationCommand("win32", 4321)).toEqual({
      command: "taskkill",
      args: ["/PID", "4321", "/T", "/F"],
    });
  });

  it("uses signal-based termination on non-Windows platforms", () => {
    expect(getTerminationCommand("linux", 4321, "SIGINT")).toEqual({
      command: null,
      args: ["SIGINT"],
    });
  });

  it("returns null for invalid pids", () => {
    expect(getTerminationCommand("win32", 0)).toBeNull();
  });
});

describe("hasViteDevServerOnPort", () => {
  it("returns true when the Vite client endpoint responds", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      hasViteDevServerOnPort({
        port: 8080,
        fetchImpl,
      }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8080/@vite/client");
  });

  it("returns false when the Vite client endpoint is unavailable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connection refused"));

    await expect(
      hasViteDevServerOnPort({
        port: 8080,
        fetchImpl,
      }),
    ).resolves.toBe(false);
  });
});

describe("hasHealthyServiceOnPort", () => {
  it("returns true when the health endpoint reports ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, service: "analytics" }),
    });

    await expect(
      hasHealthyServiceOnPort({
        port: 3003,
        expectedService: "analytics",
        fetchImpl,
      }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:3003/health");
  });

  it("returns false when the health payload does not match the expected service", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, service: "other" }),
    });

    await expect(
      hasHealthyServiceOnPort({
        port: 3003,
        expectedService: "analytics",
        fetchImpl,
      }),
    ).resolves.toBe(false);
  });

  it("returns false when the port is invalid", async () => {
    const fetchImpl = vi.fn();

    await expect(
      hasHealthyServiceOnPort({
        port: 0,
        fetchImpl,
      }),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("waitForHealthyService", () => {
  it("waits for a service to become healthy", async () => {
    const isHealthy = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(waitForHealthyService(isHealthy, { attempts: 3, delayMs: 0 })).resolves.toBe(true);
    expect(isHealthy).toHaveBeenCalledTimes(2);
  });

  it("returns false when the service never becomes healthy", async () => {
    const isHealthy = vi.fn().mockResolvedValue(false);

    await expect(waitForHealthyService(isHealthy, { attempts: 3, delayMs: 0 })).resolves.toBe(false);
    expect(isHealthy).toHaveBeenCalledTimes(3);
  });
});