import { describe, expect, it } from "vitest";
import {
  createContractRegistry,
  EVENT_PROTOCOL_VERSION,
  GRAPH_DEFINITION_VERSION,
} from "../../../../server/agentRuntime/contracts.mjs";

const validRun = {
  schemaVersion: "1.0",
  messageId: "msg-1",
  threadId: "thread-1",
  threadVersion: 2,
  message: { role: "user", text: "DTSV 六月有多少缺陷？", artifactRefs: [] },
  selectedModel: "deepseek-v4-flash",
  pageContext: { moduleKey: "ai-chat", moduleLabel: "AI Chat" },
  useDefectContext: false,
  useAnalyticsContext: true,
  eventProtocolVersion: "1.0",
};

const validEvent = {
  schemaVersion: "1.0",
  eventId: "evt-1",
  runId: "run-1",
  threadId: "thread-1",
  stateVersion: 1,
  sequence: 1,
  timestamp: "2026-07-14T00:00:00.000Z",
  type: "run.started",
  payload: {
    threadVersion: 1,
    runtimeMode: "langgraph",
    requestedModelId: "deepseek-v4-flash",
    actualModelId: "deepseek-v4-flash",
  },
};

const legacyMessage = {
  clientMessageId: "client-msg-1",
  role: "user",
  text: "hello",
  artifactRefs: [],
  createdAt: "2026-07-14T00:00:00.000Z",
};

