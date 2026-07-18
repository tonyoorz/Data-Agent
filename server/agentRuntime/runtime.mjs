import { GRAPH_DEFINITION_VERSION } from "./contracts.mjs";

function fail(code, statusCode = 409, extra = {}) {
  throw Object.assign(new Error(code), { code, statusCode, retryable: false, ...extra });
}

function hashRequest(request) {
  return JSON.stringify({ text: request.message.text, selectedModel: request.selectedModel, useDefectContext: request.useDefectContext, useAnalyticsContext: request.useAnalyticsContext, artifactRefs: request.message.artifactRefs || [], pageContext: request.pageContext || null, threadId: request.threadId || null, threadVersion: request.threadVersion });
}

export function createAgentRuntime({ db, contracts, threadStore, eventStore, auditStore, policy, now, nowMs, randomUUID, executeClaimedRun = async () => undefined, refreshActor, modelRegistry, artifactStore, telemetry, leaseMs = 30000, leaseRenewIntervalMs = 10000, backgroundIntervalMs = 1000 }) {
  const activeExecutions = new Map();
  let backgroundTimer;
  let backgroundTickRunning = false;

  function scheduleExecution(input) {
    if (activeExecutions.has(input.runId)) return activeExecutions.get(input.runId);
    let heartbeat;
    const promise = Promise.resolve().then(async () => {
      if (input.workerId && Number.isInteger(input.leaseEpoch)) {
        heartbeat = setInterval(() => {
          try {
            threadStore.renewLease({ runId: input.runId, leaseEpoch: input.leaseEpoch, workerId: input.workerId, leaseMs });
          } catch {
            clearInterval(heartbeat);
          }
        }, leaseRenewIntervalMs);
        heartbeat.unref?.();
      }
      return executeClaimedRun(input);
    }).catch(() => undefined).finally(() => {
      if (heartbeat) clearInterval(heartbeat);
      activeExecutions.delete(input.runId);
    });
    activeExecutions.set(input.runId, promise);
    return promise;
  }
  function counts(actor, threadId) {
    return {
      threadActive: threadId ? Number(db.prepare("SELECT COUNT(*) FROM agent_runs WHERE thread_id=? AND status IN ('queued','running','waiting_for_clarification','waiting_for_approval')").pluck().get(threadId)) : 0,
      actorActive: Number(db.prepare("SELECT COUNT(*) FROM agent_runs WHERE actor_id=? AND status IN ('queued','running','waiting_for_clarification','waiting_for_approval')").pluck().get(actor.actorId)),
      globalActive: Number(db.prepare("SELECT COUNT(*) FROM agent_runs WHERE status IN ('queued','running','waiting_for_clarification','waiting_for_approval')").pluck().get()),
    };
  }

  function rateState(actor) {
    const row = db.prepare("SELECT * FROM agent_actor_rate_limits WHERE actor_id=?").get(actor.actorId);
    const initialTokens = policy.rateLimit?.burst ?? 5;
    return row ? { tokens: row.tokens, updatedAtMs: row.updated_at_ms, nowMs: nowMs() } : { tokens: initialTokens, updatedAtMs: nowMs(), nowMs: nowMs() };
  }

  function saveRate(actor, state) {
    db.prepare("INSERT OR REPLACE INTO agent_actor_rate_limits(actor_id,tokens,updated_at_ms) VALUES(?,?,?)").run(actor.actorId, state.tokens, state.updatedAtMs);
  }

  async function startRun({ actor, request, runtimeMode = "langgraph" }) {
    const admissionStartedAt = nowMs();
    const span = telemetry?.startSpan("agent.run.admission", { runtimeMode, modelId: request?.selectedModel });
    try {
      if (!["shadow", "langgraph"].includes(runtimeMode)) fail("AGENT_RUNTIME_NOT_ENABLED", 409);
      contracts.validateRunRequest(request);
      const selectedModel = modelRegistry?.require(request.selectedModel, { purpose: "planning" });
      const existing = db.prepare("SELECT * FROM agent_runs WHERE actor_id=? AND message_id=?").get(actor.actorId, request.messageId);
      if (existing) {
        if (existing.request_hash !== hashRequest(request)) fail("IDEMPOTENCY_CONFLICT", 409);
        const result = { threadId: existing.thread_id, runId: existing.run_id, threadVersion: db.prepare("SELECT thread_version FROM agent_threads WHERE thread_id=?").pluck().get(existing.thread_id), firstEventId: eventStore.listAfter({ actor, runId: existing.run_id })[0]?.eventId, idempotentReplay: true };
        span?.end({ status: "replayed", runId: existing.run_id, firstEventMs: Math.max(0, nowMs() - admissionStartedAt) });
        return result;
      }
      const thread = request.threadId ? threadStore.getThread({ actor, threadId: request.threadId }) : threadStore.createThread({ actor, title: "新对话" });
      const run = db.transaction(() => {
        const newRate = policy.authorizeRunStart({ actor, counts: counts(actor, thread.threadId), rateState: rateState(actor) });
        saveRate(actor, newRate);
        threadStore.appendMessage({ actor, threadId: thread.threadId, messageId: request.messageId, role: "user", body: request.message, scopeHash: actor.scopeHash });
        const created = threadStore.createRun({ actor, threadId: thread.threadId, expectedThreadVersion: thread.threadVersion, messageId: request.messageId, requestHash: hashRequest(request), graphDefinitionVersion: GRAPH_DEFINITION_VERSION, runtimeMode, requestedModelId: request.selectedModel, actualModelId: selectedModel?.id || request.selectedModel, modelConfigVersion: selectedModel?.configVersion || "runtime-test", activeExecutionBudgetMs: 120000, hardExpiresAt: new Date(Date.parse(now()) + 24 * 60 * 60 * 1000).toISOString() });
        artifactStore?.attachToRun({ actor, runId: created.runId, artifactIds: request.message.artifactRefs || [] });
        return created;
      })();
      const workerId = randomUUID();
      const lease = threadStore.claimRun({ runId: run.runId, workerId, leaseMs });
      const started = eventStore.commitTransition({ actor, runId: run.runId, expectedStateVersion: lease.stateVersion, leaseEpoch: lease.leaseEpoch, patch: { status: "running" }, eventInputs: [{ type: "run.started", payload: { threadVersion: thread.threadVersion, runtimeMode, requestedModelId: request.selectedModel, actualModelId: selectedModel?.id || request.selectedModel } }] });
      auditStore.append({ actor, threadId: thread.threadId, runId: run.runId, action: "runtime.start", details: { requestedModelId: request.selectedModel } });
      scheduleExecution({ runId: run.runId, actor, workerId, leaseEpoch: lease.leaseEpoch, initial: true });
      const result = { threadId: thread.threadId, runId: run.runId, threadVersion: thread.threadVersion, firstEventId: started[0]?.eventId, idempotentReplay: false };
      span?.end({ status: "admitted", runId: run.runId, firstEventMs: Math.max(0, nowMs() - admissionStartedAt) });
      return result;
    } catch (error) {
      span?.end({ status: "failed", code: error?.code || "RUN_ADMISSION_FAILED" });
      throw error;
    }
  }

  async function cancelRun({ actor, runId, threadVersion, reasonCode }) {
    const run = threadStore.cancelRun({ actor, runId, threadVersion, reasonCode });
    eventStore.notifier.emit(runId, eventStore.listAfter({ actor, runId }));
    auditStore.append({ actor, threadId: run.threadId, runId, action: "runtime.cancel", details: { reasonCode } });
    return { status: run.status, threadVersion: db.prepare("SELECT thread_version FROM agent_threads WHERE thread_id=?").pluck().get(run.threadId) };
  }

  async function resumeRun({ actor, runId, interactionId, threadVersion, value }) {
    const span = telemetry?.startSpan("agent.interaction.resume", { runId });
    try {
      const interactionRow = db.prepare("SELECT payload_json FROM agent_interactions WHERE interaction_id=? AND run_id=?").get(interactionId, runId);
      if (!interactionRow) fail("INTERACTION_NOT_FOUND", 404);
      const interactionPayload = JSON.parse(interactionRow.payload_json);
      if (interactionPayload?.responseSchema) {
        const validateResponse = contracts.compileToolSchema(interactionPayload.responseSchema, "INTERACTION_RESPONSE_SCHEMA");
        if (!validateResponse(value)) fail("INVALID_INTERACTION_RESPONSE", 400);
      }
      const consumed = threadStore.consumeInteraction({ actor, runId, interactionId, threadVersion, value });
      const run = threadStore.getRun({ actor, runId });
      const nextThreadVersion = db.prepare("SELECT thread_version FROM agent_threads WHERE thread_id=?").pluck().get(run.threadId);
      eventStore.commitTransition({
        actor,
        runId,
        expectedStateVersion: run.stateVersion,
        leaseEpoch: run.leaseEpoch,
        patch: {},
        eventInputs: [{ type: "run.resumed", payload: { interactionId, threadVersion: nextThreadVersion } }],
      });
      auditStore.append({ actor, threadId: run.threadId, runId, action: "runtime.resume", details: { interactionId } });
      if (/取消/.test(String(value?.selection || ""))) {
        const cancelled = threadStore.cancelRun({ actor, runId, threadVersion: nextThreadVersion, reasonCode: "clarification_cancelled" });
        eventStore.notifier.emit(runId, eventStore.listAfter({ actor, runId }));
        const result = { runId, interactionId: consumed.interactionId, status: cancelled.status, threadVersion: db.prepare("SELECT thread_version FROM agent_threads WHERE thread_id=?").pluck().get(run.threadId) };
        span?.end({ status: "cancelled" });
        return result;
      }
      const workerId = randomUUID();
      const claimed = threadStore.claimRun({ runId, workerId, leaseMs });
      scheduleExecution({ runId, actor, resume: value, workerId, leaseEpoch: claimed.leaseEpoch });
      const updated = threadStore.getRun({ actor, runId });
      const result = { runId, interactionId: consumed.interactionId, status: updated.status, threadVersion: nextThreadVersion };
      span?.end({ status: "resumed" });
      return result;
    } catch (error) {
      span?.end({ status: "failed", code: error?.code || "RESUME_FAILED" });
      throw error;
    }
  }

  async function actorFromRunRow(row) {
    const stored = { actorId: row.actor_id, authSessionId: "recovery", roles: [], scopes: {}, scopeVersion: row.scope_version, scopeHash: row.scope_hash };
    const current = typeof refreshActor === "function" ? await refreshActor(stored) : stored;
    if (current.scopeHash !== row.scope_hash) fail("ACTOR_SCOPE_CHANGED", 403);
    return current;
  }

  async function recoverRun({ runId, workerId = randomUUID() }) {
    const span = telemetry?.startSpan("agent.recovery", { runId, recovered: true });
    try {
      const row = db.prepare("SELECT * FROM agent_runs WHERE run_id=?").get(runId);
      if (!row) fail("NOT_FOUND", 404);
      const recovered = threadStore.claimRun({ runId, workerId, leaseMs });
      const actor = await actorFromRunRow(row);
      auditStore.append({ actor, threadId: recovered.threadId, runId, action: "runtime.recover", details: { workerId } });
      scheduleExecution({ runId, actor, workerId, leaseEpoch: recovered.leaseEpoch, recovery: true });
      span?.end({ status: "scheduled" });
      return recovered;
    } catch (error) {
      span?.end({ status: "failed", code: error?.code || "RECOVERY_FAILED" });
      throw error;
    }
  }

  async function recoverExpiredRuns() {
    const rows = threadStore.listRecoverableRuns({ asOf: now() });
    const recovered = [];
    for (const row of rows) {
      recovered.push(await recoverRun({ runId: row.runId }));
    }
    return recovered;
  }

  async function reapExpiredWork() {
    const deadlineRuns = threadStore.listDeadlineExceededRuns({ asOf: now() });
    const results = [];
    for (const deadlineRun of deadlineRuns) {
      const runRow = db.prepare("SELECT * FROM agent_runs WHERE run_id=?").get(deadlineRun.runId);
      if (!runRow || ["completed", "failed", "cancelled"].includes(runRow.status)) continue;
      const actor = await actorFromRunRow(runRow);
      threadStore.reapExpiredRun({ actor, runId: deadlineRun.runId, code: "RUN_DEADLINE_EXCEEDED" });
      auditStore.append({ actor, threadId: runRow.thread_id, runId: deadlineRun.runId, action: "runtime.reap", details: { code: "RUN_DEADLINE_EXCEEDED" } });
      results.push({ runId: deadlineRun.runId, code: "RUN_DEADLINE_EXCEEDED" });
    }
    const expiredInteractions = threadStore.listExpiredInteractions({ asOf: now() });
    for (const interaction of expiredInteractions) {
      const runRow = db.prepare("SELECT * FROM agent_runs WHERE run_id=?").get(interaction.run_id);
      if (!runRow || ["completed", "failed", "cancelled"].includes(runRow.status)) continue;
      const actor = await actorFromRunRow(runRow);
      db.prepare("UPDATE agent_interactions SET status='expired' WHERE interaction_id=? AND status='pending'").run(interaction.interaction_id);
      db.prepare("UPDATE agent_threads SET thread_version=thread_version+1, updated_at=? WHERE thread_id=?").run(now(), runRow.thread_id);
      const threadVersion = db.prepare("SELECT thread_version FROM agent_threads WHERE thread_id=?").pluck().get(runRow.thread_id);
      const code = "INTERACTION_EXPIRED";
      eventStore.commitTransition({
        actor,
        runId: runRow.run_id,
        expectedStateVersion: runRow.state_version,
        leaseEpoch: runRow.lease_epoch,
        patch: { status: "failed", errorJson: { code, safeMessage: code, retryable: false } },
        eventInputs: [
          { type: "interaction.expired", payload: { interactionId: interaction.interaction_id, kind: interaction.kind, threadVersion } },
          { type: "run.failed", payload: { code, safeMessage: code, retryable: false, threadVersion } },
        ],
      });
      auditStore.append({ actor, threadId: runRow.thread_id, runId: runRow.run_id, action: "runtime.reap", details: { code, interactionId: interaction.interaction_id } });
      results.push({ runId: runRow.run_id, code });
    }
    return results;
  }

  async function backgroundTick() {
    if (backgroundTickRunning) return;
    backgroundTickRunning = true;
    try {
      await reapExpiredWork();
      await recoverExpiredRuns();
    } finally {
      backgroundTickRunning = false;
    }
  }

  function startBackgroundLoops() {
    if (backgroundTimer) return;
    void backgroundTick().catch(() => undefined);
    backgroundTimer = setInterval(() => void backgroundTick().catch(() => undefined), backgroundIntervalMs);
    backgroundTimer.unref?.();
  }

  async function stopBackgroundLoops() {
    if (backgroundTimer) clearInterval(backgroundTimer);
    backgroundTimer = undefined;
    await Promise.allSettled([...activeExecutions.values()]);
  }

  return Object.freeze({
    startRun,
    cancelRun,
    resumeRun,
    recoverRun,
    recoverExpiredRuns,
    reapExpiredWork,
    startBackgroundLoops,
    stopBackgroundLoops,
    getActiveWorkerCount: () => activeExecutions.size,
  });
}
