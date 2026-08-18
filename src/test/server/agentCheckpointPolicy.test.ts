import { describe, expect, it } from "vitest";

import {
  allowInMemoryAgentCheckpointer,
  assertAgentCheckpointFallbackAllowed,
} from "../../../server/agentCheckpointPolicy.mjs";

describe("agent checkpoint durability policy", () => {
  it("allows MemorySaver only for non-production internal development", () => {
    expect(allowInMemoryAgentCheckpointer({ VIZION_AGENT_AUTH_MODE: "internal", NODE_ENV: "development" })).toBe(true);
    expect(allowInMemoryAgentCheckpointer({ VIZION_AGENT_AUTH_MODE: "internal" })).toBe(true);
    expect(() => assertAgentCheckpointFallbackAllowed({ VIZION_AGENT_AUTH_MODE: "internal" })).not.toThrow();
  });

  it("fails closed for OIDC, default auth and any production runtime", () => {
    for (const env of [
      {},
      { VIZION_AGENT_AUTH_MODE: "oidc" },
      { VIZION_AGENT_AUTH_MODE: "internal", NODE_ENV: "production" },
      { VIZION_AGENT_AUTH_MODE: "oidc", NODE_ENV: "production" },
    ]) {
      expect(allowInMemoryAgentCheckpointer(env)).toBe(false);
      expect(() => assertAgentCheckpointFallbackAllowed(env, new Error("sqlite unavailable"))).toThrow(
        "AGENT_DURABLE_CHECKPOINTER_REQUIRED",
      );
    }
  });
});
