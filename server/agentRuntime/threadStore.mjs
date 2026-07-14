const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function fail(code, statusCode = 409) {
  throw Object.assign(new Error(code), { code, statusCode, retryable: false });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function stableJson(value) {
  return JSON.stringify(stable(value));
}

function mapThread(row) {
  if (!row) return null;
  return {
    threadId: row.thread_id,
    actorId: row.actor_id,
    title: row.title,
    threadVersion: row.thread_version,
    scopeVersion: row.scope_version,
    scopeHash: row.scope_hash,
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function mapRun(row) {
  if (!row) return null;
  return {
    runId: row.run_id,
    threadId: row.thread_id,
    actorId: row.actor_id,
    messageId: row.message_id,
    requestHash: row.request_hash,
    graphDefinitionVersion: row.graph_definition_version,
    runtimeMode: row.runtime_mode,
    status: row.status,
    stateVersion: row.state_version,
    leaseEpoch: row.lease_epoch,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    requestedModelId: row.requested_model_id,
    actualModelId: row.actual_model_id,
    modelConfigVersion: row.model_config_version,
    scopeVersion: row.scope_version,
    scopeHash: row.scope_hash,
    canonicalCheckpointId: row.canonical_checkpoint_id,
    canonicalStateHash: row.canonical_state_hash,
    activeExecutionBudgetMs: row.active_execution_budget_ms,
    activeExecutionConsumedMs: row.active_execution_consumed_ms,
    activeSegmentStartedAt: row.active_segment_started_at,
    hardExpiresAt: row.hard_expires_at,
    cancelRequestedAt: row.cancel_requested_at,
    answer: row.answer_json ? JSON.parse(row.answer_json) : null,
    error: row.error_json ? JSON.parse(row.error_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
  };
}

function mapMessage(row) {
  return {
    messageId: row.message_id,
    threadId: row.thread_id,
    runId: row.run_id,
    parentMessageId: row.parent_message_id,
    role: row.role,
    body: JSON.parse(row.body_json),
    scopeHash: row.scope_hash,
    createdAt: row.created_at,
  };
}

function assertWriter(writeEventsInTransaction) {
  if (typeof writeEventsInTransaction !== "function") fail("EVENT_WRITER_REQUIRED", 500);
}

export function createThreadStore({ db, now, randomUUID, writeEventsInTransaction }) {
  const getThreadRow = (actor, threadId) => {
    const row = db.prepare("SELECT * FROM agent_threads WHERE thread_id=? AND actor_id=? AND deleted_at IS NULL").get(threadId, actor.actorId);
    if (!row) fail("NOT_FOUND", 404);
    return row;
  };

  const getRunRowByActor = (actor, runId) => {
    const row = db.prepare("SELECT * FROM agent_runs WHERE run_id=? AND actor_id=?").get(runId, actor.actorId);
    if (!row) fail("NOT_FOUND", 404);
    return row;
  };

  const createThread = db.transaction(({ actor, title = "新对话", parentThreadId, parentRunId, parentCheckpointId, supersedesMessageId }) => {
    const at = now();
    const threadId = randomUUID();
    db.prepare(`INSERT INTO agent_threads(thread_id,actor_id,parent_thread_id,parent_run_id,parent_checkpoint_id,supersedes_message_id,title,thread_version,scope_version,scope_hash,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,0,?,?,?,?)`).run(threadId, actor.actorId, parentThreadId || null, parentRunId || null, parentCheckpointId || null, supersedesMessageId || null, title, actor.scopeVersion, actor.scopeHash, at, at);
    return mapThread(db.prepare("SELECT * FROM agent_threads WHERE thread_id=?").get(threadId));
  });

  const createRun = db.transaction((input) => {
    const at = now();
    const existing = db.prepare("SELECT * FROM agent_runs WHERE actor_id=? AND message_id=?").get(input.actor.actorId, input.messageId);
    if (existing) {
      if (existing.request_hash !== input.requestHash || existing.thread_id !== input.threadId) fail("IDEMPOTENCY_CONFLICT");
      return mapRun(existing);
    }
    const thread = getThreadRow(input.actor, input.threadId);
    if (thread.thread_version !== input.expectedThreadVersion) fail("THREAD_VERSION_CONFLICT");
    const active = db.prepare("SELECT run_id FROM agent_runs WHERE thread_id=? AND status IN ('queued','running','waiting_for_clarification','waiting_for_approval')").get(input.threadId);
    if (active) fail("THREAD_BUSY");
    const runId = randomUUID();
    db.prepare(`INSERT INTO agent_runs(run_id,thread_id,actor_id,message_id,parent_run_id,parent_checkpoint_id,request_hash,graph_definition_version,runtime_mode,status,state_version,lease_epoch,requested_model_id,actual_model_id,model_config_version,scope_version,scope_hash,active_execution_budget_ms,active_execution_consumed_ms,active_segment_started_at,hard_expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'queued',0,0,?,?,?,?,?, ?,0,?,?,?,?)`).run(
      runId,
      input.threadId,
      input.actor.actorId,
      input.messageId,
      input.parentRunId || null,
      input.parentCheckpointId || null,
      input.requestHash,
      input.graphDefinitionVersion,
      input.runtimeMode,
      input.requestedModelId,
      input.actualModelId,
      input.modelConfigVersion,
      input.actor.scopeVersion,
      input.actor.scopeHash,
      input.activeExecutionBudgetMs,
      at,
      input.hardExpiresAt,
      at,
      at,
    );
    return mapRun(db.prepare("SELECT * FROM agent_runs WHERE run_id=?").get(runId));
  });

  function updateRunPatch(runId, patch, at) {
    const sets = ["state_version = state_version + 1", "updated_at = @updatedAt"];
    const params = { runId, updatedAt: at };
    if (patch.status) { sets.push("status = @status"); params.status = patch.status; }
    if (patch.answerJson !== undefined) { sets.push("answer_json = @answerJson"); params.answerJson = patch.answerJson == null ? null : JSON.stringify(patch.answerJson); }
    if (patch.errorJson !== undefined) { sets.push("error_json = @errorJson"); params.errorJson = patch.errorJson == null ? null : JSON.stringify(patch.errorJson); }
    if (patch.cancelRequestedAt !== undefined) { sets.push("cancel_requested_at = @cancelRequestedAt"); params.cancelRequestedAt = patch.cancelRequestedAt; }
    if (patch.canonicalCheckpointId !== undefined) { sets.push("canonical_checkpoint_id = @canonicalCheckpointId"); params.canonicalCheckpointId = patch.canonicalCheckpointId; }
    if (patch.canonicalStateHash !== undefined) { sets.push("canonical_state_hash = @canonicalStateHash"); params.canonicalStateHash = patch.canonicalStateHash; }
    if (TERMINAL.has(patch.status)) { sets.push("terminal_at = @terminalAt"); params.terminalAt = at; }
    return { sql: `UPDATE agent_runs SET ${sets.join(", ")} WHERE run_id = @runId AND state_version = @expectedStateVersion AND lease_epoch = @leaseEpoch`, params };
  }

  const commitState = db.transaction(({ runId, expectedStateVersion, leaseEpoch, patch }) => {
    const at = now();
    const { sql, params } = updateRunPatch(runId, patch, at);
    const result = db.prepare(sql).run({ ...params, expectedStateVersion, leaseEpoch });
    if (result.changes !== 1) {
      const row = db.prepare("SELECT lease_epoch, state_version FROM agent_runs WHERE run_id=?").get(runId);
      if (!row) fail("NOT_FOUND", 404);
      if (row.lease_epoch !== leaseEpoch) fail("STALE_RUN_LEASE");
      fail("STATE_VERSION_CONFLICT");
    }
    return mapRun(db.prepare("SELECT * FROM agent_runs WHERE run_id=?").get(runId));
  });

  const claimRun = db.transaction(({ runId, workerId, leaseMs }) => {
    const at = now();
    const row = db.prepare("SELECT * FROM agent_runs WHERE run_id=?").get(runId);
    if (!row) fail("NOT_FOUND", 404);
    if (TERMINAL.has(row.status)) fail("RUN_ALREADY_TERMINAL");
    if (row.lease_owner && row.lease_owner !== workerId && row.lease_expires_at && row.lease_expires_at > at) fail("RUN_LEASE_HELD");
    const expiresAt = new Date(Date.parse(at) + leaseMs).toISOString();
    db.prepare("UPDATE agent_runs SET lease_epoch=lease_epoch+1, lease_owner=?, lease_expires_at=?, status=CASE WHEN status='queued' THEN 'running' ELSE status END, updated_at=? WHERE run_id=?").run(workerId, expiresAt, at, runId);
    return mapRun(db.prepare("SELECT * FROM agent_runs WHERE run_id=?").get(runId));
  });

  const createInteraction = db.transaction(({ actor, runId, leaseEpoch, kind, payload, expiresAt }) => {
    const at = now();
    const run = getRunRowByActor(actor, runId);
    if (run.lease_epoch !== leaseEpoch) fail("STALE_RUN_LEASE");
    const interactionId = randomUUID();
    db.prepare("INSERT INTO agent_interactions(interaction_id,run_id,kind,status,payload_json,scope_hash,expires_at,created_at) VALUES(?,?,?,'pending',?,?,?,?)").run(interactionId, runId, kind, JSON.stringify(payload), actor.scopeHash, expiresAt, at);
    db.prepare("UPDATE agent_runs SET status=?, state_version=state_version+1, updated_at=? WHERE run_id=?").run(kind === "approval" ? "waiting_for_approval" : "waiting_for_clarification", at, runId);
    db.prepare("UPDATE agent_threads SET thread_version=thread_version+1, updated_at=? WHERE thread_id=?").run(at, run.thread_id);
    const threadVersion = db.prepare("SELECT thread_version FROM agent_threads WHERE thread_id=?").pluck().get(run.thread_id);
    return { interactionId, runId, kind, status: "pending", threadVersion, payload, expiresAt };
  });

  const appendMessage = db.transaction(({ actor, threadId, runId = null, messageId, parentMessageId = null, role, body, scopeHash }) => {
    getThreadRow(actor, threadId);
    const at = now();
    db.prepare("INSERT INTO agent_messages(message_id,thread_id,run_id,parent_message_id,role,body_json,scope_hash,created_at) VALUES(?,?,?,?,?,?,?,?)").run(messageId, threadId, runId, parentMessageId, role, JSON.stringify(body), scopeHash, at);
    return mapMessage(db.prepare("SELECT * FROM agent_messages WHERE message_id=?").get(messageId));
  });

  const renewLease = db.transaction(({ runId, leaseEpoch, workerId, leaseMs }) => {
    const at = now();
    const expiresAt = new Date(Date.parse(at) + leaseMs).toISOString();
    const result = db.prepare("UPDATE agent_runs SET lease_owner=?, lease_expires_at=?, updated_at=? WHERE run_id=? AND lease_epoch=?").run(workerId, expiresAt, at, runId, leaseEpoch);
    if (result.changes !== 1) fail("STALE_RUN_LEASE");
    return mapRun(db.prepare("SELECT * FROM agent_runs WHERE run_id=?").get(runId));
  });

  const consumeInteraction = db.transaction(({ actor, runId, interactionId, threadVersion, value }) => {
    const at = now();
    const run = getRunRowByActor(actor, runId);
    const thread = getThreadRow(actor, run.thread_id);
    const interaction = db.prepare("SELECT * FROM agent_interactions WHERE interaction_id=? AND run_id=?").get(interactionId, runId);
    if (!interaction) fail("INTERACTION_NOT_FOUND", 404);
    if (thread.thread_version !== threadVersion) fail("THREAD_VERSION_CONFLICT");
    if (interaction.status === "consumed") {
      if (interaction.result_json !== stableJson(value)) fail("INTERACTION_ALREADY_CONSUMED");
      return { interactionId, status: "consumed", result: JSON.parse(interaction.result_json) };
    }
    if (interaction.status !== "pending") fail(interaction.status === "expired" ? "INTERACTION_EXPIRED" : "INTERACTION_ALREADY_CONSUMED");
    db.prepare("UPDATE agent_interactions SET status='consumed', result_json=?, consumed_at=? WHERE interaction_id=?").run(stableJson(value), at, interactionId);
    db.prepare("UPDATE agent_runs SET status='running', lease_epoch=lease_epoch+1, state_version=state_version+1, updated_at=? WHERE run_id=?").run(at, runId);
    db.prepare("UPDATE agent_threads SET thread_version=thread_version+1, updated_at=? WHERE thread_id=?").run(at, run.thread_id);
    return { interactionId, status: "consumed", result: value };
  });

  const terminalize = db.transaction(({ actor, runId, expectedThreadVersion, status, event, patch = {} }) => {
    assertWriter(writeEventsInTransaction);
    const at = now();
    const run = getRunRowByActor(actor, runId);
    const thread = getThreadRow(actor, run.thread_id);
    if (expectedThreadVersion !== undefined && thread.thread_version !== expectedThreadVersion) fail("THREAD_VERSION_CONFLICT");
    if (TERMINAL.has(run.status)) return mapRun(run);
    db.prepare("UPDATE agent_interactions SET status='cancelled' WHERE run_id=? AND status='pending'").run(runId);
    db.prepare("UPDATE agent_runs SET status=@status, state_version=state_version+1, lease_epoch=lease_epoch+1, updated_at=@updatedAt, terminal_at=@terminalAt, answer_json=COALESCE(@answerJson, answer_json), error_json=COALESCE(@errorJson, error_json) WHERE run_id=@runId").run({ status, updatedAt: at, terminalAt: at, answerJson: patch.answerJson ? JSON.stringify(patch.answerJson) : null, errorJson: patch.errorJson ? JSON.stringify(patch.errorJson) : null, runId });
    db.prepare("UPDATE agent_threads SET thread_version=thread_version+1, updated_at=? WHERE thread_id=?").run(at, run.thread_id);
    const nextThreadVersion = db.prepare("SELECT thread_version FROM agent_threads WHERE thread_id=?").pluck().get(run.thread_id);
    const updatedRun = db.prepare("SELECT * FROM agent_runs WHERE run_id=?").get(runId);
    writeEventsInTransaction(db, { run: updatedRun, stateVersion: updatedRun.state_version, leaseEpoch: updatedRun.lease_epoch, eventInputs: [{ ...event, payload: { ...(event.payload || {}), threadVersion: nextThreadVersion } }] });
    return mapRun(db.prepare("SELECT * FROM agent_runs WHERE run_id=?").get(runId));
  });

  return {
    createThread,
    getThread: ({ actor, threadId }) => mapThread(getThreadRow(actor, threadId)),
    updateThread: ({ actor, threadId, patch }) => {
      const thread = getThreadRow(actor, threadId);
      const at = now();
      db.prepare("UPDATE agent_threads SET title=COALESCE(@title,title), pinned=COALESCE(@pinned,pinned), archived=COALESCE(@archived,archived), deleted_at=COALESCE(@deletedAt,deleted_at), thread_version=thread_version+1, updated_at=@updatedAt WHERE thread_id=@threadId").run({ threadId, title: patch.title ?? null, pinned: patch.pinned == null ? null : Number(patch.pinned), archived: patch.archived == null ? null : Number(patch.archived), deletedAt: patch.deleted ? at : null, updatedAt: at });
      return mapThread(db.prepare("SELECT * FROM agent_threads WHERE thread_id=?").get(thread.thread_id));
    },
    importLegacyThread: createThread,
    forkThread: createThread,
    appendMessage,
    listMessages: ({ actor, threadId }) => {
      getThreadRow(actor, threadId);
      return db.prepare("SELECT * FROM agent_messages WHERE thread_id=? ORDER BY created_at, message_id").all(threadId).map(mapMessage);
    },
    createRun,
    getRun: ({ actor, runId }) => mapRun(getRunRowByActor(actor, runId)),
    claimRun,
    renewLease,
    assertLease: ({ runId, leaseEpoch }) => {
      const row = db.prepare("SELECT lease_epoch FROM agent_runs WHERE run_id=?").get(runId);
      if (!row) fail("NOT_FOUND", 404);
      if (row.lease_epoch !== leaseEpoch) fail("STALE_RUN_LEASE");
    },
    commitState,
    promoteCanonicalCheckpoint: ({ runId, expectedStateVersion, leaseEpoch, checkpointId, stateHash }) => commitState({ runId, expectedStateVersion, leaseEpoch, patch: { canonicalCheckpointId: checkpointId, canonicalStateHash: stateHash } }),
    createInteraction,
    consumeInteraction,
    cancelRun: ({ actor, runId, threadVersion, reasonCode }) => terminalize({ actor, runId, expectedThreadVersion: threadVersion, status: "cancelled", event: { type: "run.cancelled", payload: { reasonCode } } }),
    completeRun: ({ actor, runId, threadVersion, answer, assistantMessageId, durationMs }) => terminalize({ actor, runId, expectedThreadVersion: threadVersion, status: "completed", patch: { answerJson: answer }, event: { type: "run.completed", payload: { answerId: answer?.answerId || assistantMessageId, durationMs } } }),
    failRun: ({ actor, runId, threadVersion, error }) => terminalize({ actor, runId, expectedThreadVersion: threadVersion, status: "failed", patch: { errorJson: error }, event: { type: "run.failed", payload: error } }),
    listExpiredInteractions: ({ asOf }) => db.prepare("SELECT * FROM agent_interactions WHERE status='pending' AND expires_at <= ?").all(asOf),
    listRecoverableRuns: ({ asOf }) => db.prepare("SELECT * FROM agent_runs WHERE status IN ('queued','running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?").all(asOf).map(mapRun),
    reapExpiredRun: ({ actor, runId, code = "RUN_DEADLINE_EXCEEDED" }) => terminalize({ actor, runId, status: "failed", event: { type: "run.failed", payload: { code, safeMessage: code, retryable: false } }, patch: { errorJson: { code, safeMessage: code, retryable: false } } }),
  };
}