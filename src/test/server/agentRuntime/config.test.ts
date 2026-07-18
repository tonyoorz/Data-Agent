import { describe, expect, it } from "vitest";
import { createRuntimeConfig } from "../../../../server/agentRuntime/config.mjs";

describe("Phase 1 Runtime config", () => {
  it("allows DEV identity only on loopback", () => {
    expect(createRuntimeConfig({ MAIN_AGENT_IDENTITY_MODE: "dev", VIZION_API_HOST: "127.0.0.1" }).host).toBe("127.0.0.1");
    expect(() => createRuntimeConfig({ MAIN_AGENT_IDENTITY_MODE: "dev", VIZION_API_HOST: "0.0.0.0" })).toThrow(/DEV_IDENTITY_REQUIRES_LOOPBACK/);
    expect(() => createRuntimeConfig({ MAIN_AGENT_IDENTITY_MODE: "dev", VIZION_DEV_HOST: "0.0.0.0" })).toThrow(/DEV_IDENTITY_REQUIRES_LOOPBACK/);
  });

  it("requires a trusted TLS proxy before LAN binding", () => {
    expect(() => createRuntimeConfig({ VIZION_API_HOST: "0.0.0.0", MAIN_AGENT_IDENTITY_MODE: "trusted-proxy" })).toThrow(/LAN_BIND_REQUIRES_TRUSTED_TLS_PROXY/);
    const config = createRuntimeConfig({
      VIZION_API_HOST: "0.0.0.0",
      VIZION_DEV_HOST: "127.0.0.1",
      MAIN_AGENT_IDENTITY_MODE: "trusted-proxy",
      MAIN_AGENT_TRUSTED_PROXY_ADDRESSES: "10.0.0.10,::1",
      MAIN_AGENT_ALLOWED_ORIGINS: "https://vizion.example",
      MAIN_AGENT_TRUST_PROXY_TLS: "true",
    });
    expect(config).toMatchObject({
      host: "0.0.0.0",
      devHost: "127.0.0.1",
      identityMode: "trusted-proxy",
      allowedOrigins: ["https://vizion.example"],
      trustedProxyAddresses: ["10.0.0.10", "::1"],
      jsonBodyMaxBytes: 1024 * 1024,
    });
  });

  it("rejects invalid modes and numeric limits", () => {
    expect(() => createRuntimeConfig({ MAIN_AGENT_RUNTIME_MODE: "made-up" })).toThrow(/INVALID_MAIN_AGENT_RUNTIME_MODE/);
    expect(() => createRuntimeConfig({ MAIN_AGENT_IDENTITY_MODE: "cookie" })).toThrow(/INVALID_MAIN_AGENT_IDENTITY_MODE/);
    expect(() => createRuntimeConfig({ MAIN_AGENT_JSON_BODY_MAX_BYTES: "0" })).toThrow(/INVALID_MAIN_AGENT_JSON_BODY_MAX_BYTES/);
  });

  it("returns a stable server-authoritative canary decision", () => {
    const config = createRuntimeConfig({ MAIN_AGENT_RUNTIME_MODE: "canary", MAIN_AGENT_CANARY_PERCENTAGE: "10", MAIN_AGENT_CANARY_ACTOR_ALLOWLIST: "always-v2" });

    expect(config.resolveRuntimeDecision("always-v2")).toEqual({ runtimeMode: "langgraph", agentApiEnabled: true, serverControlled: true });
    expect(config.resolveRuntimeDecision("actor-42")).toEqual(config.resolveRuntimeDecision("actor-42"));
    expect(config.resolveRuntimeDecision("actor-42").agentApiEnabled).toBe(config.resolveRuntimeMode("actor-42") === "langgraph");
    expect(createRuntimeConfig({ MAIN_AGENT_RUNTIME_MODE: "canary", MAIN_AGENT_CANARY_PERCENTAGE: "0" }).resolveRuntimeDecision("actor-42")).toEqual({ runtimeMode: "legacy", agentApiEnabled: false, serverControlled: true });
  });
});
