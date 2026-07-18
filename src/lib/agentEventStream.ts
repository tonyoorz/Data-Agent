export class AgentEventProtocolError extends Error {
  constructor(public code: string, message: string, public retryable = false) {
    super(`${code}: ${message}`);
    this.name = "AgentEventProtocolError";
  }
}

type Profile = "agent-v1" | "legacy-chat";

const AGENT_EVENT_TYPES = new Set([
  "run.started", "input.prepared", "intent.resolved", "ontology.resolved", "clarification.required",
  "plan.updated", "plan.validated", "model.completed", "model.fallback", "tool.started", "tool.progress",
  "tool.completed", "tool.failed", "evidence.added", "claims.validated", "answer.completed",
  "approval.required", "interaction.expired", "run.resumed", "answer.delta", "run.completed", "run.failed", "run.cancelled",
]);

export interface AgentCitation {
  citationId: string;
  label: string;
  claimIds: string[];
  evidenceIds: string[];
}

export interface AgentAnswerCompletedPayload {
  answerId: string;
  contentHash: string;
  acceptedClaimIds: string[];
  citations: AgentCitation[];
  assumptions: string[];
  limitations: string[];
  groundingStatus: "grounded" | "legacy_equivalence" | "insufficient_evidence";
  sourceRevisionSet: Record<string, unknown>;
}

export interface AgentEventPayload {
  [key: string]: unknown;
  answerId?: string;
  contentHash?: string;
  offset?: number;
  text?: string;
  threadVersion?: number;
  runtimeMode?: string;
  actualModelId?: string;
  mode?: string;
  semanticFrameRef?: { ontologyVersion?: string };
  modelId?: string;
  finishReason?: string;
  fromModelId?: string;
  toModelId?: string;
  reasonCode?: string;
  toolNames?: string[];
  toolName?: string;
  redactedCanonicalArgs?: unknown;
  status?: string;
  evidenceIds?: string[];
  groundingStatus?: string;
  citations?: AgentCitation[];
  question?: string;
  options?: string[];
  durationMs?: number;
  safeMessage?: string;
  code?: string;
  acceptedClaimIds?: string[];
  rejectedClaimIds?: string[];
  interactionId?: string;
  expiresAt?: string;
}

export interface AgentEventEnvelope {
  schemaVersion: "1.0";
  eventId: string;
  runId: string;
  threadId: string;
  stateVersion: number;
  sequence: number;
  timestamp: string;
  type: string;
  payload: AgentEventPayload;
}

export type PublicAgentEvent = Pick<AgentEventEnvelope, "type" | "payload"> & Partial<Omit<AgentEventEnvelope, "type" | "payload">>;

interface AgentEventDecoder<T> {
  push(chunk: Uint8Array): T[];
  finish(): T[];
  accept(item: unknown): T | null;
  snapshot(): { lastEventId?: string; lastSequence: number; answerId?: string; answerHash?: string; answerOffset: number; terminal: boolean };
}

const encoder = new TextEncoder();

