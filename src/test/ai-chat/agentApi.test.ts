import { describe, expect, it, vi } from "vitest";
import { cancelAgentRun, createAgentThread, fetchAgentModels, fetchAgentRuntimeConfig, fetchAgentThread, forkAgentThread, importLegacyConversation, openAgentEvents, patchAgentThread, resumeAgentRun, startAgentRun, uploadAgentArtifact } from "../../lib/agentApi";

describe("agent API client", () => {
  it("fetches public models", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ defaultModelId: "deepseek-v4-flash", models: [] }), { status: 200 }));
    await expect(fetchAgentModels({ fetchImpl })).resolves.toMatchObject({ defaultModelId: "deepseek-v4-flash" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/ai/models", expect.objectContaining({ method: "GET" }));
  });

  it("uses only the signed server runtime decision headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: {
        "X-Agent-Runtime-Mode": "langgraph",
        "X-Agent-API-Enabled": "true",
        "X-Agent-Server-Controlled": "true",
      },
    }));
    await expect(fetchAgentRuntimeConfig({ fetchImpl })).resolves.toMatchObject({ runtimeMode: "langgraph", agentApiEnabled: true, serverControlled: true });
    expect(fetchImpl).toHaveBeenCalledWith("/api/agent/config", expect.objectContaining({ method: "GET" }));
  });

  it("starts runs with explicit flags and no actor identity", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ schemaVersion: "1.0", threadId: "thread-1", runId: "run-1", threadVersion: 1, eventsUrl: "/events" }), { status: 202, headers: { "X-Agent-Run-ID": "run-1", "X-Agent-Thread-ID": "thread-1", "X-Agent-Protocol": "1.0" } }));
    await startAgentRun({ fetchImpl, messageId: "msg-1", threadVersion: 0, message: { role: "user", text: "hello", artifactRefs: [] }, selectedModel: "deepseek-v4-flash", useDefectContext: false, useAnalyticsContext: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/agent/runs");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ eventProtocolVersion: "1.0", useDefectContext: false, useAnalyticsContext: true });
    expect(JSON.stringify(body)).not.toMatch(/actorId|data:/);
  });

  it("opens event streams without query-string identity", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new ReadableStream(), { status: 200, headers: { "X-Agent-Protocol": "1.0", "X-Agent-Run-ID": "run-1", "X-Agent-Thread-ID": "thread-1" } }));
    const opened = await openAgentEvents({ fetchImpl, runId: "run-1", profile: "agent-v1", lastEventId: "evt-1" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/agent/runs/run-1/events?follow=1", expect.objectContaining({ headers: expect.objectContaining({ "Last-Event-ID": "evt-1" }) }));
    expect(opened.headers.runId).toBe("run-1");
  });

  it("resumes runs and parses the async HTTP response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ schemaVersion: "1.0", runId: "run-1", interactionId: "interaction-1", status: "running", threadVersion: 3 }), { status: 202 }));
    await expect(resumeAgentRun({ fetchImpl, runId: "run-1", interactionId: "interaction-1", threadVersion: 2, value: { answer: "SP25" } })).resolves.toMatchObject({ runId: "run-1", threadVersion: 3 });
    expect(fetchImpl).toHaveBeenCalledWith("/api/agent/runs/run-1/resume", expect.objectContaining({ method: "POST" }));
  });

  it("uploads raw artifact bytes and maps typed errors", async () => {
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ artifactId: "a1" }), { status: 201 })).mockResolvedValueOnce(new Response(JSON.stringify({ code: "EVENT_HISTORY_EXPIRED", snapshotUrl: "/snapshot" }), { status: 410 }));
    await uploadAgentArtifact({ fetchImpl, file, threadId: "thread-1" });
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/agent/artifacts");
    expect(fetchImpl.mock.calls[0][1].body).toBe(file);
    await expect(cancelAgentRun({ fetchImpl, runId: "run-1", threadVersion: 1, reasonCode: "user_stop" })).rejects.toMatchObject({ name: "AgentApiError", status: 410, code: "EVENT_HISTORY_EXPIRED", snapshotUrl: "/snapshot" });
  });

  it("creates and manages threads through resolved HTTP responses", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ schemaVersion: "1.0", thread: { threadId: "thread-1", threadVersion: 0 } }), { status: 200 }));

    await expect(createAgentThread({ fetchImpl, title: "治理问答" })).resolves.toMatchObject({ thread: { threadId: "thread-1" } });
    await expect(fetchAgentThread({ fetchImpl, threadId: "thread-1" })).resolves.toMatchObject({ schemaVersion: "1.0" });
    await expect(patchAgentThread({ fetchImpl, threadId: "thread-1", threadVersion: 0, title: "新标题" })).resolves.toMatchObject({ schemaVersion: "1.0" });
    await expect(forkAgentThread({ fetchImpl, threadId: "thread-1", threadVersion: 0, parentRunId: "run-1", parentCheckpointId: "cp-1", supersedesMessageId: "msg-1" })).resolves.toMatchObject({ schemaVersion: "1.0" });
    await expect(importLegacyConversation({ fetchImpl, clientConversationId: "legacy-1", messages: [] })).resolves.toMatchObject({ schemaVersion: "1.0" });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/api/agent/threads",
      "/api/agent/threads/thread-1",
      "/api/agent/threads/thread-1",
      "/api/agent/threads/thread-1/fork",
      "/api/agent/threads/import",
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body))).toEqual({ schemaVersion: "1.0", title: "治理问答" });
  });
});
