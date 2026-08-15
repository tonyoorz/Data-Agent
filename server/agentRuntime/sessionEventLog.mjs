import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * P0-1: Session Event Log — append-only durable event stream.
 * "Model-visible means logged": every user message, model request,
 * tool call/result and assistant response lands in the log first.
 * replay()/fork()/deriveMessages() project from this stream.
 */

const DEFAULT_ROOT_DIR = path.resolve(process.cwd(), "logs", "session-events");

export const SESSION_EVENT_TYPES = Object.freeze([
  "session/start",
  "user/message",
  "agent/request",
  "agent/response",
  "assistant/chunk",
  "tool/call",
  "tool/result",
  "turn/start",
  "turn/end",
  "approval/request",
  "approval/decision",
  "feedback/thumb",
  "error/runtime",
]);

function timestamp(now) {
  return (typeof now === "function" ? now() : new Date()).toISOString();
}

function safeFileName(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateSessionEvent(event) {
  if (!isRecord(event)) return "event must be an object";
  if (!SESSION_EVENT_TYPES.includes(event.type)) {
    return `unknown session event type: ${String(event.type)}`;
  }
  if (event.type !== "session/start" && !event.sessionId) {
    return "sessionId is required";
  }
  if (!event.type.startsWith("assistant/") && !isRecord(event.payload)) {
    return "payload must be an object";
  }
  return null;
}

export function createSessionEventLog({ rootDir = process.env.VIZION_SESSION_EVENT_DIR || DEFAULT_ROOT_DIR, now = () => new Date() } = {}) {
  const sessionsDir = path.join(rootDir, "sessions");
  let seqCounter = 0;

  function fileFor(sessionId) {
    return path.join(sessionsDir, `${safeFileName(sessionId)}.jsonl`);
  }

  async function ensureDir() {
    await mkdir(sessionsDir, { recursive: true });
  }

  return {
    rootDir,

    /** Append one durable session event. Returns the stored event (with seq + timestamp). */
    async append(event) {
      const error = validateSessionEvent(event);
      if (error) throw new Error(`SESSION_EVENT_INVALID: ${error}`);
      seqCounter += 1;
      const record = {
        seq: event.seq ?? seqCounter,
        ...event,
        recordedAt: timestamp(now),
      };
      await ensureDir();
      await appendFile(fileFor(event.sessionId), `${JSON.stringify(record)}\n`, "utf8");
      return record;
    },

    /** Append many events in order (single fs op per event, sequential seq). */
    async appendMany(events) {
      const out = [];
      for (const event of events) {
        out.push(await this.append(event));
      }
      return out;
    },

    /** Read the full ordered event stream of a session. */
    async read(sessionId) {
      try {
        const raw = await readFile(fileFor(sessionId), "utf8");
        return raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
      } catch (error) {
        if (error && error.code === "ENOENT") return [];
        throw error;
      }
    },

    /** List persisted session ids (derived from file names, sorted ascending). */
    async list() {
      try {
        const entries = await readdir(sessionsDir, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => entry.name.slice(0, -".jsonl".length))
          .sort();
      } catch (error) {
        if (error && error.code === "ENOENT") return [];
        throw error;
      }
    },

    /**
     * Replay events through a reducer: (state, event) => state.
     * Mirrors DSH deriveMessages(): the log is the source of truth.
     */
    async replay(sessionId, reducer, initialState = { messages: [], toolCalls: 0, turns: 0 }) {
      let state = initialState;
      for (const event of await this.read(sessionId)) {
        state = reducer(state, event);
      }
      return state;
    },

    /**
     * Fork a session at a boundary event seq (inclusive).
     * The child log receives every event up to and including the boundary,
     * then a session/start marker with parent linkage.
     */
    async fork(parentSessionId, boundarySeq, childSessionId) {
      if (!childSessionId) throw new Error("SESSION_FORK_INVALID: childSessionId required");
      const events = await this.read(parentSessionId);
      const kept = events.filter((event) => (event.seq ?? 0) <= boundarySeq && event.type !== "session/start");
      await ensureDir();
      const lines = [
        JSON.stringify({ type: "session/start", sessionId: childSessionId, payload: { forkedFrom: parentSessionId, boundarySeq, forkedAt: timestamp(now) }, recordedAt: timestamp(now) }),
        ...kept.map((event) => JSON.stringify({ ...event, sessionId: childSessionId })),
      ];
      await writeFile(fileFor(childSessionId), `${lines.join("\n")}\n`, "utf8");
      return { childSessionId, copied: kept.length };
    },

    /** Default reducer: derive model-visible messages from the stream. */
    deriveMessagesReducer(state, event) {
      const next = { ...state, messages: [...state.messages], toolCalls: state.toolCalls, turns: state.turns };
      switch (event.type) {
        case "user/message":
          next.messages.push({ role: "user", content: event.payload?.content ?? "" });
          break;
        case "agent/response":
          next.messages.push({ role: "assistant", content: event.payload?.content ?? "" });
          break;
        case "tool/call":
          next.toolCalls += 1;
          next.messages.push({ role: "assistant", tool_calls: [{ id: event.payload?.id ?? `t${next.toolCalls}`, function: { name: event.payload?.name ?? "", arguments: event.payload?.arguments ?? "{}" } }] });
          break;
        case "tool/result":
          next.messages.push({ role: "tool", tool_call_id: event.payload?.id ?? "", content: event.payload?.resultText ?? JSON.stringify(event.payload?.result ?? "") });
          break;
        case "turn/end":
          next.turns += 1;
          break;
        default:
          break;
      }
      return next;
    },

    /** Aggregate per-session metrics straight from the log. */
    async metrics(sessionId) {
      const events = await this.read(sessionId);
      const metrics = {
        events: events.length,
        turns: 0,
        toolCalls: 0,
        toolErrors: 0,
        tokens: { input: 0, output: 0, total: 0 },
        wallMs: 0,
      };
      let first = null;
      let last = null;
      for (const event of events) {
        if (!first) first = event.recordedAt;
        last = event.recordedAt;
        if (event.type === "turn/end") metrics.turns += 1;
        if (event.type === "tool/call") metrics.toolCalls += 1;
        if (event.type === "tool/result" && event.payload?.ok === false) metrics.toolErrors += 1;
        if (event.type === "agent/request" && event.payload?.tokens) {
          metrics.tokens.input += event.payload.tokens.input ?? 0;
          metrics.tokens.output += event.payload.tokens.output ?? 0;
          metrics.tokens.total += event.payload.tokens.total ?? 0;
        }
      }
      if (first && last) {
        metrics.wallMs = new Date(last) - new Date(first);
      }
      return metrics;
    },

    /** Content hash of a session stream (dedupe / regression compare). */
    async contentHash(sessionId) {
      const events = await this.read(sessionId);
      const hash = createHash("sha256");
      for (const event of events) {
        hash.update(`${event.seq}:${event.type}:${JSON.stringify(event.payload ?? null)}\n`);
      }
      return hash.digest("hex");
    },
  };
}
