import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProductionDependencies, createAgentApp } from "../../server/app.mjs";
import { createRuntimePolicy } from "../../server/agentRuntime/policy.mjs";
import { migrateRuntimeDb } from "../../server/agentRuntime/runtimeDb.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const FAKE_MODEL_ID = "fake-certified";
export const FAKE_MODEL_FIXTURE_VERSION = "fake-certified-v1";

const fakeCapabilities = Object.freeze({
  nativeToolCalling: false,
  structuredOutputMode: "json_prompt",
  streaming: true,
  parallelToolCalls: false,
  contextWindow: 64000,
  maxOutputTokens: 4096,
  timeoutMs: 5000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0 },
  certificationStatus: "planner_certified",
});

function fixtureFor(caseDefinition, toolName) {
  const fixtures = caseDefinition?.tool_fixtures || [];
  const exact = fixtures.find((item) => (
    item?.toolName === toolName || item?.name === toolName
  ));
  if (exact) return exact;
  if (["query_semantic_metrics", "query_semantic_records"].includes(toolName)) {
    return fixtures.find((item) => String(item?.toolName || item?.name || "").startsWith("query_"));
  }
  return undefined;
}

function defaultPayload(toolName, args = {}, actor = {}, queryId = "deterministic-query") {
  if (toolName === "search_duplicates") {
    return {
      candidates: [
        { id: "DEF-1001", title: "Deterministic duplicate fixture", score: 0.91 },
      ],
    };
  }
  if (toolName === "query_defect_high_frequency_analysis") {
    return {
      count: 7,
      rows: [{ assigned_ecu: "HU-H", defect_count: 7 }],
    };
  }
  if (["query_semantic_metrics", "query_semantic_records", "query_traceability"].includes(toolName)) {
    const query = args.query || {};
    const dimensionValue = (dimensionId) => query.filters?.find((item) => item.dimensionId === dimensionId)?.values?.[0]
      ?? query.timeScopes?.find((item) => item.fieldId === dimensionId)?.start
      ?? `fixture-${String(dimensionId).replace(/[^a-z0-9]+/gi, "-")}`;
    const baseDimensions = Object.fromEntries((query.dimensionIds || []).map((dimensionId) => [dimensionId, dimensionValue(dimensionId)]));
    const groups = query.comparison?.groups || [];
    const semanticRows = (query.dimensionIds || []).length
      ? (groups.length >= 2
          ? groups.map((group, index) => ({ ...baseDimensions, [query.comparison.dimensionId]: group, ...Object.fromEntries((query.metricIds || []).map((metricId) => [metricId, 42 - index])) }))
          : [{ ...baseDimensions, ...Object.fromEntries((query.metricIds || []).map((metricId) => [metricId, 42])) }])
      : [];
    const metricValues = Object.fromEntries((query.metricIds || []).map((metricId) => [metricId, semanticRows.length
      ? semanticRows.reduce((sum, row) => sum + Number(row[metricId] || 0), 0)
      : 42]));
    return {
      schemaVersion: "1.0",
      queryId,
      ontologyVersion: query.ontologyVersion,
      schemaFingerprint: query.schemaFingerprint,
      sourceRevision: { sourceId: "eval.fixture", revisionId: "fixture-v1", status: "pinned", asOf: "2026-07-15T04:00:00.000Z", ingestionWatermark: "fixture-v1" },
      scope: { actorScopeHash: actor.scopeHash, filters: query.filters || [], timeScopes: query.timeScopes || [], grain: ["deterministic evaluation fixture"] },
      data: toolName === "query_traceability" ? [{ run_id: "MR-42", scope_team: "DTSV_China" }] : semanticRows,
      summary: { metrics: metricValues, rowCount: toolName === "query_traceability" ? 1 : semanticRows.length || 42 },
      quality: { completeness: "complete", missingness: "not_applicable", truncated: false, warnings: [] },
    };
  }
  return { overview: { ticket_count: 42 } };
}

