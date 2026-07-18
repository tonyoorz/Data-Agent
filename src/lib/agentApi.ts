import { createAgentEventDecoder } from "./agentEventStream";

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;

interface FetchOptions {
  fetchImpl?: FetchImplementation;
}

export interface AgentThread {
  threadId: string;
  threadVersion: number;
  title?: string;
  [key: string]: unknown;
}

interface ThreadResponse extends JsonRecord {
  schemaVersion: "1.0";
  thread: AgentThread;
}

interface StartRunResponse extends JsonRecord {
  schemaVersion: "1.0";
  threadId: string;
  runId: string;
  threadVersion: number;
  eventsUrl: string;
}

export class AgentApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryable = false, public snapshotUrl?: string) {
    super(message);
    this.name = "AgentApiError";
  }
}

function jsonRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

async function parseResponse<T = JsonRecord>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;
  const body = jsonRecord(await response.json().catch(() => ({})));
  const code = typeof body.code === "string" ? body.code : "HTTP_ERROR";
  const safeMessage = typeof body.safeMessage === "string" ? body.safeMessage : code || response.statusText;
  throw new AgentApiError(response.status, code, safeMessage, body.retryable === true, typeof body.snapshotUrl === "string" ? body.snapshotUrl : undefined);
}

export async function fetchAgentModels({ fetchImpl = fetch }: FetchOptions = {}) {
  return parseResponse(await fetchImpl("/api/ai/models", { method: "GET" }));
}

export async function fetchAgentRuntimeConfig({ fetchImpl = fetch }: FetchOptions = {}) {
  const response = await fetchImpl("/api/agent/config", { method: "GET", headers: { Accept: "application/json" } });
  if (!response.ok) return parseResponse(response);
  const runtimeMode = response.headers.get("X-Agent-Runtime-Mode");
  if (runtimeMode) {
    return {
      schemaVersion: "1.0",
      runtimeMode,
      agentApiEnabled: response.headers.get("X-Agent-API-Enabled") === "true",
      serverControlled: response.headers.get("X-Agent-Server-Controlled") === "true",
    };
  }
  return { schemaVersion: "1.0", runtimeMode: "legacy", agentApiEnabled: false, serverControlled: false };
}

interface StartAgentRunInput extends FetchOptions {
  messageId: string;
  threadId?: string;
  threadVersion: number;
  message: { role: "user"; text: string; artifactRefs: string[] };
  selectedModel: string;
  useDefectContext: boolean;
  useAnalyticsContext: boolean;
  pageContext?: { moduleKey: string; moduleLabel: string };
}

export async function startAgentRun({ fetchImpl = fetch, ...request }: StartAgentRunInput): Promise<StartRunResponse> {
  const body = { ...request, schemaVersion: "1.0", eventProtocolVersion: "1.0" };
  const response = await fetchImpl("/api/agent/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await parseResponse<StartRunResponse>(response);
  const runHeader = response.headers.get("X-Agent-Run-ID");
  const threadHeader = response.headers.get("X-Agent-Thread-ID");
  if (runHeader && runHeader !== payload.runId) throw new AgentApiError(502, "RUN_HEADER_MISMATCH", "Run header mismatch");
  if (threadHeader && threadHeader !== payload.threadId) throw new AgentApiError(502, "THREAD_HEADER_MISMATCH", "Thread header mismatch");
  return payload;
}

interface OpenAgentEventsInput extends FetchOptions {
  runId: string;
  profile: "agent-v1";
  lastEventId?: string;
  signal?: AbortSignal;
}

export async function openAgentEvents({ fetchImpl = fetch, runId, profile, lastEventId, signal }: OpenAgentEventsInput) {
  const response = await fetchImpl(`/api/agent/runs/${encodeURIComponent(runId)}/events?follow=1`, { method: "GET", signal, headers: { Accept: `text/event-stream; profile="${profile}"`, ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) } });
  if (!response.ok) await parseResponse(response);
  return { response, decoder: createAgentEventDecoder({ profile }), headers: { protocol: response.headers.get("X-Agent-Protocol") || undefined, runId: response.headers.get("X-Agent-Run-ID") || undefined, threadId: response.headers.get("X-Agent-Thread-ID") || undefined } };
}

interface CancelRunInput extends FetchOptions { runId: string; threadVersion: number; reasonCode: string }
interface ResumeRunInput extends FetchOptions { runId: string; interactionId: string; threadVersion: number; value: unknown }

export async function cancelAgentRun({ fetchImpl = fetch, runId, threadVersion, reasonCode }: CancelRunInput) {
  return parseResponse(await fetchImpl(`/api/agent/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemaVersion: "1.0", threadVersion, reasonCode }) }));
}

export async function createAgentThread({ fetchImpl = fetch, title }: FetchOptions & { title?: string } = {}): Promise<ThreadResponse> {
  return parseResponse<ThreadResponse>(await fetchImpl("/api/agent/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemaVersion: "1.0", ...(title ? { title } : {}) }) }));
}

export async function uploadAgentArtifact({ fetchImpl = fetch, threadId, file, signal }: FetchOptions & { threadId: string; file: File; signal?: AbortSignal }) {
  return parseResponse<{ schemaVersion: "1.0"; artifactId: string; [key: string]: unknown }>(await fetchImpl("/api/agent/artifacts", { method: "POST", signal, headers: { "Content-Type": file.type || "application/octet-stream", "X-Artifact-File-Name": encodeURIComponent(file.name), "X-Agent-Thread-ID": threadId }, body: file }));
}

export const resumeAgentRun = async ({ fetchImpl = fetch, runId, interactionId, threadVersion, value }: ResumeRunInput) => parseResponse<{ schemaVersion: "1.0"; runId: string; interactionId: string; status: string; threadVersion: number }>(await fetchImpl(`/api/agent/runs/${encodeURIComponent(runId)}/resume`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemaVersion: "1.0", interactionId, threadVersion, value }) }));
export const fetchAgentThread = async ({ fetchImpl = fetch, threadId }: FetchOptions & { threadId: string }) => parseResponse<ThreadResponse & { messages?: unknown[] }>(await fetchImpl(`/api/agent/threads/${encodeURIComponent(threadId)}`, { method: "GET" }));
export const forkAgentThread = async ({ fetchImpl = fetch, threadId, ...body }: FetchOptions & { threadId: string; threadVersion: number; parentRunId: string; parentCheckpointId: string; supersedesMessageId: string }) => parseResponse<ThreadResponse>(await fetchImpl(`/api/agent/threads/${encodeURIComponent(threadId)}/fork`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemaVersion: "1.0", ...body }) }));
export const patchAgentThread = async ({ fetchImpl = fetch, threadId, ...body }: FetchOptions & { threadId: string; threadVersion: number; title?: string; pinned?: boolean; archived?: boolean; deleted?: boolean }) => parseResponse<ThreadResponse>(await fetchImpl(`/api/agent/threads/${encodeURIComponent(threadId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemaVersion: "1.0", ...body }) }));
export const importLegacyConversation = async ({ fetchImpl = fetch, ...body }: FetchOptions & { clientConversationId: string; messages: unknown[] }) => parseResponse<ThreadResponse>(await fetchImpl("/api/agent/threads/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemaVersion: "1.0", ...body }) }));
