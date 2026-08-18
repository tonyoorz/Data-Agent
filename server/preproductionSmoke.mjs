import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CONFIG_SCHEMA_VERSION = "1.0";
const DEFAULT_TIMEOUT_MS = 120_000;
const SECRET_KEY_RE = /(^|_)(token|authorization|secret|cookie|password|api[_-]?key)($|_)/i;

export class PreproductionSmokeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new PreproductionSmokeError(code);
}

function text(value, code) {
  const normalized = String(value || "").trim();
  if (!normalized) fail(code);
  return normalized;
}

function stringList(value, code) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) fail(code);
  return [...new Set(value.map((item) => item.trim()))];
}

function assertNoEmbeddedSecrets(value, trail = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoEmbeddedSecrets(item, [...trail, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key) && key !== "tokenFile") {
      fail(`PREPRODUCTION_SMOKE_SECRET_IN_CONFIG:${[...trail, key].join(".")}`);
    }
    assertNoEmbeddedSecrets(child, [...trail, key]);
  }
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(text(value, "PREPRODUCTION_SMOKE_BASE_URL_REQUIRED"));
  } catch {
    fail("PREPRODUCTION_SMOKE_BASE_URL_INVALID");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))) {
    fail("PREPRODUCTION_SMOKE_BASE_URL_INVALID");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function normalizeActor(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`PREPRODUCTION_SMOKE_ACTOR_INVALID:${index}`);
  const tokenFile = path.resolve(text(raw.tokenFile, `PREPRODUCTION_SMOKE_TOKEN_FILE_REQUIRED:${index}`));
  if (!path.isAbsolute(tokenFile)) fail(`PREPRODUCTION_SMOKE_TOKEN_FILE_INVALID:${index}`);
  const aggregateRequiredValues = stringList(
    raw.aggregateRequiredValues ?? raw.requiredValues,
    `PREPRODUCTION_SMOKE_AGGREGATE_REQUIRED_VALUES_INVALID:${index}`,
  );
  const aggregateForbiddenValues = stringList(
    raw.aggregateForbiddenValues ?? raw.forbiddenValues,
    `PREPRODUCTION_SMOKE_AGGREGATE_FORBIDDEN_VALUES_INVALID:${index}`,
  );
  const continuationRequiredValues = stringList(
    raw.continuationRequiredValues,
    `PREPRODUCTION_SMOKE_CONTINUATION_REQUIRED_VALUES_INVALID:${index}`,
  );
  const continuationForbiddenValues = stringList(
    raw.continuationForbiddenValues ?? raw.forbiddenValues,
    `PREPRODUCTION_SMOKE_CONTINUATION_FORBIDDEN_VALUES_INVALID:${index}`,
  );
  return {
    label: text(raw.label, `PREPRODUCTION_SMOKE_ACTOR_LABEL_REQUIRED:${index}`),
    tokenFile,
    aggregateQuery: text(raw.aggregateQuery, `PREPRODUCTION_SMOKE_AGGREGATE_QUERY_REQUIRED:${index}`),
    continuationQuery: text(raw.continuationQuery, `PREPRODUCTION_SMOKE_CONTINUATION_QUERY_REQUIRED:${index}`),
    assertions: {
      aggregate: { requiredValues: aggregateRequiredValues, forbiddenValues: aggregateForbiddenValues },
      continuation: { requiredValues: continuationRequiredValues, forbiddenValues: continuationForbiddenValues },
    },
  };
}

