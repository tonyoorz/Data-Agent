import { describe, expect, it, vi } from "vitest";
import { createModelRegistry } from "../../../../server/agentRuntime/modelRegistry.mjs";

const capability = {
  nativeToolCalling: true,
  structuredOutputMode: "json_prompt",
  streaming: true,
  parallelToolCalls: false,
  contextWindow: 32000,
  maxOutputTokens: 4096,
  timeoutMs: 30000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0 },
  certificationStatus: "planner_certified",
};

const records = [
  {
    id: "bacon",
    label: "Bacon",
    endpoint: "https://internal.example/bacon/chat/completions",
    authScheme: "ACCESSCODE",
    credentialEnv: "MAIN_AGENT_ACCESS_CODE",
    requestDialect: "internal_chat_completions",
    configVersion: "test-v1",
    capabilities: { ...capability, certificationStatus: "planner_candidate" },
  },
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    endpoint: "https://internal.example/deepseek/chat/completions",
    authScheme: "ACCESSCODE",
    credentialEnv: "MAIN_AGENT_ACCESS_CODE",
    requestDialect: "internal_chat_completions",
    configVersion: "test-v1",
    capabilities: capability,
  },
];

const registryEnv = {
  MAIN_AGENT_MODEL_RECORDS: JSON.stringify(records),
  MAIN_AGENT_DEFAULT_MODEL: "deepseek-v4-flash",
  MAIN_AGENT_ACCESS_CODE: "secret-code",
};

const baconRecord = records.find((record) => record.id === "bacon");
const deepseekRecord = records.find((record) => record.id === "deepseek-v4-flash");

