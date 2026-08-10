import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import * as devHelpers from "../../../scripts/devHelpers.mjs";

import {
  getTerminationCommand,
  hasHealthyServiceOnPort,
  hasTcpServiceOnPort,
  hasViteDevServerOnPort,
  waitForHealthyService,
} from "../../../scripts/devHelpers.mjs";

describe("resolveLocalApiEnvironment", () => {
  it("defaults an unset local API authentication mode to internal", () => {
    expect(devHelpers.resolveLocalApiEnvironment).toBeTypeOf("function");
    expect(devHelpers.resolveLocalApiEnvironment({})).toMatchObject({
      VIZION_AGENT_AUTH_MODE: "internal",
    });
  });

  it("adds an actor capability secret for the implicit local internal mode", () => {
    const localEnv = devHelpers.resolveLocalApiEnvironment({});

    expect(localEnv.VIZION_AGENT_ACTOR_CAPABILITY_SECRET).toEqual(expect.any(String));
    expect(localEnv.VIZION_AGENT_ACTOR_CAPABILITY_SECRET.trim()).not.toBe("");
  });

  it("adds the DTSV China row scope for the implicit local internal mode", () => {
    const localEnv = devHelpers.resolveLocalApiEnvironment({});

    expect(localEnv.VIZION_INTERNAL_TEAM_IDS).toBe("DTSV_China");
  });

  it("preserves an explicitly configured local internal row scope", () => {
    const localEnv = devHelpers.resolveLocalApiEnvironment({ VIZION_INTERNAL_PROJECT_IDS: "IDCEVO" });

    expect(localEnv.VIZION_INTERNAL_PROJECT_IDS).toBe("IDCEVO");
    expect(localEnv.VIZION_INTERNAL_TEAM_IDS).toBeUndefined();
  });

  it("adds the operations read policy for the implicit local internal mode", () => {
    const localEnv = devHelpers.resolveLocalApiEnvironment({});

    expect(localEnv.VIZION_INTERNAL_ROW_POLICY_IDS).toBe("agent.operations.read");
  });

  it("preserves an explicitly configured local internal row policy", () => {
    const localEnv = devHelpers.resolveLocalApiEnvironment({ VIZION_INTERNAL_ROW_POLICY_IDS: "quality-readonly" });

    expect(localEnv.VIZION_INTERNAL_ROW_POLICY_IDS).toBe("quality-readonly");
  });

  it("does not add a development actor capability secret to explicit OIDC mode", () => {
    const localEnv = devHelpers.resolveLocalApiEnvironment({ VIZION_AGENT_AUTH_MODE: "oidc" });

    expect(localEnv.VIZION_AGENT_ACTOR_CAPABILITY_SECRET).toBeUndefined();
    expect(localEnv.VIZION_INTERNAL_ROW_POLICY_IDS).toBeUndefined();
  });

  it("treats a blank local API authentication mode as unset", () => {
    expect(devHelpers.resolveLocalApiEnvironment({ VIZION_AGENT_AUTH_MODE: "   " })).toMatchObject({
      VIZION_AGENT_AUTH_MODE: "internal",
    });
  });

  it.each(["oidc", "internal"])("preserves the explicitly configured %s local API authentication mode", (authMode) => {
    expect(devHelpers.resolveLocalApiEnvironment({ VIZION_AGENT_AUTH_MODE: authMode })).toMatchObject({
      VIZION_AGENT_AUTH_MODE: authMode,
    });
  });
});

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