export function normalizePreproductionSmokeConfig(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("PREPRODUCTION_SMOKE_CONFIG_INVALID");
  assertNoEmbeddedSecrets(raw);
  if (raw.schemaVersion !== CONFIG_SCHEMA_VERSION) fail("PREPRODUCTION_SMOKE_CONFIG_VERSION_INVALID");
  if (!Array.isArray(raw.actors) || raw.actors.length !== 2) fail("PREPRODUCTION_SMOKE_TWO_ACTORS_REQUIRED");
  const actors = raw.actors.map(normalizeActor);
  if (actors[0].label === actors[1].label || actors[0].tokenFile === actors[1].tokenFile) {
    fail("PREPRODUCTION_SMOKE_DISTINCT_ACTORS_REQUIRED");
  }
  const timeoutMs = Number(raw.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    fail("PREPRODUCTION_SMOKE_TIMEOUT_INVALID");
  }
  let testcaseCanary = null;
  if (raw.testcaseCanary !== undefined && raw.testcaseCanary !== null) {
    const canary = raw.testcaseCanary;
    if (!canary || typeof canary !== "object" || Array.isArray(canary)) fail("PREPRODUCTION_SMOKE_TESTCASE_INVALID");
    const mode = text(canary.mode, "PREPRODUCTION_SMOKE_TESTCASE_MODE_REQUIRED");
    if (!["proposal", "commit"].includes(mode)) fail("PREPRODUCTION_SMOKE_TESTCASE_MODE_INVALID");
    testcaseCanary = {
      mode,
      actorLabel: text(canary.actorLabel, "PREPRODUCTION_SMOKE_TESTCASE_ACTOR_REQUIRED"),
      defectId: text(canary.defectId, "PREPRODUCTION_SMOKE_TESTCASE_DEFECT_REQUIRED"),
      ownerWorkspaceUserId: String(canary.ownerWorkspaceUserId || "").trim(),
      featureId: String(canary.featureId || "").trim(),
      confirmation: String(canary.confirmation || "").trim(),
    };
    if (!actors.some((actor) => actor.label === testcaseCanary.actorLabel)) {
      fail("PREPRODUCTION_SMOKE_TESTCASE_ACTOR_UNKNOWN");
    }
    if (mode === "commit" && !testcaseCanary.ownerWorkspaceUserId) {
      fail("PREPRODUCTION_SMOKE_TESTCASE_OWNER_REQUIRED");
    }
  }
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    timeoutMs,
    threadId: text(raw.threadId || `preprod-smoke-${Date.now()}`, "PREPRODUCTION_SMOKE_THREAD_REQUIRED"),
    actors,
    testcaseCanary,
  };
}

function sha256(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function readToken(actor, readFileSync) {
  let value;
  try {
    value = readFileSync(actor.tokenFile, "utf8");
  } catch {
    fail(`PREPRODUCTION_SMOKE_TOKEN_FILE_UNREADABLE:${actor.label}`);
  }
  const token = String(value || "").trim();
  if (!token || /\s/.test(token)) fail(`PREPRODUCTION_SMOKE_TOKEN_INVALID:${actor.label}`);
  return token;
}

async function request(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, redirect: "error", signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") fail("PREPRODUCTION_SMOKE_REQUEST_TIMEOUT");
    fail("PREPRODUCTION_SMOKE_REQUEST_FAILED");
  } finally {
    clearTimeout(timer);
  }
}

async function jsonBody(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function parseSse(body) {
  const events = [];
  for (const line of String(body || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload);
      events.push(parsed?.type === "agent-runtime-event" && parsed.event ? parsed.event : parsed);
    } catch {
      fail("PREPRODUCTION_SMOKE_SSE_INVALID");
    }
  }
  return events;
}

function scalarCorpus(value) {
  if (Array.isArray(value)) return value.map(scalarCorpus).join("\n");
  if (value && typeof value === "object") return Object.values(value).map(scalarCorpus).join("\n");
  return String(value ?? "");
}

