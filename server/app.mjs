import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createAgentHttpRoutes, routeWithErrors } from "./agentRuntime/httpRoutes.mjs";
import { createAuditStore } from "./agentRuntime/audit.mjs";
import { createRuntimeConfig } from "./agentRuntime/config.mjs";
import { createContractRegistry } from "./agentRuntime/contracts.mjs";
import { createEventStore } from "./agentRuntime/events.mjs";
import { createMainAgentGraph } from "./agentRuntime/graph.mjs";
import { createIdentityResolver } from "./agentRuntime/identity.mjs";
import { createModelRegistry } from "./agentRuntime/modelRegistry.mjs";
import { createRuntimePolicy } from "./agentRuntime/policy.mjs";
import { createAgentRuntime } from "./agentRuntime/runtime.mjs";
import { openRuntimeDb } from "./agentRuntime/runtimeDb.mjs";
import { createThreadStore } from "./agentRuntime/threadStore.mjs";
import { createToolRegistry } from "./agentRuntime/toolRegistry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function createAgentApp(deps = {}) {
  const config = { mode: "legacy", allowedOrigins: [], jsonBodyMaxBytes: 1024 * 1024, ...(deps.config || {}) };
  const agentRoutes = deps.runtime ? createAgentHttpRoutes({ ...deps, config }) : null;
  return async function agentRequestListener(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ service: "agent-api", ready: Boolean(deps.runtime), runtimeMode: config.mode, graphDefinitionVersion: "main-agent-v1", applicationSchemaVersion: 1, saverReady: true, analyticsReady: true }));
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

function defaultDevActor(env) {
  return {
    actorId: String(env.MAIN_AGENT_DEV_ACTOR_ID || "dev-local"),
    authSessionId: "dev-local-session",
    roles: ["developer"],
    scopeVersion: String(env.MAIN_AGENT_DEV_SCOPE_VERSION || "dev-v1"),
    scopes: {
      workspaceIds: [String(env.MAIN_AGENT_DEV_WORKSPACE_ID || "DTSV")],
      projectIds: [],
      teamIds: [],
      allowedObjectTypes: ["defect"],
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
  const code = String(error?.code || error?.message || "AGENT_RUNTIME_EXECUTION_FAILED").slice(0, 80);
  return { code, safeMessage: code, retryable: Boolean(error?.retryable) };
}

function isTerminalStatus(status) {
  return ["completed", "failed", "cancelled"].includes(status);
}

export async function buildProductionDependencies({ env = process.env, logger = console, root = repoRoot, runDuplicateBridge, ensureDuplicateWarmup } = {}) {
  const config = createRuntimeConfig(env);
  const runtimeDb = openRuntimeDb({ dbPath: resolveDbPath(env, root), expectedVersion: 1 });
  const db = runtimeDb.db;
  const now = () => new Date().toISOString();
  const nowMs = () => Date.now();
  const contracts = createContractRegistry();
  const modelRegistry = createModelRegistry({ env, logger });
  const policy = createRuntimePolicy();
  const identityResolver = createIdentityResolver({
    mode: config.identityMode,
    trustedProxyAddresses: config.trustedProxyAddresses,
    devActor: defaultDevActor(env),
    scopeProvider: async (actor) => ({ scopeVersion: String(env.MAIN_AGENT_SCOPE_VERSION || "trusted-v1"), scopes: defaultDevActor(env).scopes, actorId: actor.actorId }),
  });
  const authorizeRun = ({ actor, run }) => {
    if (actor.actorId !== run.actor_id) throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND", statusCode: 404 });
  };
  const eventStore = createEventStore({ db, contracts, now, randomUUID, authorizeRun });
  const threadStore = createThreadStore({ db, now, randomUUID, writeEventsInTransaction: eventStore.writeInTransaction });
  const auditStore = createAuditStore({ db, now, randomUUID });
  const toolRegistry = createToolRegistry({ policy, runDuplicateBridge, ensureDuplicateWarmup });

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
        logger.warn?.("[main-agent] run failure terminalization skipped", failError);
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
          logger.warn?.("[main-agent] run failure terminalization failed", transitionError);
        }
      }
    }
    notifyRun(actor, runId);
  };

  const executeClaimedRun = async ({ runId, actor }) => {
    const startedAt = Date.now();
    const row = db.prepare("SELECT * FROM agent_runs WHERE run_id=? AND actor_id=?").get(runId, actor.actorId);
    if (!row || row.status !== "running") return;
    const requestDetails = parseRequestHash(row.request_hash);
    try {
      const graph = createMainAgentGraph({ policy, toolRegistry, now });
      const state = await graph.invoke({
        actor,
        request: {
          text: String(requestDetails.text || ""),
          artifactRefs: requestDetails.artifactRefs || [],
          selectedModel: row.requested_model_id,
          useDefectContext: requestDetails.useDefectContext === true,
          useAnalyticsContext: requestDetails.useAnalyticsContext === true,
        },
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
    } catch (error) {
      failExecutionRun(actor, runId, error);
      logger.warn?.("[main-agent] run execution failed", error);
    }
  };

  const runtime = createAgentRuntime({ db, contracts, threadStore, eventStore, auditStore, policy, now, nowMs, randomUUID, executeClaimedRun });
  return { runtime, eventStore, threadStore, auditStore, modelRegistry, identityResolver, config, cleanup: async () => runtimeDb.close() };
}