// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { createAgentApp } from "../../../../server/app.mjs";
import { startTestAgentServer } from "./httpFixture";

describe("Agent HTTP application", () => {
  let fixture: Awaited<ReturnType<typeof startTestAgentServer>> | undefined;
  afterEach(async () => { await fixture?.cleanupServer(); fixture = undefined; });

  it("can be imported without opening a listening socket", async () => {
    expect(typeof createAgentApp).toBe("function");
  });

  it("returns only the public server model registry", async () => {
    fixture = await startTestAgentServer();
    const response = await fixture.fetch("/api/ai/models");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.defaultModelId).toBe("deepseek-v4-flash");
    expect(JSON.stringify(body)).not.toMatch(/secret|credential|access.?code/i);
  });

  it("responds to OPTIONS preflight with CORS headers", async () => {
    fixture = await startTestAgentServer();
    const response = await fixture.fetch("/api/agent/runs", { method: "OPTIONS", headers: { origin: "https://vizion.example" } });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://vizion.example");
    expect(response.headers.get("access-control-allow-methods")?.split(",").map((item) => item.trim())).toContain("POST");
  });

  it("returns 401 when identity resolution yields no actor", async () => {
    fixture = await startTestAgentServer();
    const app = createAgentApp({ ...fixture, identityResolver: async () => null, config: { allowedOrigins: [] } });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      const response = await fetch(`${baseUrl}/api/ai/models`);
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe("UNAUTHORIZED");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("starts, streams, and cancels Agent runs with protocol headers", async () => {
    fixture = await startTestAgentServer();
    const request = { schemaVersion: "1.0", messageId: "msg-1", threadVersion: 0, message: { role: "user", text: "hello", artifactRefs: [] }, selectedModel: "deepseek-v4-flash", useDefectContext: false, useAnalyticsContext: true, eventProtocolVersion: "1.0" };
    const started = await fixture.fetch("/api/agent/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    expect(started.status).toBe(202);
    expect(started.headers.get("x-agent-protocol")).toBe("1.0");
    const body = await started.json();
    expect(body.eventsUrl).toBe(`/api/agent/runs/${body.runId}/events`);
    const events = await fixture.fetch(body.eventsUrl, { headers: { accept: 'text/event-stream; profile="agent-v1"' } });
    expect(events.status).toBe(200);
    expect(await events.text()).toContain("run.started");
    const cancelled = await fixture.fetch(`/api/agent/runs/${body.runId}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: "1.0", threadVersion: body.threadVersion, reasonCode: "user_stop" }) });
    expect(cancelled.status).toBe(202);
  });

  it("keeps follow event streams open until a terminal event is published", async () => {
    fixture = await startTestAgentServer();
    const request = { schemaVersion: "1.0", messageId: "msg-follow-1", threadVersion: 0, message: { role: "user", text: "hello", artifactRefs: [] }, selectedModel: "deepseek-v4-flash", useDefectContext: false, useAnalyticsContext: true, eventProtocolVersion: "1.0" };
    const started = await fixture.fetch("/api/agent/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    const body = await started.json();

    const events = await fixture.fetch(`${body.eventsUrl}?follow=1`, { headers: { accept: 'text/event-stream; profile="agent-v1"' } });
    const eventText = events.text();
    const cancelled = await fixture.fetch(`/api/agent/runs/${body.runId}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: "1.0", threadVersion: body.threadVersion, reasonCode: "user_stop" }) });

    expect(cancelled.status).toBe(202);
    await expect(eventText).resolves.toContain("run.cancelled");
  });

  it("resumes a pending clarification through the HTTP API", async () => {
    fixture = await startTestAgentServer();
    const request = { schemaVersion: "1.0", messageId: "msg-resume-1", threadVersion: 0, message: { role: "user", text: "hello", artifactRefs: [] }, selectedModel: "deepseek-v4-flash", useDefectContext: false, useAnalyticsContext: true, eventProtocolVersion: "1.0" };
    const started = await fixture.fetch("/api/agent/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    const body = await started.json();
    const run = fixture.threadStore.getRun({ actor: fixture.alice, runId: body.runId });
    const interaction = fixture.threadStore.createInteraction({ actor: fixture.alice, runId: body.runId, leaseEpoch: run.leaseEpoch, kind: "clarification", payload: { question: "Which project?" }, expiresAt: "2026-07-14T00:10:00.000Z" });

    const resumed = await fixture.fetch(`/api/agent/runs/${body.runId}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: "1.0", interactionId: interaction.interactionId, threadVersion: interaction.threadVersion, value: { answer: "SP25" } }) });

    expect(resumed.status).toBe(202);
    expect(await resumed.json()).toMatchObject({ schemaVersion: "1.0", runId: body.runId, interactionId: interaction.interactionId, status: "running" });
    const events = await fixture.fetch(body.eventsUrl, { headers: { accept: 'text/event-stream; profile="agent-v1"' } });
    expect(await events.text()).toContain("run.resumed");
  });
});