function validateAnalysisResult(events, actor, phase) {
  const terminal = events.find((event) => event?.type === "agent-terminal" && event?.status === "failed");
  if (terminal) fail(`PREPRODUCTION_SMOKE_AGENT_FAILED:${actor.label}:${phase}`);
  const validation = [...events].reverse().find((event) => event?.type === "answer-validation");
  if (validation?.valid === false) fail(`PREPRODUCTION_SMOKE_EVIDENCE_BLOCKED:${actor.label}:${phase}`);
  const analysis = [...events].reverse().find((event) => event?.type === "analysis-result");
  if (!analysis) fail(`PREPRODUCTION_SMOKE_ANALYSIS_RESULT_MISSING:${actor.label}:${phase}`);
  const analysisRef = text(analysis.analysisRef, `PREPRODUCTION_SMOKE_ANALYSIS_REF_MISSING:${actor.label}:${phase}`);
  const sourceRevisionId = text(analysis.sourceRevisionId, `PREPRODUCTION_SMOKE_SOURCE_REVISION_MISSING:${actor.label}:${phase}`);
  const corpus = scalarCorpus({ rows: analysis.rows, metrics: analysis.metrics });
  const assertions = actor.assertions[phase];
  for (const required of assertions.requiredValues) {
    if (!corpus.includes(required)) fail(`PREPRODUCTION_SMOKE_REQUIRED_VALUE_MISSING:${actor.label}:${phase}`);
  }
  for (const forbidden of assertions.forbiddenValues) {
    if (corpus.includes(forbidden)) fail(`PREPRODUCTION_SMOKE_FORBIDDEN_VALUE_PRESENT:${actor.label}:${phase}`);
  }
  return {
    analysisRef,
    sourceRevisionId,
    rowCount: Array.isArray(analysis.rows) ? analysis.rows.length : 0,
    metricCount: analysis.metrics && typeof analysis.metrics === "object" ? Object.keys(analysis.metrics).length : 0,
  };
}

async function runChat({ config, actor, token, query, phase, fetchImpl }) {
  const response = await request(fetchImpl, `${config.baseUrl}/api/ai/chat`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      threadId: config.threadId,
      messages: [{ role: "user", content: query }],
      useAnalyticsContext: true,
      useDefectContext: false,
    }),
  }, config.timeoutMs);
  if (response.status !== 200 || !String(response.headers.get("content-type") || "").startsWith("text/event-stream")) {
    fail(`PREPRODUCTION_SMOKE_CHAT_REJECTED:${actor.label}:${phase}:${response.status}`);
  }
  return validateAnalysisResult(parseSse(await response.text()), actor, phase);
}

