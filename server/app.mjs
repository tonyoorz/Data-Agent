import http from "node:http";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Command } from "@langchain/langgraph";
import { createAgentHttpRoutes, routeWithErrors } from "./agentRuntime/httpRoutes.mjs";
import { createArtifactStore } from "./agentRuntime/artifactStore.mjs";
import { createAuditStore } from "./agentRuntime/audit.mjs";
import { createCheckpointCoordinator, createReadySqliteSaver } from "./agentRuntime/checkpoint.mjs";
import { createRuntimeConfig } from "./agentRuntime/config.mjs";
import { createContractRegistry, GRAPH_DEFINITION_VERSION } from "./agentRuntime/contracts.mjs";
import { createEventStore } from "./agentRuntime/events.mjs";
import { createMainAgentGraph } from "./agentRuntime/graph.mjs";
import { createIdentityResolver } from "./agentRuntime/identity.mjs";
import { createModelRegistry } from "./agentRuntime/modelRegistry.mjs";
import { createInternalModelAdapter } from "./agentRuntime/modelAdapter.mjs";
import { createRuntimePolicy } from "./agentRuntime/policy.mjs";
import { createAgentRuntime } from "./agentRuntime/runtime.mjs";
import { openRuntimeDb } from "./agentRuntime/runtimeDb.mjs";
import { createStepJournal } from "./agentRuntime/stepJournal.mjs";
import { buildShadowRuntimeResult } from "./agentRuntime/shadow.mjs";
import { createRuntimeTelemetry, safeTelemetryErrorCode } from "./agentRuntime/telemetry.mjs";
import { createThreadStore } from "./agentRuntime/threadStore.mjs";
import { createToolRegistry } from "./agentRuntime/toolRegistry.mjs";
import { createOntologyRegistry } from "./ontology/registry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function createAgentApp(deps = {}) {
  const config = { mode: "legacy", allowedOrigins: [], jsonBodyMaxBytes: 1024 * 1024, ...(deps.config || {}) };
  const agentRoutes = deps.runtime ? createAgentHttpRoutes({ ...deps, config }) : null;
  return async function agentRequestListener(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      let dynamic = {};
      try {
        dynamic = await deps.getHealthStatus?.() || {};
      } catch (error) {
        dynamic = { ready: false, healthError: safeTelemetryErrorCode(error, "HEALTH_CHECK_FAILED") };
      }
      const health = {
        service: "agent-api",
        ready: Boolean(deps.runtime) && dynamic.ready !== false,
        runtimeMode: config.mode,
        graphDefinitionVersion: GRAPH_DEFINITION_VERSION,
        applicationSchemaVersion: 1,
        ontologyVersion: deps.ontologyRegistry?.version || null,
        ontologyFingerprint: deps.ontologyRegistry?.fingerprint || null,
        runtimeDbReady: Boolean(deps.runtimeDbReady),
        saverReady: Boolean(deps.saverReady),
        analyticsReady: false,
        workerCount: deps.runtime?.getActiveWorkerCount?.() || 0,
        ...dynamic,
      };
      response.writeHead(health.ready ? 200 : 503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(health));
      return;
    }
    if (agentRoutes && await routeWithErrors(agentRoutes, request, response, config)) return;
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ code: "NOT_FOUND" }));
  };
}

export function createAgentServer(deps) {
  return http.createServer(createAgentApp(deps));
}

function defaultDevActor(env, allowedObjectTypes = []) {
  return {
    actorId: String(env.MAIN_AGENT_DEV_ACTOR_ID || "dev-local"),
    authSessionId: "dev-local-session",
    roles: ["developer"],
    scopeVersion: String(env.MAIN_AGENT_DEV_SCOPE_VERSION || "dev-v1"),
    scopes: {
      workspaceIds: [String(env.MAIN_AGENT_DEV_WORKSPACE_ID || "DTSV")],
      projectIds: [],
      teamIds: [],
      allowedObjectTypes: allowedObjectTypes.length ? allowedObjectTypes : ["quality.defect"],
      allowedPropertyIds: [],
      rowPolicyIds: ["dev-local"],
      sensitiveFieldPolicyIds: [],
    },
  };
}

function resolveDbPath(env, root) {
  const configured = String(env.VIZION_AGENT_RUNTIME_DB || "database/runtime/agent-runtime.db");
  return path.isAbsolute(configured) ? configured : path.resolve(root, configured);
}

