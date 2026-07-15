import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  getTerminationCommand,
  hasHealthyServiceOnPort,
  hasTcpServiceOnPort,
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
  it("returns true when the Vite root responds", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      hasViteDevServerOnPort({
        port: 8080,
        fetchImpl,
        timeoutMs: 0,
      }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8080/");
  });

  it("returns false when the Vite root is unavailable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connection refused"));

    await expect(
      hasViteDevServerOnPort({
        port: 8080,
        fetchImpl,
        timeoutMs: 0,
      }),
    ).resolves.toBe(false);
  });

  it("uses an abort signal when a timeout is configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      hasViteDevServerOnPort({
        port: 8080,
        fetchImpl,
        timeoutMs: 1000,
      }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/",
      expect.objectContaining({ signal: expect.any(Object) }),
    );
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
        timeoutMs: 0,
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
        timeoutMs: 0,
      }),
    ).resolves.toBe(false);
  });

  it("returns false when the port is invalid", async () => {
    const fetchImpl = vi.fn();

    await expect(
      hasHealthyServiceOnPort({
        port: 0,
        fetchImpl,
        timeoutMs: 0,
      }),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("hasTcpServiceOnPort", () => {
  it("returns true when a TCP connection can be opened", async () => {
    const socket = new EventEmitter();
    socket.setTimeout = vi.fn();
    socket.destroy = vi.fn();
    const connectImpl = vi.fn(() => socket);

    const result = hasTcpServiceOnPort({ port: 3003, connectImpl });
    socket.emit("connect");

    await expect(result).resolves.toBe(true);
    expect(connectImpl).toHaveBeenCalledWith({ host: "127.0.0.1", port: 3003 });
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("returns false when a TCP connection fails", async () => {
    const socket = new EventEmitter();
    socket.setTimeout = vi.fn();
    socket.destroy = vi.fn();
    const connectImpl = vi.fn(() => socket);

    const result = hasTcpServiceOnPort({ port: 3003, connectImpl });
    socket.emit("error", new Error("connection refused"));

    await expect(result).resolves.toBe(false);
    expect(socket.destroy).toHaveBeenCalled();
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