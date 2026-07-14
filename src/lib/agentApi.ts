import { createAgentEventDecoder } from "./agentEventStream";

export class AgentApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryable = false, public snapshotUrl?: string) {
    super(message);
    this.name = "AgentApiError";
  }
}

async function parseResponse(response: Response) {
  if (response.ok) return response.json();
  const body = await response.json().catch(() => ({}));
  throw new AgentApiError(response.status, body.code || "HTTP_ERROR", body.safeMessage || body.code || response.statusText, Boolean(body.retryable), body.snapshotUrl);
}

export async function fetchAgentModels({ fetchImpl = fetch } = {}) {
  return parseResponse(await fetchImpl("/api/ai/models", { method: "GET" }));
}

export async function startAgentRun({ fetchImpl = fetch, ...request }: any) {
  const body = { ...request, schemaVersion: "1.0", eventProtocolVersion: "1.0" };
  const response = await fetchImpl("/api/agent/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await parseResponse(response);
  const runHeader = response.headers.get("X-Agent-Run-ID");
  const threadHeader = response.headers.get("X-Agent-Thread-ID");
  if (runHeader && runHeader !== payload.runId) throw new AgentApiError(502, "RUN_HEADER_MISMATCH", "Run header mismatch");
  if (threadHeader && threadHeader !== payload.threadId) throw new AgentApiError(502, "THREAD_HEADER_MISMATCH", "Thread header mismatch");
  return payload;
}

export async function openAgentEvents({ fetchImpl = fetch, runId, profile, lastEventId, signal }: any) {
  const response = await fetchImpl(`/api/agent/runs/${encodeURIComponent(runId)}/events?follow=1`, { method: "GET", signal, headers: { Accept: `text/event-stream; profile="${profile}"`, ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) } });
  if (!response.ok) await parseResponse(response);
  return { response, decoder: createAgentEventDecoder({ profile }), headers: { protocol: response.headers.get("X-Agent-Protocol") || undefined, runId: response.headers.get("X-Agent-Run-ID") || undefined, threadId: response.headers.get("X-Agent-Thread-ID") || undefined } };
}

export async function cancelAgentRun({ fetchImpl = fetch, runId, threadVersion, reasonCode }: any) {
  return parseResponse(await fetchImpl(`/api/agent/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemaVersion: "1.0", threadVersion, reasonCode }) }));
}

export async function uploadAgentArtifact({ fetchImpl = fetch, threadId, file, signal }: any) {
  return parseResponse(await fetchImpl("/api/agent/artifacts", { method: "POST", signal, headers: { "Content-Type": file.type || "application/octet-stream", "X-Artifact-File-Name": encodeURIComponent(file.name), ...(threadId ? { "X-Agent-Thread-ID": threadId } : {}) }, body: file }));
}

export const resumeAgentRun = ({ fetchImpl = fetch, runId, interactionId, threadVersion, value }: any) => parseResponse(fetchImpl(`/api/agent/runs/${encodeURIComponent(runId)}/resume`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemaVersion: "1.0", interactionId, threadVersion, value }) }));
export const fetchAgentThread = ({ fetchImpl = fetch, threadId }: any) => parseResponse(fetchImpl(`/api/agent/threads/${encodeURIComponent(threadId)}`, { method: "GET" }));
export const forkAgentThread = ({ fetchImpl = fetch, threadId, ...body }: any) => parseResponse(fetchImpl(`/api/agent/threads/${encodeURIComponent(threadId)}/fork`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemaVersion: "1.0", ...body }) }));
export const patchAgentThread = ({ fetchImpl = fetch, threadId, ...body }: any) => parseResponse(fetchImpl(`/api/agent/threads/${encodeURIComponent(threadId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemaVersion: "1.0", ...body }) }));
export const importLegacyConversation = ({ fetchImpl = fetch, ...body }: any) => parseResponse(fetchImpl("/api/agent/threads/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemaVersion: "1.0", ...body }) }));