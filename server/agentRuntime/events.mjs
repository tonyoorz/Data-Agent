import { EventEmitter } from "node:events";

const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled"]);
const TERMINAL_STATUS = new Set(["completed", "failed", "cancelled"]);
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

function fail(code, statusCode = 409) {
  throw Object.assign(new Error(code), { code, statusCode, retryable: false });
}

function mapRun(row) {
  if (!row) return null;
  return {
    runId: row.run_id,
    threadId: row.thread_id,
    actorId: row.actor_id,
    stateVersion: row.state_version,
    leaseEpoch: row.lease_epoch,
    status: row.status,
    scopeHash: row.scope_hash,
  };
}

function mapEvent(row) {
  return {
    schemaVersion: "1.0",
    eventId: row.event_id,
    runId: row.run_id,
    threadId: row.thread_id,
    stateVersion: row.state_version,
    sequence: row.sequence,
    timestamp: row.created_at,
    type: row.event_type,
    payload: JSON.parse(row.payload_json),
  };
}

function nextSequence(db, runId) {
  return Number(db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 FROM agent_events WHERE run_id=?").pluck().get(runId));
}

function updateRun(db, { runId, expectedStateVersion, leaseEpoch, patch, now }) {
  const sets = ["state_version = state_version + 1", "updated_at = @updatedAt"];
  const params = { runId, expectedStateVersion, leaseEpoch, updatedAt: now };
  if (patch.status) { sets.push("status = @status"); params.status = patch.status; }
  if (patch.answerJson !== undefined) { sets.push("answer_json = @answerJson"); params.answerJson = JSON.stringify(patch.answerJson); }
  if (patch.errorJson !== undefined) { sets.push("error_json = @errorJson"); params.errorJson = JSON.stringify(patch.errorJson); }
  if (TERMINAL_STATUS.has(patch.status)) { sets.push("terminal_at = @terminalAt"); params.terminalAt = now; }
  const result = db.prepare(`UPDATE agent_runs SET ${sets.join(", ")} WHERE run_id=@runId AND state_version=@expectedStateVersion AND lease_epoch=@leaseEpoch`).run(params);
  if (result.changes !== 1) {
    const row = db.prepare("SELECT lease_epoch, state_version FROM agent_runs WHERE run_id=?").get(runId);
    if (!row) fail("NOT_FOUND", 404);
    if (row.lease_epoch !== leaseEpoch) fail("STALE_RUN_LEASE");
    fail("STATE_VERSION_CONFLICT");
  }
  return db.prepare("SELECT * FROM agent_runs WHERE run_id=?").get(runId);
}

function insertEvents(db, { contracts, now, randomUUID, run, stateVersion, leaseEpoch, eventInputs }) {
  const existingTerminal = db.prepare("SELECT 1 FROM agent_events WHERE run_id=? AND event_type IN ('run.completed','run.failed','run.cancelled')").pluck().get(run.run_id);
  if (existingTerminal) fail("TERMINAL_EVENT_EXISTS");
  const hasTerminal = eventInputs.some((event) => TERMINAL_EVENTS.has(event.type));
  if (hasTerminal && !TERMINAL_STATUS.has(run.status)) fail("TERMINAL_EVENT_WITHOUT_TERMINAL_STATUS");
  if (TERMINAL_STATUS.has(run.status) && !hasTerminal) fail("TERMINAL_STATUS_WITHOUT_TERMINAL_EVENT");

  let sequence = nextSequence(db, run.run_id);
  const committed = [];
  for (const eventInput of eventInputs) {
    const event = contracts.validateAgentEvent({
      schemaVersion: "1.0",
      eventId: randomUUID(),
      runId: run.run_id,
      threadId: run.thread_id,
      stateVersion,
      sequence: sequence++,
      timestamp: now,
      type: eventInput.type,
      payload: eventInput.payload,
    });
    db.prepare("INSERT INTO agent_events(event_id,run_id,thread_id,sequence,state_version,event_type,payload_json,scope_hash,lease_epoch,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(event.eventId, event.runId, event.threadId, event.sequence, event.stateVersion, event.type, JSON.stringify(event.payload), run.scope_hash, leaseEpoch, event.timestamp);
    committed.push(event);
  }
  return committed;
}

function splitAnswer(text, maxChunkCharacters) {
  const chars = Array.from(text);
  const chunks = [];
  for (let index = 0; index < chars.length; index += maxChunkCharacters) {
    chunks.push(chars.slice(index, index + maxChunkCharacters).join(""));
  }
  return chunks;
}

export function createEventStore({ db, contracts, now, randomUUID, authorizeRun }) {
  const notifier = new EventEmitter();

  const writeInTransaction = (_tx, input) => {
    if (Array.isArray(input)) return input;
    return insertEvents(db, { contracts, now: now(), randomUUID, ...input });
  };

  const transition = db.transaction((input) => {
    const txTime = now();
    const current = db.prepare("SELECT * FROM agent_runs WHERE run_id=?").get(input.runId);
    if (!current) fail("NOT_FOUND", 404);
    authorizeRun?.({ actor: input.actor, run: current });
    if (TERMINAL_STATUS.has(current.status)) fail("RUN_ALREADY_TERMINAL");
    const updated = updateRun(db, { runId: input.runId, expectedStateVersion: input.expectedStateVersion, leaseEpoch: input.leaseEpoch, patch: input.patch || {}, now: txTime });
    return insertEvents(db, { contracts, now: txTime, randomUUID, run: updated, stateVersion: updated.state_version, leaseEpoch: updated.lease_epoch, eventInputs: input.eventInputs });
  });

  const appendAnswerTx = db.transaction((input) => {
    const txTime = now();
    contracts.validateAnswerEnvelope(input.answer);
    if (!Number.isInteger(input.durationMs) || input.durationMs < 0 || input.durationMs > MAX_DURATION_MS) fail("INVALID_RUN_DURATION", 400);
    const current = db.prepare("SELECT * FROM agent_runs WHERE run_id=?").get(input.runId);
    if (!current) fail("NOT_FOUND", 404);
    authorizeRun?.({ actor: input.actor, run: current });
    const thread = db.prepare("SELECT * FROM agent_threads WHERE thread_id=? AND actor_id=?").get(current.thread_id, input.actor.actorId);
    if (!thread) fail("NOT_FOUND", 404);
    if (thread.thread_version !== input.threadVersion) fail("THREAD_VERSION_CONFLICT");
    if (TERMINAL_STATUS.has(current.status)) {
      if (current.status === "completed" && current.answer_json === JSON.stringify(input.answer)) {
        return db.prepare("SELECT * FROM agent_events WHERE run_id=? AND event_type='run.completed' ORDER BY sequence").all(input.runId).map(mapEvent);
      }
      fail("RUN_ALREADY_TERMINAL");
    }
    const nextThreadVersion = thread.thread_version + 1;
    const updated = updateRun(db, { runId: input.runId, expectedStateVersion: input.expectedStateVersion, leaseEpoch: input.leaseEpoch, patch: { status: "completed", answerJson: input.answer }, now: txTime });
    const insertedMessage = db.prepare("INSERT OR IGNORE INTO agent_messages(message_id,thread_id,run_id,role,body_json,scope_hash,created_at) VALUES(?,?,?,'assistant',?,?,?)").run(input.assistantMessageId, current.thread_id, input.runId, JSON.stringify({ answer: input.answer }), current.scope_hash, txTime);
    if (insertedMessage.changes !== 1) fail("ASSISTANT_MESSAGE_ID_CONFLICT");
    db.prepare("UPDATE agent_threads SET thread_version=?, updated_at=? WHERE thread_id=?").run(nextThreadVersion, txTime, current.thread_id);
    let offset = 0;
    const eventInputs = splitAnswer(input.answer.text, input.maxChunkCharacters || 512).map((text) => {
      const event = { type: "answer.delta", payload: { answerId: input.answer.answerId, contentHash: input.answer.contentHash, offset, text } };
      offset += Buffer.byteLength(text, "utf8");
      return event;
    });
    const { text: _text, schemaVersion: _schemaVersion, ...answerMetadata } = input.answer;
    eventInputs.push({ type: "answer.completed", payload: answerMetadata });
    eventInputs.push({ type: "run.completed", payload: { answerId: input.answer.answerId, threadVersion: nextThreadVersion, durationMs: input.durationMs } });
    return insertEvents(db, { contracts, now: txTime, randomUUID, run: updated, stateVersion: updated.state_version, leaseEpoch: updated.lease_epoch, eventInputs });
  });

  function commitTransition(input) {
    const committed = transition(input);
    notifier.emit(input.runId, committed);
    return committed;
  }

  function listAfter({ runId, afterEventId, afterSequence = 0, actor }) {
    const run = db.prepare("SELECT * FROM agent_runs WHERE run_id=?").get(runId);
    if (!run) fail("NOT_FOUND", 404);
    authorizeRun?.({ actor, run });
    let sequence = afterSequence;
    if (afterEventId) {
      const cursor = db.prepare("SELECT sequence FROM agent_events WHERE run_id=? AND event_id=?").get(runId, afterEventId);
      if (!cursor) {
        const tombstone = db.prepare("SELECT 1 FROM agent_event_tombstones WHERE run_id=? AND event_id=?").get(runId, afterEventId);
        if (tombstone) fail("EVENT_HISTORY_EXPIRED", 410);
        fail("INVALID_EVENT_CURSOR", 400);
      }
      sequence = cursor.sequence;
    }
    return db.prepare("SELECT * FROM agent_events WHERE run_id=? AND sequence>? ORDER BY sequence").all(runId, sequence).map(mapEvent);
  }

  function appendAnswer(input) {
    const committed = appendAnswerTx(input);
    notifier.emit(input.runId, committed);
    return committed.at(-1);
  }

  return { writeInTransaction, commitTransition, appendAnswer, listAfter, notifier };
}

export function mapEventToLegacy(event, { resolveToolName } = {}) {
  if (event.type === "tool.started") return { type: "tool-input-available", toolCallId: event.payload.attemptId, toolName: event.payload.toolName, input: event.payload.redactedCanonicalArgs };
  if (event.type === "tool.completed") return { type: "tool-output-available", toolCallId: event.payload.attemptId, toolName: resolveToolName?.(event.payload.attemptId), outputSummary: `${event.payload.status}: ${event.payload.evidenceIds.join(",")}` };
  if (event.type === "tool.failed") return { type: "tool-output-available", toolCallId: event.payload.attemptId, toolName: resolveToolName?.(event.payload.attemptId), outputSummary: `${event.payload.status}: ${event.payload.safeMessage}` };
  if (event.type === "answer.delta") return { choices: [{ delta: { content: event.payload.text } }] };
  if (event.type === "run.failed") return { type: "error", message: event.payload.safeMessage };
  if (event.type === "run.cancelled") return { type: "error", message: "Request cancelled" };
  if (["run.started", "input.prepared", "intent.resolved", "ontology.resolved", "clarification.required", "plan.updated", "plan.validated", "evidence.added", "claims.validated", "answer.completed", "run.resumed", "interaction.expired"].includes(event.type)) return { type: "status", message: event.type };
  return null;
}

export function encodeSseEvent(event, profile, dependencies) {
  const payload = profile === "agent-v1" ? event : mapEventToLegacy(event, dependencies);
  if (!payload) return "";
  return `id: ${event.eventId}\nevent: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

export const encodeHeartbeat = () => ": heartbeat\n\n";