function parseRequestHash(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function safeRunError(error) {
  const rawCode = String(error?.code || "");
  const code = /^[A-Z][A-Z0-9_:-]{2,79}$/.test(rawCode) ? rawCode : "AGENT_RUNTIME_EXECUTION_FAILED";
  return { code, safeMessage: code, retryable: Boolean(error?.retryable) };
}

function isTerminalStatus(status) {
  return ["completed", "failed", "cancelled"].includes(status);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function hashState(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export async function buildProductionDependencies({
  env = process.env,
  logger = console,
  root = repoRoot,
  runDuplicateBridge,
  ensureDuplicateWarmup,
  executeLegacyTool,
  analyticsFetch,
  executionObserver,
  runtimePolicy,
  scopeProvider,
  analyticsHealthCheck,
  telemetry: injectedTelemetry,
  ontologyRegistry: injectedOntologyRegistry,
  modelAdapter: injectedModelAdapter,
  modelFetch,
  now: injectedNow,
  nowMs: injectedNowMs,
} = {}) {
  const config = createRuntimeConfig(env);
  const dbPath = resolveDbPath(env, root);
  const runtimeDb = openRuntimeDb({ dbPath, expectedVersion: 1 });
  const instanceOwnerId = `agent-runtime-${randomUUID()}`;
  const instanceGuardLeaseMs = 30_000;
  runtimeDb.claimSingleInstance({ ownerId: instanceOwnerId, leaseMs: instanceGuardLeaseMs });
  const instanceGuardHeartbeat = setInterval(() => {
    try {
      runtimeDb.renewSingleInstance({ ownerId: instanceOwnerId, leaseMs: instanceGuardLeaseMs });
    } catch (error) {
      logger.error?.("[main-agent] lost SQLite single-instance guard", safeRunError(error).code);
    }
  }, 10_000);
  instanceGuardHeartbeat.unref?.();
  const db = runtimeDb.db;
  const now = injectedNow || (() => new Date().toISOString());
  const nowMs = injectedNowMs || (() => Date.now());
  const contracts = createContractRegistry();
  const ontologyRegistry = injectedOntologyRegistry || createOntologyRegistry({
    root,
    expectedFingerprint: env.VIZION_ONTOLOGY_FINGERPRINT,
  });
  const devActor = defaultDevActor(env, ontologyRegistry.bundle.entities.map((entity) => entity.id));
  const modelRegistry = createModelRegistry({ env, logger });
  const modelAdapter = injectedModelAdapter || createInternalModelAdapter({ registry: modelRegistry, ...(modelFetch ? { fetchImpl: modelFetch } : {}) });
  const policy = runtimePolicy || createRuntimePolicy({
    runStartRatePerMinute: config.runStartRatePerMinute,
    runStartBurst: config.runStartBurst,
  });
  const telemetry = injectedTelemetry || createRuntimeTelemetry({ logger, nowMs });
  let trustedScopeProvider = scopeProvider;
  if (!trustedScopeProvider && config.identityMode === "trusted-proxy" && env.MAIN_AGENT_SCOPE_PROVIDER_URL) {
    const scopeProviderUrl = String(env.MAIN_AGENT_SCOPE_PROVIDER_URL);
    trustedScopeProvider = async (actor) => {
      const response = await fetch(scopeProviderUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actorId: actor.actorId, roles: actor.roles }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw Object.assign(new Error("SCOPE_PROVIDER_UNAVAILABLE"), { code: "SCOPE_PROVIDER_UNAVAILABLE", statusCode: 503 });
      return response.json();
    };
  }
  if (config.identityMode === "trusted-proxy" && typeof trustedScopeProvider !== "function") {
    throw new Error("SCOPE_PROVIDER_REQUIRED");
  }
  const identityResolver = createIdentityResolver({
    mode: config.identityMode,
    trustedProxyAddresses: config.trustedProxyAddresses,
    devActor,
    scopeProvider: trustedScopeProvider,
  });
  const authorizeRun = ({ actor, run }) => {
    if (actor.actorId !== run.actor_id) throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND", statusCode: 404 });
  };
  const eventStore = createEventStore({ db, contracts, now, randomUUID, authorizeRun });
  const threadStore = createThreadStore({ db, now, randomUUID, writeEventsInTransaction: eventStore.writeInTransaction });
  const auditStore = createAuditStore({ db, now, randomUUID });
  const configuredArtifactRoot = String(env.VIZION_AGENT_ARTIFACT_ROOT || "database/runtime/artifacts");
  const artifactRoot = path.isAbsolute(configuredArtifactRoot) ? configuredArtifactRoot : path.resolve(root, configuredArtifactRoot);
  const artifactStore = createArtifactStore({ db, artifactRoot, now, randomUUID });
  const saver = createReadySqliteSaver({ dbPath, runtimeDb });
  const checkpointCoordinator = createCheckpointCoordinator({
    saver,
    threadStore,
    graphDefinitionVersion: GRAPH_DEFINITION_VERSION,
    projectCommittedTransitions: (state) => state,
    hashState,
  });
  const stepJournal = createStepJournal({ db, threadStore, now });
  const toolRegistry = createToolRegistry({
    policy,
    runDuplicateBridge,
    ensureDuplicateWarmup,
    ...(executeLegacyTool ? { executeLegacyTool } : {}),
    ...(analyticsFetch ? { analyticsFetch } : {}),
    analyticsApiBase: String(env.VIZION_ANALYTICS_API_BASE || "http://127.0.0.1:3003"),
    telemetry,
  });

  const notifyRun = (actor, runId) => {
    eventStore.notifier.emit(runId, eventStore.listAfter({ actor, runId }));
  };

  const failExecutionRun = (actor, runId, error) => {
    const safeError = safeRunError(error);
    try {
      threadStore.failRun({ actor, runId, error: safeError });
    } catch (failError) {
      const currentRun = db.prepare("SELECT status,state_version,lease_epoch FROM agent_runs WHERE run_id=? AND actor_id=?").get(runId, actor.actorId);
      if (!currentRun || isTerminalStatus(currentRun.status)) {
        logger.warn?.("[main-agent] run failure terminalization skipped", safeRunError(failError).code);
      } else {
        try {
          eventStore.commitTransition({
            actor,
            runId,
            expectedStateVersion: currentRun.state_version,
            leaseEpoch: currentRun.lease_epoch,
            patch: { status: "failed", errorJson: safeError },
            eventInputs: [{ type: "run.failed", payload: safeError }],
          });
        } catch (transitionError) {
          logger.warn?.("[main-agent] run failure terminalization failed", safeRunError(transitionError).code);
        }
      }
    }
    notifyRun(actor, runId);
  };

  const executeClaimedRun = async ({ runId, actor, resume, initial = false, recovery = false, leaseEpoch }) => {
    const startedAt = Date.now();
    let runSpan;
    let row;
    const recordShadowResult = (details) => {
      if (row?.runtime_mode !== "shadow") return;
      try {
        auditStore.append({ actor, threadId: row.thread_id, runId, action: "runtime.shadow_result", details });
        telemetry.record("agent.shadow.runtime", { runId, status: details.status, groundingStatus: details.groundingStatus, code: details.code, durationMs: details.durationMs });
      } catch (auditError) {
        logger.warn?.("[main-agent] shadow result audit failed", safeRunError(auditError).code);
      }
    };
    try {
      const refreshedActor = await identityResolver.refresh(actor);
      row = db.prepare("SELECT * FROM agent_runs WHERE run_id=? AND actor_id=?").get(runId, refreshedActor.actorId);
      if (!row || row.status !== "running") return;
      runSpan = telemetry.startSpan("agent.run", { runId, graphVersion: GRAPH_DEFINITION_VERSION, runtimeMode: recovery ? "recovery" : row.runtime_mode, recovered: recovery });
      if (refreshedActor.scopeHash !== row.scope_hash) throw Object.assign(new Error("ACTOR_SCOPE_CHANGED"), { code: "ACTOR_SCOPE_CHANGED", statusCode: 403, retryable: false });
      actor = refreshedActor;
      const requestDetails = parseRequestHash(row.request_hash);
      const consumedInteraction = db.prepare("SELECT result_json FROM agent_interactions WHERE run_id=? AND status='consumed' ORDER BY consumed_at DESC LIMIT 1").get(runId);
      const clarification = resume ?? (consumedInteraction?.result_json ? JSON.parse(consumedInteraction.result_json) : undefined);
      modelRegistry.require(row.requested_model_id, { purpose: "planning" });
      const emitEvent = (eventInput) => {
        const current = db.prepare("SELECT state_version, lease_epoch FROM agent_runs WHERE run_id=? AND actor_id=?").get(runId, actor.actorId);
        if (!current) throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND", statusCode: 404 });
        eventStore.commitTransition({
          actor,
          runId,
          expectedStateVersion: current.state_version,
          leaseEpoch: current.lease_epoch,
          patch: {},
          eventInputs: [eventInput],
        });
      };
      const executionContext = {
        signal: new AbortController().signal,
        isCancellationRequested: async () => {
          const current = db.prepare("SELECT status,cancel_requested_at FROM agent_runs WHERE run_id=?").get(runId);
          return !current || current.status === "cancelled" || Boolean(current.cancel_requested_at);
        },
        refreshActor: async () => {
          const current = await identityResolver.refresh(actor);
          if (current.scopeHash !== row.scope_hash) throw Object.assign(new Error("ACTOR_SCOPE_CHANGED"), { code: "ACTOR_SCOPE_CHANGED", status: "denied", retryable: false });
          return current;
        },
        assertCurrentLease: async () => threadStore.assertLease({ runId, leaseEpoch: row.lease_epoch }),
      };
      const graph = createMainAgentGraph({
        policy,
        toolRegistry,
        ontologyRegistry,
        now,
        emitEvent,
        executionContext: { ...executionContext, leaseEpoch },
        checkpointCoordinator,
        stepJournal,
        graphDefinitionVersion: GRAPH_DEFINITION_VERSION,
        modelAdapter,
        telemetry,
        runtimeMode: row.runtime_mode,
        prepareArtifacts: ({ actor: artifactActor, runId: artifactRunId, artifactRefs }) => artifactStore.prepareForRun({ actor: artifactActor, runId: artifactRunId, artifactIds: artifactRefs }),
        loadThreadContext: ({ actor: contextActor, threadId }) => ({
          messages: threadStore.listMessages({ actor: contextActor, threadId }).filter((message) => message.scopeHash === contextActor.scopeHash).slice(-20),
          summaries: threadStore.listSummaries({ actor: contextActor, threadId, limit: 8 }),
        }),
      });
      const persistedRun = threadStore.getRun({ actor, runId });
      const checkpointRun = {
        ...persistedRun,
        graphDefinitionVersion: persistedRun.graphDefinitionVersion,
      };
      const checkpointConfig = checkpointCoordinator.invocationConfigForRun(checkpointRun, { allowUnpromoted: initial || recovery });
      const initialState = {
        runId,
        threadId: row.thread_id,
        actor,
        request: {
          text: String(requestDetails.text || ""),
          artifactRefs: requestDetails.artifactRefs || [],
          selectedModel: row.requested_model_id,
          useDefectContext: requestDetails.useDefectContext === true,
          useAnalyticsContext: requestDetails.useAnalyticsContext === true,
          pageContext: requestDetails.pageContext || null,
        },
      };
      const graphInput = clarification ? new Command({ resume: clarification }) : recovery ? null : initialState;
      await graph.invoke(graphInput, checkpointConfig);
      const runBeforePromotion = threadStore.getRun({ actor, runId });
      const checkpointSpan = telemetry.startSpan("agent.checkpoint.capture", { runId, graphVersion: GRAPH_DEFINITION_VERSION, recovered: recovery });
      const captured = await checkpointCoordinator.captureCanonicalCheckpoint({ graph, run: runBeforePromotion, config: checkpointConfig });
      checkpointSpan.end({ status: "completed" });
      const state = captured.snapshot.values;
      await executionObserver?.({ runId, actor, state });
      telemetry.record("agent.grounding", { runId, evidenceCount: state.evidence?.length || 0, claimCount: state.claims?.length || 0, citationCount: state.answer?.citations?.length || 0, groundingStatus: state.answer?.groundingStatus || "pending" });
      if (state.pendingInteraction) {
        telemetry.record("agent.interrupt", { runId, status: "clarification", ambiguityCount: state.semanticFrame?.ambiguities?.length || 0 });
        if (row.runtime_mode === "shadow") {
          const code = "SHADOW_CLARIFICATION_REQUIRED";
          recordShadowResult(buildShadowRuntimeResult({ state, durationMs: Date.now() - startedAt, status: "clarification_required", code }));
          failExecutionRun(actor, runId, Object.assign(new Error(code), { code, retryable: false }));
          runSpan.end({ status: "failed", code, timeToFinalMs: Date.now() - startedAt });
          return;
        }
        const currentRun = db.prepare("SELECT state_version,lease_epoch FROM agent_runs WHERE run_id=?").get(runId);
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        const interaction = threadStore.createInteraction({ actor, runId, leaseEpoch: currentRun.lease_epoch, kind: "clarification", payload: state.pendingInteraction, expiresAt });
        const waitingRun = db.prepare("SELECT state_version,lease_epoch FROM agent_runs WHERE run_id=?").get(runId);
        eventStore.commitTransition({
          actor,
          runId,
          expectedStateVersion: waitingRun.state_version,
          leaseEpoch: waitingRun.lease_epoch,
          patch: {},
          eventInputs: [{ type: "clarification.required", payload: { interactionId: interaction.interactionId, threadVersion: interaction.threadVersion, question: state.pendingInteraction.question, options: state.pendingInteraction.options || [], responseSchemaRef: `interaction:${interaction.interactionId}:response`, expiresAt } }],
        });
        notifyRun(actor, runId);
        runSpan.end({ status: "interrupted" });
        return;
      }
      threadStore.appendSummary({
        actor,
        threadId: row.thread_id,
        summaryId: `summary-${runId}`,
        body: { runId, semanticFrame: state.semanticFrame },
        sourceMessageIds: [row.message_id],
        semanticFrameRefs: [{ runId, ontologyVersion: state.semanticFrame.ontologyVersion, schemaFingerprint: state.semanticFrame.schemaFingerprint }],
        evidenceRefs: (state.evidence || []).map((item) => item.evidenceId),
        summaryVersion: "semantic-context-v1",
        promptVersion: "deterministic-v1",
        scopeHash: actor.scopeHash,
      });
      const currentRun = db.prepare("SELECT state_version, lease_epoch FROM agent_runs WHERE run_id=?").get(runId);
      const threadVersion = db.prepare("SELECT thread_version FROM agent_threads WHERE thread_id=?").pluck().get(row.thread_id);
      eventStore.appendAnswer({
        actor,
        runId,
        expectedStateVersion: currentRun.state_version,
        leaseEpoch: currentRun.lease_epoch,
        threadVersion,
        answer: state.answer,
        assistantMessageId: randomUUID(),
        durationMs: Date.now() - startedAt,
      });
      recordShadowResult(buildShadowRuntimeResult({ state, durationMs: Date.now() - startedAt }));
      runSpan.end({ status: "completed", evidenceCount: state.evidence?.length || 0, claimCount: state.claims?.length || 0, groundingStatus: state.answer?.groundingStatus, timeToFinalMs: Date.now() - startedAt });
    } catch (error) {
      const code = safeRunError(error).code;
      recordShadowResult(buildShadowRuntimeResult({ durationMs: Date.now() - startedAt, status: "failed", code }));
      runSpan?.end({ status: "failed", code, retryable: Boolean(error?.retryable), timeToFinalMs: Date.now() - startedAt });
      failExecutionRun(actor, runId, error);
      logger.warn?.("[main-agent] run execution failed", code);
    }
  };

  const runtime = createAgentRuntime({ db, contracts, threadStore, eventStore, auditStore, policy, now, nowMs, randomUUID, executeClaimedRun, refreshActor: identityResolver.refresh, modelRegistry, artifactStore, telemetry });
  const checkAnalytics = analyticsHealthCheck || (async () => {
    const url = new URL("/health", String(env.VIZION_ANALYTICS_API_BASE || "http://127.0.0.1:3003")).toString();
    const response = await (analyticsFetch || globalThis.fetch)(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`ANALYTICS_HEALTH_HTTP_${response.status}`);
    return response.json();
  });
  const getHealthStatus = async () => {
    const runtimeDbReady = db.prepare("SELECT 1").pluck().get() === 1;
    const saverReady = Boolean(db.prepare("SELECT 1 FROM agent_saver_migrations WHERE version=?").pluck().get("langgraph-sqlite-1.0.3"));
    let analyticsReady = false;
    let analyticsFingerprint = null;
    try {
      const analytics = await checkAnalytics();
      analyticsFingerprint = analytics?.ontologyFingerprint || null;
      analyticsReady = analytics?.ok === true && analyticsFingerprint === ontologyRegistry.fingerprint;
    } catch {
      analyticsReady = false;
    }
    return {
      ready: runtimeDbReady && saverReady && analyticsReady,
      runtimeDbReady,
      saverReady,
      analyticsReady,
      analyticsFingerprint,
      workerCount: runtime.getActiveWorkerCount(),
      runtimeMode: config.mode,
      graphDefinitionVersion: GRAPH_DEFINITION_VERSION,
      telemetry: telemetry.snapshot(),
    };
  };
  return {
    runtime,
    eventStore,
    threadStore,
    auditStore,
    artifactStore,
    contracts,
    modelRegistry,
    modelAdapter,
    ontologyRegistry,
    identityResolver,
    checkpointCoordinator,
    telemetry,
    config,
    runtimeDbReady: true,
    saverReady: true,
    getHealthStatus,
    cleanup: async () => {
      await runtime.stopBackgroundLoops();
      clearInterval(instanceGuardHeartbeat);
      try { runtimeDb.releaseSingleInstance({ ownerId: instanceOwnerId }); } catch {}
      saver.close();
      runtimeDb.close();
    },
  };
}
