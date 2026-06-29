import { describe, expect, it } from "vitest";

import {
  getTerminationCommand,
  hasHealthyServiceOnPort,
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