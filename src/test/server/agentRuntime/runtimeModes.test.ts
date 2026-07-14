// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createAgentApp, buildProductionDependencies } from "../../../../server/app.mjs";
import { createRuntimeDbFixture } from "./runtimeDbFixture";

const capabilities = {
  nativeToolCalling: false,
  structuredOutputMode: "json_prompt",
  streaming: true,
  parallelToolCalls: false,
  contextWindow: 64000,
  maxOutputTokens: 4096,
  timeoutMs: 60000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0 },
  certificationStatus: "planner_certified",
};

describe("Runtime modes", () => {
  it("keeps legacy as default mode in injectable deps", () => {
    const app = createAgentApp({ config: { mode: "legacy", allowedOrigins: [] }, identityResolver: async () => ({ actorId: "dev" }) });
    expect(typeof app).toBe("function");
  });

  it("builds production runtime dependencies from an already migrated database", async () => {
    const fixture = await createRuntimeDbFixture();
    try {
      const deps = await buildProductionDependencies({
        env: {
          VIZION_AGENT_RUNTIME_DB: fixture.dbPath,
          MAIN_AGENT_RUNTIME_MODE: "langgraph",
          MAIN_AGENT_MODEL_RECORDS: JSON.stringify([
            {
              id: "deepseek-v4-flash",
              label: "DeepSeek",
              endpoint: "https://example.com/v1/chat/completions",
              authScheme: "ACCESSCODE",
              credentialEnv: "TEST_ACCESS_CODE",
              requestDialect: "openai_chat_completions",
              configVersion: "test-v1",
              capabilities,
            },
          ]),
          MAIN_AGENT_DEFAULT_MODEL: "deepseek-v4-flash",
          TEST_ACCESS_CODE: "secret-value",
        },
        logger: { warn: () => undefined, info: () => undefined },
      });

      expect(deps.config.mode).toBe("langgraph");
      expect(deps.modelRegistry.listPublic()).toHaveLength(1);
      expect(deps.runtime).toBeTruthy();
      await expect(deps.identityResolver({ headers: {}, socket: { remoteAddress: "127.0.0.1" } } as any)).resolves.toMatchObject({ actorId: "dev-local" });
      await deps.cleanup?.();
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed when the runtime database has not been migrated", async () => {
    await expect(
      buildProductionDependencies({
        env: {
          VIZION_AGENT_RUNTIME_DB: "database/runtime/missing-agent-runtime.db",
          MAIN_AGENT_MODEL_RECORDS: JSON.stringify([
            {
              id: "deepseek-v4-flash",
              label: "DeepSeek",
              endpoint: "https://example.com/v1/chat/completions",
              authScheme: "ACCESSCODE",
              credentialEnv: "TEST_ACCESS_CODE",
              requestDialect: "openai_chat_completions",
              configVersion: "test-v1",
              capabilities,
            },
          ]),
          TEST_ACCESS_CODE: "secret-value",
        },
        logger: { warn: () => undefined, info: () => undefined },
      }),
    ).rejects.toThrow(/RUNTIME_SCHEMA_NOT_READY/);
  });
});