async function runBoundaryChecks(config, fetchImpl) {
  const health = await request(fetchImpl, `${config.baseUrl}/health`, { method: "GET" }, config.timeoutMs);
  if (health.status !== 200) fail(`PREPRODUCTION_SMOKE_HEALTH_FAILED:${health.status}`);
  const body = JSON.stringify({ messages: [{ role: "user", content: "smoke" }] });
  const unauthenticated = await request(fetchImpl, `${config.baseUrl}/api/ai/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }, config.timeoutMs);
  const unauthenticatedPayload = await jsonBody(unauthenticated);
  if (unauthenticated.status !== 401 || unauthenticatedPayload?.error !== "AUTHENTICATED_ACTOR_REQUIRED") {
    fail("PREPRODUCTION_SMOKE_UNAUTHENTICATED_BOUNDARY_FAILED");
  }
  const invalid = await request(fetchImpl, `${config.baseUrl}/api/ai/chat`, {
    method: "POST",
    headers: { authorization: "Bearer invalid-preproduction-smoke-token", "content-type": "application/json" },
    body,
  }, config.timeoutMs);
  if (invalid.status !== 401) fail("PREPRODUCTION_SMOKE_INVALID_TOKEN_BOUNDARY_FAILED");
  return { health: "pass", unauthenticated: "pass", invalidToken: "pass" };
}

async function runTestcaseCanary({ config, tokens, fetchImpl, allowTestcaseMutation }) {
  const canary = config.testcaseCanary;
  if (!canary) return null;
  const token = tokens.get(canary.actorLabel);
  const prepared = await request(fetchImpl, `${config.baseUrl}/api/create-testcase`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ defect_id: canary.defectId }),
  }, config.timeoutMs);
  const payload = await jsonBody(prepared);
  if (prepared.status !== 200 || payload?.success !== true || !payload?.result?.proposalCapability) {
    fail(`PREPRODUCTION_SMOKE_TESTCASE_PROPOSAL_FAILED:${prepared.status}`);
  }
  if (canary.mode === "proposal") return { mode: "proposal", proposalDigest: String(payload.result.proposalDigest || "") };
  if (!allowTestcaseMutation || canary.confirmation !== `CREATE_ONE_TESTCASE:${canary.defectId}`) {
    fail("PREPRODUCTION_SMOKE_TESTCASE_MUTATION_NOT_CONFIRMED");
  }
  const committed = await request(fetchImpl, `${config.baseUrl}/api/create-testcase/commit`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      proposal_capability: payload.result.proposalCapability,
      feature_id: canary.featureId,
      owner_workspace_user_id: canary.ownerWorkspaceUserId,
    }),
  }, config.timeoutMs);
  const committedPayload = await jsonBody(committed);
  if (committed.status !== 200 || committedPayload?.success !== true || !committedPayload?.test_id) {
    fail(`PREPRODUCTION_SMOKE_TESTCASE_COMMIT_FAILED:${committed.status}`);
  }
  return { mode: "commit", testId: String(committedPayload.test_id), idempotentReplay: committedPayload.idempotentReplay === true };
}

export async function runPreproductionSmoke(rawConfig, {
  fetchImpl = globalThis.fetch,
  readFileSync = fs.readFileSync,
  now = () => new Date(),
  allowTestcaseMutation = false,
} = {}) {
  if (typeof fetchImpl !== "function") fail("PREPRODUCTION_SMOKE_FETCH_UNAVAILABLE");
  const config = normalizePreproductionSmokeConfig(rawConfig);
  const tokens = new Map(config.actors.map((actor) => [actor.label, readToken(actor, readFileSync)]));
  const boundary = await runBoundaryChecks(config, fetchImpl);
  const actorResults = [];
  for (const actor of config.actors) {
    const aggregate = await runChat({ config, actor, token: tokens.get(actor.label), query: actor.aggregateQuery, phase: "aggregate", fetchImpl });
    const continuation = await runChat({ config, actor, token: tokens.get(actor.label), query: actor.continuationQuery, phase: "continuation", fetchImpl });
    if (aggregate.analysisRef !== continuation.analysisRef) {
      fail(`PREPRODUCTION_SMOKE_ANALYSIS_REF_DRIFT:${actor.label}`);
    }
    if (aggregate.sourceRevisionId !== continuation.sourceRevisionId) {
      fail(`PREPRODUCTION_SMOKE_SNAPSHOT_DRIFT:${actor.label}`);
    }
    actorResults.push({ actor, aggregate, continuation });
  }
  if (actorResults[0].aggregate.analysisRef === actorResults[1].aggregate.analysisRef
    || actorResults[0].continuation.analysisRef === actorResults[1].continuation.analysisRef) {
    fail("PREPRODUCTION_SMOKE_CROSS_ACTOR_ANALYSIS_REF_REUSED");
  }
  const testcase = await runTestcaseCanary({ config, tokens, fetchImpl, allowTestcaseMutation });
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    status: "passed",
    generatedAt: now().toISOString(),
    target: { origin: new URL(config.baseUrl).origin, threadIdHash: sha256(config.threadId) },
    boundary,
    actors: actorResults.map(({ actor, aggregate, continuation }) => ({
      label: actor.label,
      aggregate: {
        analysisRefHash: sha256(aggregate.analysisRef),
        sourceRevisionHash: sha256(aggregate.sourceRevisionId),
        rowCount: aggregate.rowCount,
        metricCount: aggregate.metricCount,
      },
      continuation: {
        analysisRefHash: sha256(continuation.analysisRef),
        sourceRevisionHash: sha256(continuation.sourceRevisionId),
        rowCount: continuation.rowCount,
        metricCount: continuation.metricCount,
      },
      requiredValueAssertions: {
        aggregate: actor.assertions.aggregate.requiredValues.length,
        continuation: actor.assertions.continuation.requiredValues.length,
      },
      forbiddenValueAssertions: {
        aggregate: actor.assertions.aggregate.forbiddenValues.length,
        continuation: actor.assertions.continuation.forbiddenValues.length,
      },
    })),
    actorIsolation: "pass",
    fixedSnapshotContinuation: "pass",
    testcase,
  };
}