describe("Agent Runtime contracts", () => {
  const contracts = createContractRegistry();

  it("accepts the versioned run contract and rejects unknown input", () => {
    expect(EVENT_PROTOCOL_VERSION).toBe("1.0");
    expect(GRAPH_DEFINITION_VERSION).toBe("main-agent-v1");
    expect(contracts.validateRunRequest(validRun)).toBe(validRun);
    expect(() => contracts.validateRunRequest({ ...validRun, useAnalyticsContext: undefined })).toThrow(/useAnalyticsContext/);
    expect(() => contracts.validateRunRequest({ ...validRun, actorId: "alice" })).toThrow(/actorId|additionalProperties/);
  });

  it("enforces server-generated thread invariants", () => {
    const newThreadRun = { ...validRun, threadId: undefined, threadVersion: 0 };
    delete newThreadRun.threadId;
    expect(contracts.validateRunRequest(newThreadRun)).toBe(newThreadRun);
    expect(() => contracts.validateRunRequest({ ...newThreadRun, threadVersion: 1 })).toThrow(/threadVersion/);
    expect(() => contracts.validateRunRequest({ ...validRun, threadId: "" })).toThrow(/threadId/);
    expect(contracts.validateRunRequest({
      ...validRun,
      branch: { parentRunId: "run-parent", parentCheckpointId: "checkpoint-parent" },
    }).branch.parentRunId).toBe("run-parent");
  });

  it("validates an event by its concrete payload schema", () => {
    expect(contracts.validateAgentEvent(validEvent)).toBe(validEvent);
    expect(() => contracts.validateAgentEvent({ ...validEvent, type: "made.up" })).toThrow(/type/);
    expect(() => contracts.validateAgentEvent({
      ...validEvent,
      payload: { ...validEvent.payload, extra: true },
    })).toThrow(/extra|additionalProperties/);
    expect(() => contracts.validateAgentEvent({
      ...validEvent,
      type: "answer.delta",
      payload: { answerId: "a1", contentHash: "hash", offset: 0, text: "ok", reasoning: "private" },
    })).toThrow(/reasoning|additionalProperties/);
  });

  it("validates resume, cancel, fork and thread patch requests strictly", () => {
    expect(contracts.validateResumeRequest({ schemaVersion: "1.0", interactionId: "i1", threadVersion: 2, value: { answer: "SP25" } }).value.answer).toBe("SP25");
    expect(() => contracts.validateResumeRequest({ schemaVersion: "1.0", interactionId: "i1", threadVersion: 2, value: null, actorId: "alice" })).toThrow(/actorId|additionalProperties/);
    expect(contracts.validateCancelRequest({ schemaVersion: "1.0", threadVersion: 2, reasonCode: "user_stop" }).reasonCode).toBe("user_stop");
    expect(() => contracts.validateCancelRequest({ schemaVersion: "1.0", reasonCode: "user_stop" })).toThrow(/threadVersion/);
    expect(contracts.validateForkRequest({ schemaVersion: "1.0", threadVersion: 2, parentRunId: "run-1", parentCheckpointId: "cp-1", supersedesMessageId: "msg-1" }).parentRunId).toBe("run-1");
    expect(() => contracts.validateForkRequest({ schemaVersion: "1.0", threadVersion: 2, parentRunId: "run-1" })).toThrow(/parentCheckpointId/);
    expect(contracts.validateThreadPatch({ schemaVersion: "1.0", threadVersion: 2, title: "新对话" }).title).toBe("新对话");
    expect(() => contracts.validateThreadPatch({ schemaVersion: "1.0", threadVersion: 2 })).toThrow(/title|pinned|archived|deleted/);
  });

  it("validates legacy imports and bounded data URLs", () => {
    expect(contracts.validateLegacyImport({ schemaVersion: "1.0", clientConversationId: "conv-1", messages: [legacyMessage] }).messages).toHaveLength(1);
    expect(() => contracts.validateLegacyImport({ schemaVersion: "1.0", clientConversationId: "conv-1", actorId: "alice", messages: [legacyMessage] })).toThrow(/actorId|additionalProperties/);
    const tinyDataUrl = `data:text/plain;base64,${Buffer.from("x").toString("base64")}`;
    expect(() => contracts.validateLegacyImport({
      schemaVersion: "1.0",
      clientConversationId: "conv-1",
      messages: [
        { ...legacyMessage, clientMessageId: "m1", artifactRefs: [tinyDataUrl, tinyDataUrl, tinyDataUrl] },
        { ...legacyMessage, clientMessageId: "m2", artifactRefs: [tinyDataUrl, tinyDataUrl, tinyDataUrl] },
      ],
    })).toThrow(/LEGACY_IMPORT_TOO_MANY_DATA_URLS/);
    const largeDataUrl = `data:application/pdf;base64,${Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64")}`;
    expect(() => contracts.validateLegacyImport({
      schemaVersion: "1.0",
      clientConversationId: "conv-1",
      messages: [{ ...legacyMessage, artifactRefs: [largeDataUrl] }],
    })).toThrow(/LEGACY_IMPORT_DATA_URL_TOO_LARGE/);
    expect(() => contracts.validateLegacyImport({
      schemaVersion: "1.0",
      clientConversationId: "conv-1",
      messages: [{ ...legacyMessage, artifactRefs: ["data:text/plain,%E0%A4%A"] }],
    })).toThrow(/LEGACY_IMPORT_DATA_URL_INVALID_ENCODING/);
    expect(() => contracts.validateLegacyImport({
      schemaVersion: "1.0",
      clientConversationId: "conv-1",
      messages: [{ ...legacyMessage, artifactRefs: ["data:text/plain;base64,!!!!"] }],
    })).toThrow(/LEGACY_IMPORT_DATA_URL_INVALID_BASE64/);
  });

  it("validates model responses without private reasoning fields", () => {
    expect(contracts.validateModelResponse({ text: "ok", toolCalls: [], finishReason: "stop" }).text).toBe("ok");
    expect(contracts.validateModelResponse({
      text: "ok",
      toolCalls: [{ toolCallId: "call-1", name: "query_dashboard_summary", argumentsText: "{}" }],
      finishReason: "tool_calls",
      usage: { inputTokens: 1, outputTokens: 2 },
    }).finishReason).toBe("tool_calls");
    expect(() => contracts.validateModelResponse({ text: "ok", toolCalls: [], finishReason: "stop", reasoning: "private" })).toThrow(/reasoning|additionalProperties/);
  });

  it("validates evidence, claim validation and answer envelopes", () => {
    const evidence = {
      schemaVersion: "1.0",
      evidenceId: "ev-1",
      ontologyVersion: "legacy-v0",
      schemaFingerprint: "schema-1",
      evidenceType: "metric",
      source: { system: "analytics", toolName: "query_dashboard_summary", toolVersion: "legacy-tool-v1", attemptId: "attempt-1", queryFingerprint: "query-hash" },
      sourceRevision: { sourceId: "analytics", status: "unknown" },
      scope: { objectType: "defect", timeScopes: [] },
      preview: { count: 12 },
      quality: { groundingStatus: "legacy_equivalence", completeness: "unknown", truncation: { truncated: false }, missingness: "not_applicable", warnings: [] },
      authorization: { actorScopeHash: "scope-a", redactionStatus: "not_required" },
      retrievedAt: "2026-07-14T00:00:00.000Z",
    };
    expect(contracts.validateEvidence(evidence).evidenceId).toBe("ev-1");
    expect(() => contracts.validateEvidence({ ...evidence, authorization: undefined })).toThrow(/authorization/);
    expect(contracts.validateClaimValidation({ validationId: "cv-1", status: "repair", acceptedClaimIds: ["c1"], rejected: [{ claimId: "c2", reason: "unsupported" }], warnings: [] }).status).toBe("repair");
    expect(() => contracts.validateClaimValidation({ validationId: "cv-1", status: "valid", acceptedClaimIds: [], rejected: [], warnings: [], extra: true })).toThrow(/extra|additionalProperties/);
    expect(contracts.validateAnswerEnvelope({
      schemaVersion: "1.0",
      answerId: "answer-1",
      text: "ok",
      contentHash: "hash",
      acceptedClaimIds: ["c1"],
      citations: [{ citationId: "cite-1", label: "Dashboard", claimIds: ["c1"], evidenceIds: ["ev-1"] }],
      assumptions: [],
      limitations: ["Phase 1 legacy equivalence"],
      groundingStatus: "legacy_equivalence",
      sourceRevisionSet: {},
    }).answerId).toBe("answer-1");
    expect(() => contracts.validateAnswerEnvelope({ answerId: "answer-1" })).toThrow(/schemaVersion/);
  });

  it("compiles tool schemas through the shared strict Ajv instance", () => {
    const validate = contracts.compileToolSchema({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    }, "SEARCH_TOOL");
    expect(validate({ query: "camera" })).toBe(true);
    expect(validate({ query: "camera", extra: true })).toBe(false);
  });
});