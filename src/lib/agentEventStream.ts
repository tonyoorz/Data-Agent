export class AgentEventProtocolError extends Error {
  constructor(public code: string, message: string, public retryable = false) {
    super(`${code}: ${message}`);
    this.name = "AgentEventProtocolError";
  }
}

type Profile = "agent-v1" | "legacy-chat";

const encoder = new TextEncoder();

function stableJson(value: unknown) {
  return JSON.stringify(value);
}

function validateAgentEnvelope(item: any) {
  if (!item || item.schemaVersion !== "1.0" || typeof item.eventId !== "string" || typeof item.runId !== "string" || typeof item.threadId !== "string" || !Number.isInteger(item.sequence) || typeof item.type !== "string" || !item.payload || typeof item.payload !== "object" || Array.isArray(item.payload)) {
    throw new AgentEventProtocolError("INVALID_AGENT_EVENT", "Invalid agent event envelope");
  }
  return item;
}

export function createAgentEventDecoder({ profile }: { profile: Profile }) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  const eventById = new Map<string, string>();
  const eventBySequence = new Map<number, string>();
  let lastEventId: string | undefined;
  let lastSequence = 0;
  let answerId: string | undefined;
  let answerHash: string | undefined;
  let answerOffset = 0;
  let terminal = false;

  function accept(item: unknown): any | null {
    if (terminal) throw new AgentEventProtocolError("EVENT_AFTER_TERMINAL", "Event received after terminal event");
    if (profile === "legacy-chat") return item;
    const event = validateAgentEnvelope(item as any);
    const canonical = stableJson(event);
    if (eventById.has(event.eventId)) {
      if (eventById.get(event.eventId) === canonical) return null;
      throw new AgentEventProtocolError("EVENT_ID_CONFLICT", "Conflicting replayed event");
    }
    if (eventBySequence.has(event.sequence)) throw new AgentEventProtocolError("EVENT_SEQUENCE_CONFLICT", "Conflicting event sequence");
    if (event.type === "answer.delta") {
      if (answerId && event.payload.answerId !== answerId) throw new AgentEventProtocolError("ANSWER_ID_MISMATCH", "Answer id changed");
      if (answerHash && event.payload.contentHash !== answerHash) throw new AgentEventProtocolError("ANSWER_HASH_MISMATCH", "Answer hash changed");
      if (event.payload.offset !== answerOffset) throw new AgentEventProtocolError("ANSWER_OFFSET_MISMATCH", "Answer offset mismatch");
      answerId = event.payload.answerId;
      answerHash = event.payload.contentHash;
      answerOffset += encoder.encode(event.payload.text).byteLength;
    }
    if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) terminal = true;
    eventById.set(event.eventId, canonical);
    eventBySequence.set(event.sequence, event.eventId);
    lastEventId = event.eventId;
    lastSequence = Math.max(lastSequence, event.sequence);
    return event;
  }

  function parseFrames(final = false) {
    const outputs: any[] = [];
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
      let parsed;
      try { parsed = JSON.parse(data); } catch { throw new AgentEventProtocolError("INVALID_AGENT_EVENT_JSON", "Invalid JSON event data"); }
      if (id && parsed.eventId && id !== parsed.eventId) throw new AgentEventProtocolError("SSE_ID_MISMATCH", "SSE id does not match event envelope");
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