describe("main Agent model registry", () => {
  it("prefers MAIN_AGENT settings and exposes no secrets", () => {
    const warn = vi.fn();
    const registry = createModelRegistry({ env: registryEnv, logger: { warn } });

    expect(registry.defaultModelId).toBe("deepseek-v4-flash");
    expect(registry.require("deepseek-v4-flash", { purpose: "planning" }).credential).toBe("secret-code");
    expect(registry.require("bacon", { purpose: "render" }).credential).toBe("secret-code");
    expect(() => registry.require("bacon", { purpose: "planning" })).toThrow(/MODEL_NOT_CERTIFIED_FOR_PLANNING/);
    expect(JSON.stringify(registry.listPublic())).not.toMatch(/secret|credential|access.?code/i);
    expect(JSON.stringify(registry.require("deepseek-v4-flash"))).not.toMatch(/secret-code/);
    expect(registry.listPublic().map((item) => item.id)).toEqual(["bacon", "deepseek-v4-flash"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps old DUPSEARCH variables as warning-only aliases", () => {
    const warn = vi.fn();
    const registry = createModelRegistry({
      env: {
        DUPSEARCH_CHAT_MODEL_OPTIONS: "deepseek-v4-flash",
        DUPSEARCH_CHAT_MODEL_ENDPOINTS: JSON.stringify({ "deepseek-v4-flash": "https://legacy.example/chat/completions" }),
        DUPSEARCH_CHAT_ACCESS_CODE: "legacy-secret",
        MAIN_AGENT_MODEL_CAPABILITIES: JSON.stringify({ "deepseek-v4-flash": capability }),
        MAIN_AGENT_MODEL_DIALECTS: JSON.stringify({ "deepseek-v4-flash": "internal_chat_completions" }),
      },
      logger: { warn },
    });

    expect(registry.defaultModelId).toBe("deepseek-v4-flash");
    expect(registry.require("deepseek-v4-flash").credential).toBe("legacy-secret");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("deprecated"));
  });

  it("rejects unknown, duplicate, or unusable models", () => {
    const registry = createModelRegistry({ env: { MAIN_AGENT_MODEL_RECORDS: JSON.stringify(records.slice(1)), MAIN_AGENT_ACCESS_CODE: "secret-code" } });
    expect(() => registry.require("missing-model")).toThrow(/MODEL_NOT_CONFIGURED/);
    expect(() => createModelRegistry({ env: { MAIN_AGENT_MODEL_RECORDS: JSON.stringify([deepseekRecord, { ...deepseekRecord, id: "DEEPSEEK-V4-FLASH" }]), MAIN_AGENT_ACCESS_CODE: "secret-code" } })).toThrow(/DUPLICATE_MODEL_ID/);
    expect(() => createModelRegistry({ env: { MAIN_AGENT_MODEL_RECORDS: JSON.stringify([{ ...deepseekRecord, endpoint: "http://internal.example/chat" }]), MAIN_AGENT_ACCESS_CODE: "secret-code" } })).toThrow(/MODEL_ENDPOINT_NOT_HTTPS/);
    expect(() => createModelRegistry({ env: { MAIN_AGENT_MODEL_RECORDS: JSON.stringify([{ ...deepseekRecord, credentialEnv: "MISSING_SECRET" }]) } })).toThrow(/MODEL_CREDENTIAL_MISSING/);
    expect(() => createModelRegistry({ env: { MAIN_AGENT_MODEL_RECORDS: JSON.stringify([{ ...deepseekRecord, requestDialect: "made_up" }]), MAIN_AGENT_ACCESS_CODE: "secret-code" } })).toThrow(/MODEL_DIALECT_INVALID/);
    const incompleteCapabilities = { ...capability };
    delete incompleteCapabilities.maxOutputTokens;
    expect(() => createModelRegistry({ env: { MAIN_AGENT_MODEL_RECORDS: JSON.stringify([{ ...deepseekRecord, capabilities: incompleteCapabilities }]), MAIN_AGENT_ACCESS_CODE: "secret-code" } })).toThrow(/MODEL_CAPABILITY_MISSING/);
    expect(() => createModelRegistry({ env: { MAIN_AGENT_MODEL_RECORDS: JSON.stringify([{ ...deepseekRecord, capabilities: { ...capability, certificationStatus: "disabled" } }]), MAIN_AGENT_ACCESS_CODE: "secret-code" } })).toThrow(/DEFAULT_MODEL_NOT_CONFIGURED/);
    expect(() => createModelRegistry({ env: { MAIN_AGENT_MODEL_RECORDS: JSON.stringify([{ ...baconRecord, capabilities: { ...baconRecord.capabilities, certificationStatus: "disabled" } }]), MAIN_AGENT_ACCESS_CODE: "secret-code" } })).toThrow(/BACON_CONFIGURATION_INCOMPLETE/);
  });

  it("allows chat-only models for render but rejects them for planning", () => {
    const registry = createModelRegistry({
      env: {
        MAIN_AGENT_MODEL_RECORDS: JSON.stringify([{ ...deepseekRecord, capabilities: { ...capability, certificationStatus: "chat_only" } }]),
        MAIN_AGENT_ACCESS_CODE: "secret-code",
      },
    });

    expect(registry.require("deepseek-v4-flash", { purpose: "render" }).id).toBe("deepseek-v4-flash");
    expect(() => registry.require("deepseek-v4-flash", { purpose: "planning" })).toThrow(/MODEL_NOT_CERTIFIED_FOR_PLANNING/);
  });

  it("requires explicit legacy endpoint, capabilities, and dialect for alias compilation", () => {
    expect(() => createModelRegistry({ env: { DUPSEARCH_CHAT_MODEL_OPTIONS: "deepseek-v4-flash", DUPSEARCH_CHAT_ACCESS_CODE: "secret" }, logger: { warn: vi.fn() } })).toThrow(/LEGACY_MODEL_ENDPOINT_MISSING|MAIN_AGENT_MODEL_CAPABILITIES_REQUIRED/);
    expect(() => createModelRegistry({
      env: {
        DUPSEARCH_CHAT_MODEL_OPTIONS: "deepseek-v4-flash",
        DUPSEARCH_CHAT_MODEL_ENDPOINTS: JSON.stringify({ "deepseek-v4-flash": "https://legacy.example/chat" }),
        DUPSEARCH_CHAT_ACCESS_CODE: "secret",
        MAIN_AGENT_MODEL_CAPABILITIES: JSON.stringify({ "deepseek-v4-flash": capability }),
      },
      logger: { warn: vi.fn() },
    })).toThrow(/MAIN_AGENT_MODEL_DIALECTS_REQUIRED/);
  });
});