function stableJson(value: unknown) {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateAnswerCompleted(payload: AgentEventPayload): asserts payload is AgentEventPayload & AgentAnswerCompletedPayload {
  const citationsValid = Array.isArray(payload.citations) && payload.citations.every((citation) => (
    isRecord(citation)
    && typeof citation.citationId === "string"
    && typeof citation.label === "string"
    && isStringArray(citation.claimIds)
    && isStringArray(citation.evidenceIds)
  ));
  if (
    typeof payload.answerId !== "string"
    || typeof payload.contentHash !== "string"
    || !isStringArray(payload.acceptedClaimIds)
    || !citationsValid
    || !isStringArray(payload.assumptions)
    || !isStringArray(payload.limitations)
    || !["grounded", "legacy_equivalence", "insufficient_evidence"].includes(String(payload.groundingStatus))
    || !isRecord(payload.sourceRevisionSet)
  ) {
    throw new AgentEventProtocolError("INVALID_ANSWER_COMPLETED", "Invalid answer completion payload");
  }
}

function validateAgentEnvelope(item: unknown): AgentEventEnvelope {
  if (!isRecord(item) || item.schemaVersion !== "1.0" || typeof item.eventId !== "string" || typeof item.runId !== "string" || typeof item.threadId !== "string" || !Number.isInteger(item.stateVersion) || !Number.isInteger(item.sequence) || typeof item.timestamp !== "string" || Number.isNaN(Date.parse(item.timestamp)) || typeof item.type !== "string" || !AGENT_EVENT_TYPES.has(item.type) || !item.payload || typeof item.payload !== "object" || Array.isArray(item.payload)) {
    throw new AgentEventProtocolError("INVALID_AGENT_EVENT", "Invalid agent event envelope");
  }
  return item as unknown as AgentEventEnvelope;
}

export function createAgentEventDecoder({ profile }: { profile: "agent-v1" }): AgentEventDecoder<AgentEventEnvelope>;
export function createAgentEventDecoder({ profile }: { profile: "legacy-chat" }): AgentEventDecoder<Record<string, unknown>>;
export function createAgentEventDecoder({ profile }: { profile: Profile }): AgentEventDecoder<AgentEventEnvelope | Record<string, unknown>> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  const eventById = new Map<string, string>();
  const eventBySequence = new Map<number, string>();
  let lastEventId: string | undefined;
  let lastSequence = 0;
  let answerId: string | undefined;
  let answerHash: string | undefined;
  let answerOffset = 0;
  let answerCompleted = false;
  let observedRunId: string | undefined;
  let observedThreadId: string | undefined;
  let terminal = false;

  function accept(item: unknown): AgentEventEnvelope | Record<string, unknown> | null {
    if (terminal) throw new AgentEventProtocolError("EVENT_AFTER_TERMINAL", "Event received after terminal event");
    if (profile === "legacy-chat") {
      if (!isRecord(item)) throw new AgentEventProtocolError("INVALID_LEGACY_EVENT", "Invalid legacy event payload");
      return item;
    }
    const event = validateAgentEnvelope(item);
    const canonical = stableJson(event);
    if (eventById.has(event.eventId)) {
      if (eventById.get(event.eventId) === canonical) return null;
      throw new AgentEventProtocolError("EVENT_ID_CONFLICT", "Conflicting replayed event");
    }
    if (eventBySequence.has(event.sequence)) throw new AgentEventProtocolError("EVENT_SEQUENCE_CONFLICT", "Conflicting event sequence");
    if (event.sequence <= lastSequence) throw new AgentEventProtocolError("EVENT_SEQUENCE_OUT_OF_ORDER", "Event sequence moved backwards");
    if (observedRunId && event.runId !== observedRunId) throw new AgentEventProtocolError("RUN_ID_MISMATCH", "Run id changed within event stream");
    if (observedThreadId && event.threadId !== observedThreadId) throw new AgentEventProtocolError("THREAD_ID_MISMATCH", "Thread id changed within event stream");
    observedRunId ||= event.runId;
    observedThreadId ||= event.threadId;
    if (event.type === "answer.delta") {
      if (typeof event.payload.answerId !== "string" || typeof event.payload.contentHash !== "string" || !Number.isInteger(event.payload.offset) || typeof event.payload.text !== "string") {
        throw new AgentEventProtocolError("INVALID_ANSWER_DELTA", "Invalid answer delta payload");
      }
      if (answerCompleted) throw new AgentEventProtocolError("ANSWER_DELTA_AFTER_COMPLETION", "Answer delta received after answer completion");
      if (answerId && event.payload.answerId !== answerId) throw new AgentEventProtocolError("ANSWER_ID_MISMATCH", "Answer id changed");
      if (answerHash && event.payload.contentHash !== answerHash) throw new AgentEventProtocolError("ANSWER_HASH_MISMATCH", "Answer hash changed");
      if (event.payload.offset !== answerOffset) throw new AgentEventProtocolError("ANSWER_OFFSET_MISMATCH", "Answer offset mismatch");
      answerId = event.payload.answerId;
      answerHash = event.payload.contentHash;
      answerOffset += encoder.encode(event.payload.text).byteLength;
    }
    if (event.type === "answer.completed") {
      validateAnswerCompleted(event.payload);
      if (answerCompleted) throw new AgentEventProtocolError("DUPLICATE_ANSWER_COMPLETED", "Answer completed more than once");
      if (answerId && event.payload.answerId !== answerId) throw new AgentEventProtocolError("ANSWER_ID_MISMATCH", "Answer id changed");
      if (answerHash && event.payload.contentHash !== answerHash) throw new AgentEventProtocolError("ANSWER_HASH_MISMATCH", "Answer hash changed");
      answerId = event.payload.answerId;
      answerHash = event.payload.contentHash;
      answerCompleted = true;
    }
    if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) terminal = true;
    eventById.set(event.eventId, canonical);
    eventBySequence.set(event.sequence, event.eventId);
    lastEventId = event.eventId;
    lastSequence = Math.max(lastSequence, event.sequence);
    return event;
  }

  function parseFrames(final = false) {
    const outputs: Array<AgentEventEnvelope | Record<string, unknown>> = [];
    for (;;) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match) break;
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const idLine = frame.split(/\r?\n/).find((line) => line.startsWith("id:"));
      const id = idLine ? idLine.slice(3).trim() : undefined;
      const dataParts = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
      const data = dataParts.join(profile === "agent-v1" ? "" : "\n");
      if (!data) continue;
      if (profile === "legacy-chat" && data === "[DONE]") { outputs.push({ type: "done" }); continue; }
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { throw new AgentEventProtocolError("INVALID_AGENT_EVENT_JSON", "Invalid JSON event data"); }
      if (id && isRecord(parsed) && parsed.eventId && id !== parsed.eventId) throw new AgentEventProtocolError("SSE_ID_MISMATCH", "SSE id does not match event envelope");
      const accepted = accept(parsed);
      if (accepted) outputs.push(accepted);
    }
    if (final && buffer.trim()) throw new AgentEventProtocolError("INCOMPLETE_SSE_FRAME", "Incomplete SSE frame");
    return outputs;
  }

  return {
    push(chunk: Uint8Array) {
      buffer += decoder.decode(chunk, { stream: true });
      return parseFrames(false);
    },
    finish() {
      buffer += decoder.decode();
      return parseFrames(true);
    },
    accept,
    snapshot() { return { lastEventId, lastSequence, answerId, answerHash, answerOffset, terminal }; },
  };
}
