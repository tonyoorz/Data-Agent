import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import * as devHelpers from "../../../scripts/devHelpers.mjs";

import {
  getTerminationCommand,
  hasHealthyServiceOnPort,
  hasTcpServiceOnPort,
  hasViteDevServerOnPort,
  waitForHealthyService,
  resolveAnalyticsChildEnvironment,
  resolveAnalyticsCliEnvironment,
  resolveAnalyticsTaskEnvironment,
  resolveDevelopmentPort,
  resolveViteChildEnvironment,
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

describe("development child-process environment isolation", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/tester",
    DUPSEARCH_CHAT_API_KEY: "model-secret",
    VIZION_AGENT_ACTOR_CAPABILITY_SECRET: "capability-secret",
    VIZION_ANALYTICS_DB_PATH: "/data/analytics.db",
    VIZION_ANALYTICS_PORT: "3103",
    VIZION_API_PORT: "3104",
    VIZION_WEB_PORT: "8180",
    VIZION_OIDC_ISSUER: "https://issuer.example.test",
    VIZION_AGENT_OIDC_SCOPE_POLICY_JSON: "{\"groups\":[]}",
    VIZION_WINDOWS_HELLO_PIN: "123456",
    PYTHONHOME: "/unsafe/python-home",
    PYTHONPATH: "/unsafe/python-path",
    NODE_EXTRA_CA_CERTS: "/corp/ca.pem",
    VITE_SUPABASE_URL: "https://public.example.test",
  };

  it("keeps model credentials out of the analytics service", () => {
    const childEnv = resolveAnalyticsChildEnvironment(env);

    expect(childEnv.VIZION_AGENT_ACTOR_CAPABILITY_SECRET).toBe("capability-secret");
    expect(childEnv.VIZION_ANALYTICS_DB_PATH).toBe("/data/analytics.db");
    expect(childEnv).toMatchObject({
      PYTHONIOENCODING: "utf-8",
      PYTHONNOUSERSITE: "1",
      PYTHONUTF8: "1",
    });
    expect(childEnv).not.toHaveProperty("DUPSEARCH_CHAT_API_KEY");
    expect(childEnv).not.toHaveProperty("VIZION_OIDC_ISSUER");
    expect(childEnv).not.toHaveProperty("VIZION_AGENT_OIDC_SCOPE_POLICY_JSON");
    expect(childEnv).not.toHaveProperty("VIZION_WINDOWS_HELLO_PIN");
    expect(childEnv).not.toHaveProperty("PYTHONHOME");
    expect(childEnv).not.toHaveProperty("PYTHONPATH");
  });

  it("gives analytics CLI and ingest jobs their separate explicit data-source credentials", () => {
    const childEnv = resolveAnalyticsCliEnvironment({
      ...env,
      VIZION_FULL_PICTURE_COLD_DB_PATH: "/data/cold.duckdb",
      VIZION_FULL_PICTURE_COLD_PARQUET_DIR: "/data/parquet",
      VIZION_OCTANE_COOKIE_FILE: "/run/secrets/octane-cookie.json",
      VIZION_OCTANE_BASE_URL: "https://octane.example.test",
      VIZION_WINDOWS_HELLO_PIN: "123456",
      DUPSEARCH_CHAT_API_KEY: "model-secret",
      PYTHONNOUSERSITE: "0",
      PYTHONUTF8: "0",
    });

    expect(childEnv).toMatchObject({
      VIZION_FULL_PICTURE_COLD_DB_PATH: "/data/cold.duckdb",
      VIZION_FULL_PICTURE_COLD_PARQUET_DIR: "/data/parquet",
      VIZION_OCTANE_COOKIE_FILE: "/run/secrets/octane-cookie.json",
      VIZION_OCTANE_BASE_URL: "https://octane.example.test",
      VIZION_WINDOWS_HELLO_PIN: "123456",
      PYTHONIOENCODING: "utf-8",
      PYTHONNOUSERSITE: "1",
      PYTHONUTF8: "1",
    });
    expect(childEnv).not.toHaveProperty("DUPSEARCH_CHAT_API_KEY");
    expect(childEnv).not.toHaveProperty("VIZION_OIDC_ISSUER");
    expect(childEnv).not.toHaveProperty("VIZION_AGENT_ACTOR_CAPABILITY_SECRET");
  });

  it("keeps ingest credentials out of report and test Python tasks", () => {
    const childEnv = resolveAnalyticsTaskEnvironment({
      ...env,
      VIZION_FULL_PICTURE_COLD_DB_PATH: "/data/cold.duckdb",
      VIZION_OCTANE_COOKIE_FILE: "/run/secrets/octane-cookie.json",
      VIZION_OCTANE_LOGIN_FILE: "/run/secrets/octane-login.json",
      VIZION_WINDOWS_HELLO_PIN: "123456",
    });

    expect(childEnv).toMatchObject({
      VIZION_FULL_PICTURE_COLD_DB_PATH: "/data/cold.duckdb",
      PYTHONNOUSERSITE: "1",
    });
    expect(childEnv).not.toHaveProperty("VIZION_OCTANE_COOKIE_FILE");
    expect(childEnv).not.toHaveProperty("VIZION_OCTANE_LOGIN_FILE");
    expect(childEnv).not.toHaveProperty("VIZION_WINDOWS_HELLO_PIN");
    expect(childEnv).not.toHaveProperty("VIZION_AGENT_ACTOR_CAPABILITY_SECRET");
  });

  it("keeps server secrets out of the Vite process", () => {
    const childEnv = resolveViteChildEnvironment(env);

    expect(childEnv).toMatchObject({
      PATH: "/usr/bin",
      VIZION_ANALYTICS_PORT: "3103",
      VIZION_API_PORT: "3104",
      VIZION_WEB_PORT: "8180",
      VITE_SUPABASE_URL: "https://public.example.test",
      NODE_EXTRA_CA_CERTS: "/corp/ca.pem",
    });
    expect(childEnv).not.toHaveProperty("DUPSEARCH_CHAT_API_KEY");
    expect(childEnv).not.toHaveProperty("VIZION_AGENT_ACTOR_CAPABILITY_SECRET");
    expect(childEnv).not.toHaveProperty("VIZION_ANALYTICS_DB_PATH");
    expect(childEnv).not.toHaveProperty("NODE_OPTIONS");
  });
});

describe("development port validation", () => {
  it("uses a fallback or a validated configured port", () => {
    expect(resolveDevelopmentPort("", 3003, "VIZION_ANALYTICS_PORT")).toBe(3003);
    expect(resolveDevelopmentPort("3103", 3003, "VIZION_ANALYTICS_PORT")).toBe(3103);
  });

  it.each(["0", "65536", "3.5", "abc"])('rejects invalid port "%s"', (value) => {
    expect(() => resolveDevelopmentPort(value, 3003, "VIZION_ANALYTICS_PORT")).toThrow(
      "VIZION_ANALYTICS_PORT_INVALID",
    );
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