export function createDeterministicToolExecutor({ getCase = () => undefined, calls = [] } = {}) {
  return async function executeDeterministicTool(toolCall, { actor } = {}) {
    const toolName = String(toolCall?.function?.name || "");
    let args = {};
    try { args = JSON.parse(String(toolCall?.function?.arguments || "{}")); } catch { args = {}; }
    const fixture = fixtureFor(getCase(), toolName);
    const fixturePayload = fixture?.payload ?? fixture?.result;
    const queryId = String(toolCall?.id || "deterministic-query");
    let payload = fixturePayload ?? defaultPayload(toolName, args, actor, queryId);
    if (["query_semantic_metrics", "query_semantic_records", "query_traceability"].includes(toolName) && payload?.schemaVersion !== "1.0") {
      const semantic = defaultPayload(toolName, args, actor, queryId);
      const value = payload?.semanticMetricValue ?? payload?.overview?.ticket_count ?? payload?.count;
      const semanticRows = Array.isArray(payload?.semanticRows) ? payload.semanticRows.map((row) => ({ ...row })) : [];
      if (Number.isFinite(value)) {
        semantic.summary.metrics = Object.fromEntries((args.query?.metricIds || []).map((metricId) => [metricId, value]));
        semantic.summary.rowCount = value;
        semantic.quality.missingness = value === 0 ? "zero" : "not_applicable";
      }
      if (semanticRows.length) {
        semantic.data = semanticRows;
        semantic.summary.metrics = Object.fromEntries((args.query?.metricIds || []).map((metricId) => [metricId, semanticRows.reduce((sum, row) => sum + (Number.isFinite(row[metricId]) ? Number(row[metricId]) : 0), 0)]));
        semantic.summary.rowCount = semanticRows.length;
        semantic.quality.missingness = "not_applicable";
      }
      payload = semantic;
    }
    calls.push({
      toolCallId: String(toolCall?.id || ""),
      toolName,
      argumentsText: String(toolCall?.function?.arguments || "{}"),
    });
    const content = ["query_semantic_metrics", "query_semantic_records", "query_traceability"].includes(toolName)
      ? { ok: true, tool: toolName, result: payload }
      : payload;
    return {
      contextText: fixture?.contextText || JSON.stringify(payload),
      toolMessage: {
        role: "tool",
        tool_call_id: String(toolCall?.id || "fixture-call"),
        content: JSON.stringify(content),
      },
    };
  };
}

function fakeModelRecords() {
  return JSON.stringify([
    {
      id: FAKE_MODEL_ID,
      label: "Deterministic CI fixture",
      endpoint: "https://example.invalid/v1/chat/completions",
      authScheme: "Bearer",
      credentialEnv: "MAIN_AGENT_EVAL_CREDENTIAL",
      requestDialect: "openai_chat_completions",
      configVersion: FAKE_MODEL_FIXTURE_VERSION,
      capabilities: fakeCapabilities,
    },
  ]);
}

export async function startLocalAgentHarness({ logger, executionObserver, policyOptions } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "main-agent-eval-"));
  const dbPath = path.join(root, "agent-runtime.db");
  await migrateRuntimeDb({ dbPath, targetVersion: 1 });

  let activeCase;
  const calls = [];
  const modelCalls = [];
  const states = new Map();
  const executeLegacyTool = createDeterministicToolExecutor({ getCase: () => activeCase, calls });
  const depsFingerprint = fs.readFileSync(path.join(repoRoot, "ontology/generated/fingerprint.txt"), "utf8").trim();
  const deps = await buildProductionDependencies({
    root: repoRoot,
    logger: logger || { info() {}, warn() {}, error() {} },
    env: {
      VIZION_AGENT_RUNTIME_DB: dbPath,
      MAIN_AGENT_RUNTIME_MODE: "langgraph",
      MAIN_AGENT_IDENTITY_MODE: "dev",
      VIZION_API_HOST: "127.0.0.1",
      VIZION_DEV_HOST: "127.0.0.1",
      MAIN_AGENT_MODEL_RECORDS: fakeModelRecords(),
      MAIN_AGENT_DEFAULT_MODEL: FAKE_MODEL_ID,
      MAIN_AGENT_EVAL_CREDENTIAL: "deterministic-not-a-secret",
      MAIN_AGENT_DEV_ACTOR_ID: "eval-actor",
      MAIN_AGENT_DEV_WORKSPACE_ID: "DTSV",
      MAIN_AGENT_DEV_SCOPE_VERSION: "eval-v1",
    },
    executeLegacyTool,
    modelAdapter: {
      async invoke(request) {
        modelCalls.push({ modelId: request.modelId, purpose: request.purpose });
        return {
          text: JSON.stringify({ intent: "aggregate", metricIds: [], dimensionIds: [], entityIds: [] }),
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 16, outputTokens: 8 },
        };
      },
    },
    analyticsHealthCheck: async () => ({ ok: true, ontologyFingerprint: depsFingerprint }),
    now: () => "2026-07-15T04:00:00.000Z",
    ...(policyOptions ? { runtimePolicy: createRuntimePolicy(policyOptions) } : {}),
    executionObserver: async (observation) => {
      states.set(observation.runId, observation.state);
      await executionObserver?.(observation);
    },
  });

  const server = http.createServer(createAgentApp(deps));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const actor = await deps.identityResolver({ headers: {}, socket: { remoteAddress: "127.0.0.1" } });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    actor,
    calls,
    modelCalls,
    states,
    deps,
    setCase(caseDefinition) {
      activeCase = caseDefinition;
    },
    async cleanup() {
      await new Promise((resolve) => server.close(resolve));
      await deps.cleanup?.();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function parseSseEvents(text) {
  const events = [];
  for (const block of String(text || "").split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      events.push({ type: "invalid.sse", payload: { data } });
    }
  }
  return events;
}

export async function fetchWithTimeout(url, init = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("REQUEST_TIMEOUT")), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
