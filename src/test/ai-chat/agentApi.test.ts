import { describe, expect, it, vi } from "vitest";
import { cancelAgentRun, fetchAgentModels, openAgentEvents, startAgentRun, uploadAgentArtifact, AgentApiError } from "../../lib/agentApi";

describe("agent API client", () => {
  it("fetches public models", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ defaultModelId: "deepseek-v4-flash", models: [] }), { status: 200 }));
    await expect(fetchAgentModels({ fetchImpl })).resolves.toMatchObject({ defaultModelId: "deepseek-v4-flash" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/ai/models", expect.objectContaining({ method: "GET" }));
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
    expect(fetchImpl).toHaveBeenCalledWith("/api/agent/runs/run-1/events", expect.objectContaining({ headers: expect.objectContaining({ "Last-Event-ID": "evt-1" }) }));
    expect(opened.headers.runId).toBe("run-1");
  });

  it("uploads raw artifact bytes and maps typed errors", async () => {
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ artifactId: "a1" }), { status: 201 })).mockResolvedValueOnce(new Response(JSON.stringify({ code: "EVENT_HISTORY_EXPIRED", snapshotUrl: "/snapshot" }), { status: 410 }));
    await uploadAgentArtifact({ fetchImpl, file, threadId: "thread-1" });
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/agent/artifacts");
    expect(fetchImpl.mock.calls[0][1].body).toBe(file);
    await expect(cancelAgentRun({ fetchImpl, runId: "run-1", threadVersion: 1, reasonCode: "user_stop" })).rejects.toMatchObject({ name: "AgentApiError", status: 410, code: "EVENT_HISTORY_EXPIRED", snapshotUrl: "/snapshot" });
  });
});