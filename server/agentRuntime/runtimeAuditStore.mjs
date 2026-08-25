import { createHash } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import path from "node:path";

const DEFAULT_ROOT_DIR = path.resolve(process.cwd(), "logs", "agent-runtime");
const ACTOR_SCOPED_THREAD_KEY_RE = /^actor-thread-[a-f0-9]{64}$/;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const THREAD_REFERENCE_DOMAIN = "vizion-agent-runtime-thread-reference-v1";
const RUN_REFERENCE_DOMAIN = "vizion-agent-runtime-run-reference-v1";

function timestamp(now) {
  return now().toISOString();
}

function text(value, maximum = 256) {
  return String(value || "").slice(0, maximum);
}

function stringList(value, maximumItems = 64) {
  return (Array.isArray(value) ? value : [])
    .map((item) => text(item))
    .filter(Boolean)
    .slice(0, maximumItems);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function actorScopeHash(value) {
  return text(value?.actorScopeHash || value?.actorScope?.scopeHash);
}

function opaqueThreadReference(threadId, scopeHash) {
  const normalizedThreadId = String(threadId || "").trim();
  if (!normalizedThreadId) return "";
  const digest = createHash("sha256")
    .update(THREAD_REFERENCE_DOMAIN)
    .update("\0")
    .update(String(scopeHash || ""))
    .update("\0")
    .update(normalizedThreadId)
    .digest("hex");
  return `thread-${digest}`;
}

function opaqueRunReference(runId, scopeHash) {
  const normalizedRunId = String(runId || "").trim();
  if (!normalizedRunId) return "";
  const digest = createHash("sha256")
    .update(RUN_REFERENCE_DOMAIN)
    .update("\0")
    .update(String(scopeHash || ""))
    .update("\0")
    .update(normalizedRunId)
    .digest("hex");
  return `run-${digest}`;
}

function minimalEvidenceGate(value) {
  if (!value || typeof value !== "object") return undefined;
  const sourceRevisionIds = stringList(value.sourceRevisionIds);
  const analysisRefs = stringList(value.analysisRefs);
  const warnings = stringList(value.warnings);
  return {
    status: text(value.status || "not_required", 32),
    violations: stringList(value.violations),
    ...(sourceRevisionIds.length ? { sourceRevisionIds } : {}),
    ...(analysisRefs.length ? { analysisRefs } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

function minimalToolRouting(value) {
  if (!value || typeof value !== "object") return undefined;
  const confidence = finiteNumber(value.confidence);
  return {
    shouldUseTools: value.shouldUseTools === true,
    intent: text(value.intent || "general"),
    ...(confidence === undefined ? {} : { confidence }),
    toolNames: stringList(value.toolNames, 32),
  };
}

function minimalMetrics(value) {
  if (!value || typeof value !== "object") return undefined;
  const toolCount = finiteNumber(value.mainAgentToolCallCount);
  return {
    ...(value.runtime ? { runtime: text(value.runtime, 32) } : {}),
    ...(toolCount === undefined ? {} : { mainAgentToolCallCount: toolCount }),
    ...(minimalEvidenceGate(value.evidenceGate) ? { evidenceGate: minimalEvidenceGate(value.evidenceGate) } : {}),
    ...(minimalToolRouting(value.toolRouting) ? { toolRouting: minimalToolRouting(value.toolRouting) } : {}),
  };
}

function minimalGovernedPlan(value) {
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries({
    schemaVersion: text(value.schemaVersion, 32),
    analysisPlanId: text(value.analysisPlanId),
    sourcePlanId: text(value.sourcePlanId),
    sourcePlanFingerprint: text(value.sourcePlanFingerprint),
    ontologyVersion: text(value.ontologyVersion),
    schemaFingerprint: text(value.schemaFingerprint),
    status: text(value.status, 32),
    operation: text(value.operation, 64),
    visualization: text(value.visualization, 64),
    maxRows: finiteNumber(value.maxRows),
    guardrails: stringList(value.guardrails),
    ruleCodes: stringList(value.ruleCodes),
  }).filter(([, item]) => item !== undefined && item !== "" && (!Array.isArray(item) || item.length)));
}

function minimalCheckpoint(checkpoint) {
  const value = checkpoint && typeof checkpoint === "object" ? checkpoint : {};
  return {
    node: text(value.node || "unknown", 64),
    ...(minimalMetrics(value.metrics) ? { metrics: minimalMetrics(value.metrics) } : {}),
    ...(minimalGovernedPlan(value.governedAnalysisPlan)
      ? { governedAnalysisPlan: minimalGovernedPlan(value.governedAnalysisPlan) }
      : {}),
  };
}

function minimalRecovery(value) {
  if (!value || typeof value !== "object") return undefined;
  const attempts = finiteNumber(value.attempts);
  const maxAttempts = finiteNumber(value.maxAttempts);
  return Object.fromEntries(Object.entries({
    action: text(value.action, 64),
    outcome: text(value.outcome, 64),
    reason: text(value.reason, 128),
    queryFingerprint: text(value.queryFingerprint),
    originalQueryFingerprint: text(value.originalQueryFingerprint),
    revisedQueryFingerprint: text(value.revisedQueryFingerprint),
    sourcePlanId: text(value.sourcePlanId),
    sourceToolCallId: text(value.sourceToolCallId),
    diagnosisToolCallId: text(value.diagnosisToolCallId),
    attempts,
    maxAttempts,
    retryable: typeof value.retryable === "boolean" ? value.retryable : undefined,
  }).filter(([, item]) => item !== undefined && item !== ""));
}

function minimalRunEvent(event) {
  const latencyMs = finiteNumber(event?.latencyMs);
  const failureCode = text(event?.failureCode || event?.error?.code || event?.error?.name, 128);
  const scopeHash = actorScopeHash(event);
  return Object.fromEntries(Object.entries({
    runId: opaqueRunReference(event?.runId, scopeHash),
    threadRef: opaqueThreadReference(event?.threadId, scopeHash),
    actorScopeHash: scopeHash,
    type: text(event?.type || "agent-event", 128),
    latencyMs,
    terminalStatus: text(event?.terminalStatus, 32),
    citationValidation: text(event?.citationValidation, 32),
    answerValidationViolations: stringList(event?.answerValidationViolations),
    stoppedReason: text(event?.stoppedReason, 128),
    failureCode,
  }).filter(([, item]) => item !== undefined && item !== "" && (!Array.isArray(item) || item.length)));
}

function minimalToolAudit(record) {
  const scopeHash = actorScopeHash(record);
  return Object.fromEntries(Object.entries({
    runId: opaqueRunReference(record?.runId, scopeHash),
    threadRef: opaqueThreadReference(record?.threadId, scopeHash),
    actorScopeHash: scopeHash,
    toolCallId: text(record?.toolCallId),
    toolName: text(record?.toolName, 128),
    recovery: minimalRecovery(record?.recovery),
  }).filter(([, item]) => item !== undefined && item !== ""));
}

function minimalRunSummary(summary) {
  const latencyMs = finiteNumber(summary?.latencyMs);
  const scopeHash = actorScopeHash(summary);
  return Object.fromEntries(Object.entries({
    schemaVersion: text(summary?.schemaVersion || "1.0", 32),
    runId: opaqueRunReference(summary?.runId, scopeHash),
    threadRef: opaqueThreadReference(summary?.threadId, scopeHash),
    actorScopeHash: scopeHash,
    intent: text(summary?.intent || "general", 128),
    outcome: text(summary?.outcome || "completed", 64),
    evidenceStatus: text(summary?.evidenceStatus || "not_required", 32),
    toolNames: stringList(summary?.toolNames, 32),
    toolOutcomes: stringList(summary?.toolOutcomes, 32),
    recoveryOutcomes: stringList(summary?.recoveryOutcomes, 32),
    sourceRevisionIds: stringList(summary?.sourceRevisionIds),
    citationValidation: text(summary?.citationValidation || "pending", 32),
    businessRuleCodes: stringList(summary?.businessRuleCodes),
    stoppedReason: text(summary?.stoppedReason, 128),
    failureCode: text(summary?.failureCode, 128),
    latencyMs,
  }).filter(([, item]) => item !== undefined && item !== "" && (!Array.isArray(item) || item.length)));
}

export function createFileAgentRuntimeStore({ rootDir = process.env.VIZION_AGENT_RUNTIME_STORE_DIR || DEFAULT_ROOT_DIR, now = () => new Date() } = {}) {
  const resolvedRootDir = path.resolve(rootDir);

  async function ensureSecureParent(filePath) {
    await mkdir(resolvedRootDir, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(resolvedRootDir, DIRECTORY_MODE);
    const parent = path.dirname(filePath);
    if (parent !== resolvedRootDir) {
      await mkdir(parent, { recursive: true, mode: DIRECTORY_MODE });
      await chmod(parent, DIRECTORY_MODE);
    }
  }

  async function writeJson(filePath, payload) {
    await ensureSecureParent(filePath);
    const fileHandle = await open(filePath, "w", FILE_MODE);
    try {
      await fileHandle.chmod(FILE_MODE);
      await fileHandle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } finally {
      await fileHandle.close();
    }
  }

  async function appendJsonLine(filePath, payload) {
    await ensureSecureParent(filePath);
    const fileHandle = await open(filePath, "a", FILE_MODE);
    try {
      await fileHandle.chmod(FILE_MODE);
      await fileHandle.appendFile(`${JSON.stringify(payload)}\n`, "utf8");
    } finally {
      await fileHandle.close();
    }
  }

  return {
    rootDir: resolvedRootDir,
    async writeThreadCheckpoint({ persistenceKey, threadId, runId, actorScope, checkpoint }) {
      if (!ACTOR_SCOPED_THREAD_KEY_RE.test(String(persistenceKey || ""))) {
        throw new Error("ACTOR_SCOPED_THREAD_KEY_REQUIRED");
      }
      const scopeHash = actorScopeHash({ actorScope });
      await writeJson(path.join(resolvedRootDir, "threads", `${persistenceKey}.json`), {
        threadRef: opaqueThreadReference(threadId, scopeHash),
        runId: opaqueRunReference(runId, scopeHash),
        actorScopeHash: scopeHash,
        checkpoint: minimalCheckpoint(checkpoint),
        updatedAt: timestamp(now),
      });
    },
    async appendRunEvent(event) {
      await appendJsonLine(path.join(resolvedRootDir, "run-events.jsonl"), {
        ...minimalRunEvent(event),
        recordedAt: timestamp(now),
      });
    },
    async appendToolAudit(record) {
      await appendJsonLine(path.join(resolvedRootDir, "tool-calls.jsonl"), {
        ...minimalToolAudit(record),
        recordedAt: timestamp(now),
      });
    },
    async appendRunSummary(summary) {
      await appendJsonLine(path.join(resolvedRootDir, "run-summaries.jsonl"), {
        ...minimalRunSummary(summary),
        recordedAt: timestamp(now),
      });
    },
  };
}
