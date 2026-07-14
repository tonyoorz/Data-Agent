import { GRAPH_DEFINITION_VERSION } from "./contracts.mjs";

function fail(code, statusCode = 409, extra = {}) {
  throw Object.assign(new Error(code), { code, statusCode, retryable: false, ...extra });
}

function hashRequest(request) {
  return JSON.stringify({ text: request.message.text, selectedModel: request.selectedModel, useDefectContext: request.useDefectContext, useAnalyticsContext: request.useAnalyticsContext, artifactRefs: request.message.artifactRefs || [], threadId: request.threadId || null, threadVersion: request.threadVersion });
}

export function createAgentRuntime({ db, contracts, threadStore, eventStore, auditStore, policy, now, nowMs, randomUUID, executeClaimedRun = async () => undefined }) {
  function counts(actor, threadId) {
    return {
      threadActive: threadId ? Number(db.prepare("SELECT COUNT(*) FROM agent_runs WHERE thread_id=? AND status IN ('queued','running','waiting_for_clarification','waiting_for_approval')").pluck().get(threadId)) : 0,
      actorActive: Number(db.prepare("SELECT COUNT(*) FROM agent_runs WHERE actor_id=? AND status IN ('queued','running','waiting_for_clarification','waiting_for_approval')").pluck().get(actor.actorId)),
      globalActive: Number(db.prepare("SELECT COUNT(*) FROM agent_runs WHERE status IN ('queued','running','waiting_for_clarification','waiting_for_approval')").pluck().get()),
    };
  }

  function rateState(actor) {
    const row = db.prepare("SELECT * FROM agent_actor_rate_limits WHERE actor_id=?").get(actor.actorId);
    return row ? { tokens: row.tokens, updatedAtMs: row.updated_at_ms, nowMs: nowMs() } : { tokens: 5, updatedAtMs: nowMs(), nowMs: nowMs() };
  }

  function saveRate(actor, state) {
    db.prepare("INSERT OR REPLACE INTO agent_actor_rate_limits(actor_id,tokens,updated_at_ms) VALUES(?,?,?)").run(actor.actorId, state.tokens, state.updatedAtMs);
  }

  async function startRun({ actor, request }) {
    contracts.validateRunRequest(request);
    const existing = db.prepare("SELECT * FROM agent_runs WHERE actor_id=? AND message_id=?").get(actor.actorId, request.messageId);
    if (existing) {
      if (existing.request_hash !== hashRequest(request)) fail("IDEMPOTENCY_CONFLICT", 409);
      return { threadId: existing.thread_id, runId: existing.run_id, threadVersion: db.prepare("SELECT thread_version FROM agent_threads WHERE thread_id=?").pluck().get(existing.thread_id), firstEventId: eventStore.listAfter({ actor, runId: existing.run_id })[0]?.eventId, idempotentReplay: true };
    }
    const thread = request.threadId ? threadStore.getThread({ actor, threadId: request.threadId }) : threadStore.createThread({ actor, title: "新对话" });
    const run = db.transaction(() => {
      const newRate = policy.authorizeRunStart({ actor, counts: counts(actor, thread.threadId), rateState: rateState(actor) });
      saveRate(actor, newRate);
      threadStore.appendMessage({ actor, threadId: thread.threadId, messageId: request.messageId, role: "user", body: request.message, scopeHash: actor.scopeHash });
      return threadStore.createRun({ actor, threadId: thread.threadId, expectedThreadVersion: thread.threadVersion, messageId: request.messageId, requestHash: hashRequest(request), graphDefinitionVersion: GRAPH_DEFINITION_VERSION, runtimeMode: "langgraph", requestedModelId: request.selectedModel, actualModelId: request.selectedModel, modelConfigVersion: "runtime-test", activeExecutionBudgetMs: 120000, hardExpiresAt: new Date(Date.parse(now()) + 24 * 60 * 60 * 1000).toISOString() });
    })();
    const lease = threadStore.claimRun({ runId: run.runId, workerId: randomUUID(), leaseMs: 30000 });
    const started = eventStore.commitTransition({ actor, runId: run.runId, expectedStateVersion: lease.stateVersion, leaseEpoch: lease.leaseEpoch, patch: { status: "running" }, eventInputs: [{ type: "run.started", payload: { threadVersion: thread.threadVersion, runtimeMode: "langgraph", requestedModelId: request.selectedModel, actualModelId: request.selectedModel } }] });
    auditStore.append({ actor, threadId: thread.threadId, runId: run.runId, action: "runtime.start", details: { requestedModelId: request.selectedModel } });
    void executeClaimedRun({ runId: run.runId, actor }).catch(() => undefined);
    return { threadId: thread.threadId, runId: run.runId, threadVersion: thread.threadVersion, firstEventId: started[0]?.eventId, idempotentReplay: false };
  }

  async function cancelRun({ actor, runId, threadVersion, reasonCode }) {
    const run = threadStore.cancelRun({ actor, runId, threadVersion, reasonCode });
    eventStore.notifier.emit(runId, eventStore.listAfter({ actor, runId }));
    auditStore.append({ actor, threadId: run.threadId, runId, action: "runtime.cancel", details: { reasonCode } });
    return { status: run.status, threadVersion: db.prepare("SELECT thread_version FROM agent_threads WHERE thread_id=?").pluck().get(run.threadId) };
  }

  return Object.freeze({
    startRun,
    cancelRun,
    resumeRun: async () => fail("NOT_IMPLEMENTED", 501),
    recoverRun: async () => null,
    recoverExpiredRuns: async () => [],
    reapExpiredWork: async () => [],
    startBackgroundLoops: () => undefined,
    stopBackgroundLoops: async () => undefined,
    getActiveWorkerCount: () => 0,
  });
}