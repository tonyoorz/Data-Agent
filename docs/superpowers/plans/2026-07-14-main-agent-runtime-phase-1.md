# Main Agent Runtime Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stateless main-chat tool loop with a recoverable LangGraph JS Runtime that uses the existing Bacon/DeepSeek/Qwen/GLM endpoints, emits replayable lifecycle events, enforces actor/tool boundaries, and preserves the current business-answer scope without changing Duplicate Search internals.

**Architecture:** Keep Node as the Runtime owner and compile an explicit LangGraph `StateGraph` around project-owned model, tool, evidence, identity, persistence, and event contracts. Store LangGraph checkpoints plus application-owned thread/run/journal/outbox records in a separate local SQLite Runtime database; keep `/api/ai/chat` as a compatibility facade while the AI Chat UI moves to versioned run/event APIs. Phase 1 uses `legacy-provisional` semantics and `legacy_equivalence` evidence only; Python Ontology grounding and test-case draft intelligence remain Phase 2 and Phase 3 work.

**Tech Stack:** Node.js 24 ESM, LangGraph JS 1.4.7, LangGraph SQLite checkpointer 1.0.3, `better-sqlite3` 12.11.1, Ajv 8.20.0, React 18, TypeScript, native HTTP/SSE, Vitest 3, Testing Library.

---

## Approved design and hard boundaries

Implement against [the approved architecture specification](../specs/2026-07-14-main-agent-runtime-design.md). The following are release invariants, not optional refinements:

- Do not modify `server/duplicateBridgeRuntime.cjs`, `scripts/duplicate_search_bridge.py`, Duplicate Search indexes, ranking, feedback, warmup, or the dedicated Duplicate Search UI flow.
- The only main-Runtime Duplicate Search invocation remains `runDuplicateBridge({ action: "search", query, top_k })` through an adapter.
- `useDefectContext=false` forbids both direct defect-context retrieval and the `search_duplicates` tool. `useAnalyticsContext=false` forbids all analytics tools. Page context cannot override either flag.
- Default Runtime mode is `legacy`. `shadow` never returns its answer and never invokes Duplicate Search. `langgraph` is initially allowed only for the Phase 1 legacy-equivalence business allowlist.
- No Octane write credential, write tool, approval-decision endpoint, arbitrary SQL, shell, arbitrary file path, or arbitrary network tool is registered.
- The final answer is buffered, validated, persisted, and only then emitted as `answer.delta`. Lifecycle/tool/evidence events remain live.
- Phase 1 must display `legacy-provisional` / `legacy_equivalence`, never “Ontology verified” or `grounded`.

## Execution preflight

The plan was written against commit `5081107a`. At planning time, `package.json`, `scripts/dev.mjs`, and `src/App.tsx` already contained user-staged work. Before Task 1:

- [ ] Invoke `superpowers:using-git-worktrees` and create an isolated implementation worktree from the user-approved integration commit.
- [ ] Run `git status --short`. If the three overlapping files are still uncommitted in the source worktree, stop and ask the user to commit or otherwise preserve them; never reset, checkout, or silently overwrite them.
- [ ] Run `node --version`. Expected: `v24.x`; the repository explicitly rejects other majors in `scripts/nodeVersion.mjs`.
- [ ] Run the current focused baseline:

```bash
npm test -- \
  src/test/server/mainAgentToolLoop.test.ts \
  src/test/server/mainAgentTools.test.ts \
  src/test/server/companyChat.test.ts \
  src/test/server/chatModelConfigTools.test.ts \
  src/test/ai-chat/AIChat.test.tsx \
  src/test/ai-chat/streamTextAnimator.test.ts
```

Expected before implementation: 6 files and 46 tests pass. Three existing React `act(...)` warnings are known baseline noise; do not add new warnings.

At planning time `npm run build` failed because `package.json`, `package-lock.json`, and `node_modules` disagreed about `i18next`/`react-i18next`. Task 1 deliberately regenerates the npm lock state before any Runtime code is added.

## File responsibility map

| Path | Responsibility |
|---|---|
| `server/agentRuntime/contracts.mjs` | Request/state/event constants plus strict Ajv validators |
| `server/agentRuntime/modelRegistry.mjs` | Single post-env-load model registry and public model DTOs |
| `server/agentRuntime/modelAdapter.mjs` | Chat Completions normalization, tool-call correlation, timeout/cancel/error mapping |
| `server/agentRuntime/identity.mjs` | Trusted identity to `ActorContext`, safe bind checks, scope refresh |
| `server/agentRuntime/httpUtils.mjs` | Bounded request reads, CORS, safe JSON/SSE headers and HTTP errors |
| `server/agentRuntime/runtimeDb.mjs` | Application SQLite connection and versioned migrations |
| `server/agentRuntime/migrations/001-runtime.sql` | Application-owned Runtime tables and constraints |
| `server/agentRuntime/threadStore.mjs` | Thread/run/message/version/lease/interaction lifecycle |
| `server/agentRuntime/events.mjs` | Transactional event outbox, protocol mapping and replay |
| `server/agentRuntime/stepJournal.mjs` | Idempotent external-boundary transitions and fencing |
| `server/agentRuntime/checkpoint.mjs` | `SqliteSaver`, canonical checkpoint promotion and catch-up |
| `server/agentRuntime/artifactStore.mjs` | Content-addressed artifacts, ACL, MIME/size/quota enforcement |
| `server/agentRuntime/policy.mjs` | Budgets, retry/timeout rules and allowed Runtime modes |
| `server/agentRuntime/toolRegistry.mjs` | Typed adapters over existing main-agent tools |
| `server/agentRuntime/evidence.mjs` | `legacy-v0` evidence, claim validation and deterministic fallback rendering |
| `server/agentRuntime/legacyAdapter.mjs` | Provisional semantic frame plus `/api/ai/chat` legacy event compatibility |
| `server/agentRuntime/graph.mjs` | LangGraph state, nodes, reducers and conditional edges |
| `server/agentRuntime/runtime.mjs` | Run creation/resume/cancel/recovery/reaper orchestration |
| `server/agentRuntime/httpRoutes.mjs` | Versioned Agent HTTP endpoints and authorization |
| `server/app.mjs` | Injectable local HTTP application without import-time listening |
| `server/index.mjs` | Env-first composition root and process lifecycle only |
| `src/lib/agentEventStream.ts` | Strict incremental SSE decoding, dedupe, cursor and answer-offset validation |
| `src/lib/agentApi.ts` | Models, runs, events, import, artifact, cancel/resume/fork APIs |
| `src/components/dashboard/chat/AgentRunTimeline.tsx` | Auditable lifecycle display separate from answer text |
| `src/components/dashboard/pages/AIChat.tsx` | Existing page wired to the new client while preserving Duplicate Search mode |

### Task 1: Pin the Runtime toolchain and repair npm reproducibility

**Files:**
- Create: `.nvmrc`
- Create: `database/runtime/.gitkeep`
- Create: `src/test/server/agentRuntime/dependencies.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing dependency-contract test**

```ts
import fs from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));

const required = {
  "@langchain/core": "1.2.2",
  "@langchain/langgraph": "1.4.7",
  "@langchain/langgraph-checkpoint-sqlite": "1.0.3",
  ajv: "8.20.0",
  "ajv-formats": "3.0.1",
  "better-sqlite3": "12.11.1",
};
const requiredDev = { "@types/node": "24.13.3" };

describe("main Agent Runtime dependencies", () => {
  it("pins every direct Runtime dependency and Node major", () => {
    expect(packageJson.engines).toEqual({ node: "24.x" });
    for (const [name, version] of Object.entries(required)) {
      expect(packageJson.dependencies[name]).toBe(version);
      expect(lock.packages[""].dependencies[name]).toBe(version);
      expect(lock.packages[`node_modules/${name}`]?.version).toBe(version);
    }
    for (const [name, version] of Object.entries(requiredDev)) {
      expect(packageJson.devDependencies[name]).toBe(version);
      expect(lock.packages[""].devDependencies[name]).toBe(version);
      expect(lock.packages[`node_modules/${name}`]?.version).toBe(version);
    }
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- src/test/server/agentRuntime/dependencies.test.ts
```

Expected: FAIL because the six direct dependencies and `engines.node` are absent.

- [ ] **Step 3: Install exact versions under Node 24 and update the lockfile**

Run:

```bash
npm install --save-exact \
  @langchain/core@1.2.2 \
  @langchain/langgraph@1.4.7 \
  @langchain/langgraph-checkpoint-sqlite@1.0.3 \
  ajv@8.20.0 \
  ajv-formats@3.0.1 \
  better-sqlite3@12.11.1
npm install --save-dev --save-exact @types/node@24.13.3
npm pkg set engines.node=24.x
```

Create `.nvmrc` with exactly:

```text
24.14.0
```

Preserve the already-staged `--experimental-sqlite` start flags and every existing package entry; do not regenerate `package.json` from scratch.

- [ ] **Step 4: Ignore only the new Runtime state directory**

Append this exact block to `.gitignore`:

```gitignore
# Main Agent Runtime local state
!database/runtime/
database/runtime/*
!database/runtime/.gitkeep
```

- [ ] **Step 5: Verify dependency integrity and build recovery**

Run:

```bash
npm test -- src/test/server/agentRuntime/dependencies.test.ts
npm ls --depth=0
npm run build
npm audit --omit=dev
```

Expected: the dependency test passes; `npm ls` exits 0; the missing `react-i18next` build blocker is gone. Record any audit finding in the dependency review created in Task 19 instead of suppressing it.

- [ ] **Step 6: Commit**

```bash
git add .nvmrc .gitignore database/runtime/.gitkeep package.json package-lock.json src/test/server/agentRuntime/dependencies.test.ts
git commit -m "build: pin main agent runtime dependencies"
```

### Task 2: Establish strict Runtime contracts

**Files:**
- Create: `server/agentRuntime/contracts.mjs`
- Create: `src/test/server/agentRuntime/contracts.test.ts`

- [ ] **Step 1: Write failing tests for run requests and event envelopes**

```ts
import { describe, expect, it } from "vitest";
import {
  createContractRegistry,
  EVENT_PROTOCOL_VERSION,
  GRAPH_DEFINITION_VERSION,
} from "../../../../server/agentRuntime/contracts.mjs";

const validRun = {
  schemaVersion: "1.0",
  messageId: "msg-1",
  threadId: "thread-1",
  threadVersion: 2,
  message: { role: "user", text: "DTSV 六月有多少缺陷？", artifactRefs: [] },
  selectedModel: "deepseek-v4-flash",
  pageContext: { moduleKey: "ai-chat", moduleLabel: "AI Chat" },
  useDefectContext: false,
  useAnalyticsContext: true,
  eventProtocolVersion: "1.0",
};

describe("Agent Runtime contracts", () => {
  const contracts = createContractRegistry();

  it("accepts the versioned run contract and rejects unknown input", () => {
    expect(EVENT_PROTOCOL_VERSION).toBe("1.0");
    expect(GRAPH_DEFINITION_VERSION).toBe("main-agent-v1");
    expect(contracts.validateRunRequest(validRun)).toEqual(validRun);
    expect(() => contracts.validateRunRequest({ ...validRun, actorId: "forged" })).toThrow(/additional/i);
    expect(() => contracts.validateRunRequest({ ...validRun, useAnalyticsContext: undefined })).toThrow(/useAnalyticsContext/);
  });

  it("validates an event by its concrete payload schema", () => {
    const event = {
      schemaVersion: "1.0",
      eventId: "evt-1",
      runId: "run-1",
      threadId: "thread-1",
      stateVersion: 1,
      sequence: 1,
      timestamp: "2026-07-14T00:00:00.000Z",
      type: "tool.started",
      payload: {
        attemptId: "attempt-1",
        stepId: "step-1",
        toolName: "query_dashboard_summary",
        redactedCanonicalArgs: { filters: { years: "2026" } },
      },
    };
    expect(contracts.validateAgentEvent(event)).toEqual(event);
    expect(() => contracts.validateAgentEvent({ ...event, payload: {} })).toThrow(/attemptId/);
    expect(() => contracts.validateAgentEvent({ ...event, type: "made.up" })).toThrow(/type/);
  });
});
```

- [ ] **Step 2: Run the tests and verify RED**

```bash
npm test -- src/test/server/agentRuntime/contracts.test.ts
```

Expected: FAIL with `Cannot find module .../contracts.mjs`.

- [ ] **Step 3: Implement the contract registry with strict Ajv**

Create the module with these public constants and factory. Keep `removeAdditional` disabled so malformed model/client output is rejected, never silently repaired by deletion.

```js
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const EVENT_PROTOCOL_VERSION = "1.0";
export const GRAPH_DEFINITION_VERSION = "main-agent-v1";
export const EVENT_TYPES = Object.freeze([
  "run.started", "input.prepared", "intent.resolved", "ontology.resolved",
  "clarification.required", "plan.updated", "plan.validated", "model.fallback",
  "tool.started", "tool.progress", "tool.completed", "tool.failed",
  "evidence.added", "claims.validated", "approval.required", "interaction.expired",
  "run.resumed", "answer.delta", "run.completed", "run.failed", "run.cancelled",
]);

const objectSchema = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = { type: "string", minLength: 1 };
const integer = { type: "integer", minimum: 0 };

const payloadSchemas = {
  "run.started": objectSchema({
    threadVersion: integer,
    runtimeMode: { enum: ["legacy", "shadow", "langgraph"] },
    requestedModelId: string,
    actualModelId: string,
  }),
  "input.prepared": objectSchema({
    artifactRefs: { type: "array", items: string },
    warnings: { type: "array", items: { type: "string" } },
  }),
  "intent.resolved": objectSchema({ intent: string, confidence: { type: "number", minimum: 0, maximum: 1 } }, ["intent"]),
  "ontology.resolved": objectSchema({
    semanticFrameRef: objectSchema({
      ontologyVersion: string,
      schemaFingerprint: string,
      requestAnchorAt: { type: "string", format: "date-time" },
    }),
    mode: { enum: ["legacy_provisional", "ontology_verified"] },
    ambiguityCodes: { type: "array", items: { type: "string" } },
  }),
  "clarification.required": objectSchema({ interactionId: string, threadVersion: integer, question: string, responseSchemaRef: string, expiresAt: { type: "string", format: "date-time" } }),
  "plan.updated": objectSchema({ planId: string, version: integer, stepIds: { type: "array", items: string } }),
  "plan.validated": objectSchema({ planId: string, toolNames: { type: "array", items: string }, warnings: { type: "array", items: { type: "string" } } }),
  "model.fallback": objectSchema({ fromModelId: string, toModelId: string, reasonCode: string }),
  "tool.started": objectSchema({ attemptId: string, stepId: string, toolName: string, redactedCanonicalArgs: { type: "object" } }),
  "tool.progress": objectSchema({ attemptId: string, message: string, percent: { type: "number", minimum: 0, maximum: 100 } }, ["attemptId", "message"]),
  "tool.completed": objectSchema({ attemptId: string, status: { enum: ["succeeded", "partial"] }, evidenceIds: { type: "array", items: string }, durationMs: integer }),
  "tool.failed": objectSchema({ attemptId: string, status: { enum: ["denied", "failed", "timeout", "cancelled"] }, code: string, retryable: { type: "boolean" }, safeMessage: string }),
  "evidence.added": objectSchema({ evidenceIds: { type: "array", items: string }, groundingStatus: { enum: ["grounded", "legacy_equivalence", "insufficient_evidence"] } }),
  "claims.validated": objectSchema({ validationRef: string, acceptedClaimIds: { type: "array", items: string }, rejectedClaimIds: { type: "array", items: string } }),
  "approval.required": objectSchema({ interactionId: string, approvalId: string, threadVersion: integer, riskLevel: { enum: ["R2", "R3"] }, actionDigest: string, actionPreviewRef: string, expiresAt: { type: "string", format: "date-time" } }),
  "interaction.expired": objectSchema({ interactionId: string, kind: { enum: ["clarification", "approval"] }, threadVersion: integer }),
  "run.resumed": objectSchema({ interactionId: string, threadVersion: integer }),
  "answer.delta": objectSchema({ answerId: string, contentHash: string, offset: integer, text: { type: "string" } }),
  "run.completed": objectSchema({ answerId: string, threadVersion: integer, durationMs: integer }),
  "run.failed": objectSchema({ code: string, safeMessage: string, retryable: { type: "boolean" }, threadVersion: integer }),
  "run.cancelled": objectSchema({ reasonCode: string, threadVersion: integer }),
};

const runRequestSchema = objectSchema({
  schemaVersion: { const: "1.0" },
  messageId: string,
  threadId: string,
  threadVersion: integer,
  branch: objectSchema({ parentRunId: string, parentCheckpointId: string }),
  message: objectSchema({
    role: { const: "user" },
    text: { type: "string", minLength: 1, maxLength: 100000 },
    artifactRefs: { type: "array", maxItems: 5, items: string },
  }),
  selectedModel: string,
  pageContext: objectSchema({ moduleKey: string, moduleLabel: string }),
  useDefectContext: { type: "boolean" },
  useAnalyticsContext: { type: "boolean" },
  eventProtocolVersion: { const: "1.0" },
}, ["schemaVersion", "messageId", "threadVersion", "message", "selectedModel", "useDefectContext", "useAnalyticsContext", "eventProtocolVersion"]);

function compileOrThrow(ajv, schema, label) {
  const validate = ajv.compile(schema);
  return (value) => {
    if (!validate(value)) {
      throw new Error(`${label}: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
    }
    return value;
  };
}

export function createContractRegistry() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, removeAdditional: false });
  addFormats(ajv);
  const validateRunRequest = compileOrThrow(ajv, runRequestSchema, "INVALID_RUN_REQUEST");
  const eventValidators = Object.fromEntries(EVENT_TYPES.map((type) => [type, compileOrThrow(ajv, objectSchema({
    schemaVersion: { const: "1.0" }, eventId: string, runId: string, threadId: string,
    stateVersion: integer, sequence: { type: "integer", minimum: 1 }, timestamp: { type: "string", format: "date-time" },
    type: { const: type }, payload: payloadSchemas[type],
  }), `INVALID_AGENT_EVENT:${type}`)]));
  return {
    validateRunRequest,
    compileToolSchema(schema, label) {
      return compileOrThrow(ajv, { $schema: "https://json-schema.org/draft/2020-12/schema", ...schema }, `INVALID_TOOL_CONTRACT:${label}`);
    },
    validateAgentEvent(value) {
      const validate = eventValidators[value?.type];
      if (!validate) throw new Error(`INVALID_AGENT_EVENT:type:${String(value?.type || "missing")}`);
      return validate(value);
    },
  };
}
```

The new-run contract intentionally permits an absent `threadId`; in that case `threadVersion` must be `0` and the server generates the thread. If `threadId` is present it must be a non-empty server-granted ID. Add an Ajv `if/then` rule for that invariant.

In the same registry define and test these additional methods so later tasks do not invent route-local validators:

| Validator | Required fields and closed-object rules |
|---|---|
| `validateResumeRequest` | `schemaVersion`, `interactionId`, `threadVersion`, `value`; no actor/user field |
| `validateCancelRequest` | `schemaVersion`, `threadVersion`, `reasonCode` |
| `validateLegacyImport` | `schemaVersion`, `clientConversationId`, stable message IDs/roles/text/artifact refs/timestamps; non-attachment text/metadata <=1 MiB; at most 5 legacy data URLs, decoded <=8 MiB each/20 MiB total |
| `validateForkRequest` | `schemaVersion`, `threadVersion`, parent run/checkpoint and optional `supersedesMessageId` |
| `validateThreadPatch` | `schemaVersion`, `threadVersion` plus at least one of title/pinned/archived/deleted |
| `validateModelResponse` | normalized text/toolCalls/finishReason/usage only; reasoning fields rejected |
| `validateEvidence` | complete `EvidenceEnvelope` including source revision, quality and authorization |
| `validateClaimValidation` | validation ID/status/accepted IDs/rejected reasons/warnings |
| `validateAnswerEnvelope` | content hash, accepted claims, citations, assumptions, limitations, grounding status and revisions |

All Runtime-owned schemas use JSON Schema 2020-12 in this one registry. Tool adapters in Task 11 call `compileToolSchema()` after converting the existing compatible schema objects; they do not create a second Ajv instance.

- [ ] **Step 4: Run the focused tests**

```bash
npm test -- src/test/server/agentRuntime/contracts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/agentRuntime/contracts.mjs src/test/server/agentRuntime/contracts.test.ts
git commit -m "feat: define main agent runtime contracts"
```

### Task 3: Create the single model registry after environment loading

**Files:**
- Create: `server/agentRuntime/modelRegistry.mjs`
- Create: `src/test/server/agentRuntime/modelRegistry.test.ts`
- Modify: `server/chatModelConfig.mjs`
- Test: `src/test/server/chatModelConfigTools.test.ts`

- [ ] **Step 1: Write failing registry tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { createModelRegistry } from "../../../../server/agentRuntime/modelRegistry.mjs";

const capability = { nativeToolCalling: true, structuredOutputMode: "json_prompt", streaming: true, parallelToolCalls: false, contextWindow: 32000, maxOutputTokens: 4096, timeoutMs: 30000, retryPolicy: { maxAttempts: 1, backoffMs: 0 }, certificationStatus: "planner_certified" };
const records = [
  { id: "bacon", label: "Bacon", endpoint: "https://internal.example/bacon/chat/completions", authScheme: "ACCESSCODE", credentialEnv: "MAIN_AGENT_ACCESS_CODE", requestDialect: "internal_chat_completions", configVersion: "test-v1", capabilities: { ...capability, certificationStatus: "planner_candidate" } },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", endpoint: "https://internal.example/deepseek/chat/completions", authScheme: "ACCESSCODE", credentialEnv: "MAIN_AGENT_ACCESS_CODE", requestDialect: "internal_chat_completions", configVersion: "test-v1", capabilities: capability },
];

describe("main Agent model registry", () => {
  it("prefers MAIN_AGENT settings and exposes no secrets", () => {
    const warn = vi.fn();
    const registry = createModelRegistry({
      env: {
        MAIN_AGENT_MODEL_RECORDS: JSON.stringify(records),
        MAIN_AGENT_ACCESS_CODE: "secret-code",
      },
      logger: { warn },
    });
    expect(registry.listPublic().map((item) => item.id)).toEqual(["bacon", "deepseek-v4-flash"]);
    expect(JSON.stringify(registry.listPublic())).not.toContain("secret-code");
    expect(registry.require("bacon").credential).toBe("secret-code");
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps old DUPSEARCH variables as warning-only aliases", () => {
    const warn = vi.fn();
    const registry = createModelRegistry({
      env: {
        DUPSEARCH_CHAT_MODEL_OPTIONS: "deepseek-v4-flash",
        DUPSEARCH_CHAT_MODEL_ENDPOINTS: JSON.stringify({ "deepseek-v4-flash": "https://internal.example/deepseek/chat/completions" }),
        DUPSEARCH_CHAT_ACCESS_CODE: "legacy-code",
        MAIN_AGENT_MODEL_CAPABILITIES: JSON.stringify({ "deepseek-v4-flash": capability }),
        MAIN_AGENT_MODEL_DIALECTS: JSON.stringify({ "deepseek-v4-flash": "internal_chat_completions" }),
      },
      logger: { warn },
    });
    expect(registry.require("deepseek-v4-flash").credential).toBe("legacy-code");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("deprecated"));
  });

  it("rejects unknown, duplicate, or unusable models", () => {
    const registry = createModelRegistry({ env: { MAIN_AGENT_MODEL_RECORDS: JSON.stringify(records.slice(1)), MAIN_AGENT_ACCESS_CODE: "secret-code" } });
    expect(() => registry.require("invented-model")).toThrow(/MODEL_NOT_CONFIGURED/);
    expect(() => createModelRegistry({ env: {
      MAIN_AGENT_MODEL_RECORDS: JSON.stringify([{ ...records[0], id: "Bacon" }, records[0]]),
      MAIN_AGENT_ACCESS_CODE: "secret-code",
    } })).toThrow(/DUPLICATE_MODEL_ID/);
  });
});
```

- [ ] **Step 2: Run the registry tests and verify RED**

```bash
npm test -- src/test/server/agentRuntime/modelRegistry.test.ts
```

Expected: FAIL because `modelRegistry.mjs` does not exist.

- [ ] **Step 3: Implement registry creation with no guessed capability or fallback URL**

The module exports factories/constants only and never reads `process.env` during module evaluation. Parse `MAIN_AGENT_MODEL_RECORDS` as an array of complete records. Each record contains `id`, `label`, an explicit absolute HTTPS `endpoint`, `authScheme`, `credentialEnv`, `requestDialect`, `configVersion`, and the complete capability object. `credentialEnv` names a server environment variable; the credential value itself never appears in the JSON record or public DTO.

```js
const CAPABILITY_KEYS = [
  "nativeToolCalling", "structuredOutputMode", "streaming", "parallelToolCalls",
  "contextWindow", "maxOutputTokens", "timeoutMs", "retryPolicy", "certificationStatus",
];
const CERTIFICATION = new Set(["chat_only", "planner_candidate", "planner_certified", "disabled"]);
const DIALECTS = new Set(["internal_chat_completions", "openai_chat_completions"]);

function assertRecord(record, env) {
  const id = String(record?.id || "").trim();
  if (!id) throw new Error("MODEL_ID_REQUIRED");
  const endpoint = new URL(String(record.endpoint || ""));
  if (endpoint.protocol !== "https:") throw new Error(`MODEL_ENDPOINT_NOT_HTTPS:${id}`);
  if (!DIALECTS.has(record.requestDialect)) throw new Error(`MODEL_DIALECT_INVALID:${id}`);
  for (const key of CAPABILITY_KEYS) {
    if (!(key in (record.capabilities || {}))) throw new Error(`MODEL_CAPABILITY_MISSING:${id}:${key}`);
  }
  if (!CERTIFICATION.has(record.capabilities.certificationStatus)) throw new Error(`MODEL_CERTIFICATION_INVALID:${id}`);
  if (!Number.isInteger(record.capabilities.contextWindow) || record.capabilities.contextWindow <= 0) throw new Error(`MODEL_CONTEXT_INVALID:${id}`);
  if (!Number.isInteger(record.capabilities.maxOutputTokens) || record.capabilities.maxOutputTokens <= 0) throw new Error(`MODEL_OUTPUT_LIMIT_INVALID:${id}`);
  if (!Number.isInteger(record.capabilities.timeoutMs) || record.capabilities.timeoutMs <= 0) throw new Error(`MODEL_TIMEOUT_INVALID:${id}`);
  if (!Number.isInteger(record.capabilities.retryPolicy?.maxAttempts) || record.capabilities.retryPolicy.maxAttempts < 1) throw new Error(`MODEL_RETRY_INVALID:${id}`);
  const credentialEnv = String(record.credentialEnv || "").trim();
  const credential = String(env[credentialEnv] || "").trim();
  if (!credential) throw new Error(`MODEL_CREDENTIAL_MISSING:${id}:${credentialEnv}`);
  if (id.toLowerCase() === "bacon" && (!record.endpoint || !record.capabilities || record.capabilities.certificationStatus === "disabled")) {
    throw new Error("BACON_CONFIGURATION_INCOMPLETE");
  }
  return Object.freeze({ ...record, id, endpoint: endpoint.toString(), credential, enabled: record.capabilities.certificationStatus !== "disabled" });
}

export function createModelRegistry({ env, logger = console }) {
  if (!env || typeof env !== "object") throw new Error("MODEL_REGISTRY_ENV_REQUIRED");
  const primary = String(env.MAIN_AGENT_MODEL_RECORDS || "").trim();
  const legacyOptions = String(env.DUPSEARCH_CHAT_MODEL_OPTIONS || "").trim();
  let rawRecords;
  if (primary) {
    try { rawRecords = JSON.parse(primary); } catch { throw new Error("MAIN_AGENT_MODEL_RECORDS_INVALID_JSON"); }
  } else if (legacyOptions) {
    logger.warn("[main-agent] DUPSEARCH_CHAT_* aliases are deprecated; configure MAIN_AGENT_MODEL_RECORDS");
    rawRecords = compileLegacyAliasesToRecords(env); // requires explicit endpoint and a complete capability entry for every listed model
  } else {
    throw new Error("MAIN_AGENT_MODEL_RECORDS_REQUIRED");
  }
  if (!Array.isArray(rawRecords) || rawRecords.length === 0) throw new Error("MAIN_AGENT_MODEL_RECORDS_EXPECTED_ARRAY");
  const records = rawRecords.map((record) => assertRecord(record, env));
  const keys = records.map((record) => record.id.toLowerCase());
  if (new Set(keys).size !== keys.length) throw new Error("DUPLICATE_MODEL_ID");
  const byId = new Map(records.map((record) => [record.id.toLowerCase(), record]));
  const defaultModelId = String(env.MAIN_AGENT_DEFAULT_MODEL || records[0].id).trim();
  if (!byId.get(defaultModelId.toLowerCase())?.enabled) throw new Error(`DEFAULT_MODEL_NOT_CONFIGURED:${defaultModelId}`);
  return Object.freeze({
    defaultModelId,
    require(modelId, { purpose } = {}) {
      const record = byId.get(String(modelId || "").trim().toLowerCase());
      if (!record || !record.enabled) throw new Error(`MODEL_NOT_CONFIGURED:${String(modelId || "")}`);
      if (["intent", "planning", "repair"].includes(purpose) && record.capabilities.certificationStatus !== "planner_certified") {
        throw new Error(`MODEL_NOT_CERTIFIED_FOR_PLANNING:${record.id}`);
      }
      return record;
    },
    listPublic() {
      return records.filter((record) => record.enabled).map(({ id, label, capabilities, configVersion }) => ({ id, label, capabilities, configVersion }));
    },
  });
}
```

`compileLegacyAliasesToRecords(env)` is compatibility-only: it accepts `DUPSEARCH_CHAT_MODEL_OPTIONS/ENDPOINTS/ACCESS_CODE`, but requires `MAIN_AGENT_MODEL_CAPABILITIES` to contain the full capability record and `MAIN_AGENT_MODEL_DIALECTS` to contain an explicit dialect for every model. It never supplies a default endpoint, capability, certification, or external DeepSeek URL. Add tests for missing endpoint, credential, capability field, dialect, duplicate ID, non-HTTPS URL, disabled model, Bacon incomplete configuration, and a non-certified model rejected for planning but allowed for `purpose="render"`.

- [ ] **Step 4: Preserve `chatModelConfig.mjs` as the Duplicate/legacy boundary**

Do not change the meaning of `getChatModelOptions`, `getDefaultChatModel`, `resolveChatModelConfig`, or `buildChatCompletionRequest`; they remain the compatibility implementation used by `companyChat.mjs`, `duplicateSummary.mjs`, and `chatToolProbe.mjs`. The new Main Agent Runtime imports `modelRegistry.mjs` directly and does not make Duplicate Search depend on `MAIN_AGENT_MODEL_RECORDS`.

Only refactor any environment access into explicit function arguments where required, preserving the old return shape and wire body. Add regression snapshots for the current Duplicate endpoint selection, `max_token_length` field, access-code header, fallback API-key mode, tool-calling body and unknown legacy model behavior. The new Runtime's fail-closed unknown-model test belongs to `modelRegistry.test.ts`; it must not rewrite the independent Duplicate Search legacy policy.

- [ ] **Step 5: Run new and legacy tests**

```bash
npm test -- \
  src/test/server/agentRuntime/modelRegistry.test.ts \
  src/test/server/chatModelConfigTools.test.ts \
  src/test/server/projectIsolation.test.ts
```

Expected: PASS. `modelRegistry.test.ts` proves the new Main Runtime rejects unknown models; the legacy `chatModelConfigTools.test.ts` assertions remain unchanged for Duplicate Search rollback compatibility.

- [ ] **Step 6: Commit**

```bash
git add server/agentRuntime/modelRegistry.mjs server/chatModelConfig.mjs src/test/server/agentRuntime/modelRegistry.test.ts src/test/server/chatModelConfigTools.test.ts
git commit -m "feat: centralize main agent model registry"
```

### Task 4: Implement the internal model adapter

**Files:**
- Create: `server/agentRuntime/modelAdapter.mjs`
- Create: `src/test/server/agentRuntime/modelAdapter.test.ts`
- Modify: `server/companyChat.mjs`
- Test: `src/test/server/companyChat.test.ts`

- [ ] **Step 1: Write failing adapter tests for tool transcript fidelity and cancellation**

```ts
import { describe, expect, it, vi } from "vitest";
import { createInternalModelAdapter } from "../../../../server/agentRuntime/modelAdapter.mjs";

const model = {
  id: "bacon",
  endpoint: "https://internal.example/chat/completions",
  requestDialect: "internal_chat_completions",
  authScheme: "ACCESSCODE",
  credential: "secret",
  capabilities: { nativeToolCalling: true, structuredOutputMode: "json_prompt", streaming: true, parallelToolCalls: false, contextWindow: 32000, maxOutputTokens: 4096, timeoutMs: 50, retryPolicy: { maxAttempts: 1, backoffMs: 0 }, certificationStatus: "planner_candidate" },
  configVersion: "test-v1",
};
const registry = { require: vi.fn(() => model) };

describe("InternalModelAdapter", () => {
  it("preserves assistant tool calls and matching tool_call_id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "query_dashboard_summary", arguments: "{\"filters\":{}}" } }] } }],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const adapter = createInternalModelAdapter({ registry, fetchImpl });
    const response = await adapter.invoke({
      modelId: "bacon", purpose: "planning", temperature: 0, maxOutputTokens: 512, allowParallelToolCalls: false,
      messages: [
        { role: "user", content: "query" },
        { role: "assistant", content: "", toolCalls: [{ toolCallId: "old-1", name: "tool-a", argumentsText: "{}" }] },
        { role: "tool", toolCallId: "old-1", name: "tool-a", content: "result" },
      ],
    }, { signal: new AbortController().signal });
    const sent = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(sent.messages[1].tool_calls[0].id).toBe("old-1");
    expect(sent.messages[2].tool_call_id).toBe("old-1");
    expect(response.toolCalls).toEqual([{ toolCallId: "call-1", name: "query_dashboard_summary", argumentsText: "{\"filters\":{}}" }]);
    expect(response.finishReason).toBe("tool_calls");
  });

  it("classifies caller cancellation without retry", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = createInternalModelAdapter({ registry, fetchImpl: vi.fn() });
    await expect(adapter.invoke({ modelId: "bacon", purpose: "render", messages: [], temperature: 0, maxOutputTokens: 32, allowParallelToolCalls: false }, { signal: controller.signal })).rejects.toMatchObject({ code: "MODEL_CANCELLED", retryable: false });
  });
});
```

- [ ] **Step 2: Run the tests and verify RED**

```bash
npm test -- src/test/server/agentRuntime/modelAdapter.test.ts
```

Expected: FAIL because the adapter module does not exist.

- [ ] **Step 3: Implement normalized request/response mapping**

```js
const toProviderMessage = (message) => {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content || "",
      tool_calls: message.toolCalls.map((call) => ({ id: call.toolCallId, type: "function", function: { name: call.name, arguments: call.argumentsText } })),
    };
  }
  if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, name: message.name, content: message.content };
  return { role: message.role, content: message.content };
};
const normalizeFinishReason = (reason) => ({ tool_calls: "tool_calls", stop: "stop", length: "length", content_filter: "content_filter" }[reason] || "error");
const modelError = (code, message, retryable, cause) => Object.assign(new Error(message, { cause }), { code, retryable });

export function createInternalModelAdapter({ registry, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const invoke = async (request, context = {}) => {
    const record = registry.require(request.modelId, { purpose: request.purpose });
    if (context.signal?.aborted) throw modelError("MODEL_CANCELLED", "Model call cancelled", false);
    const timeout = AbortSignal.timeout(record.capabilities.timeoutMs);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    const url = record.endpoint;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `${record.authScheme} ${record.credential}` },
        body: JSON.stringify({
          model: record.id,
          messages: request.messages.map(toProviderMessage),
          temperature: request.temperature,
          ...(record.requestDialect === "internal_chat_completions"
            ? { max_token_length: request.maxOutputTokens }
            : { max_tokens: request.maxOutputTokens }),
          stream: false,
          parallel_tool_calls: Boolean(request.allowParallelToolCalls && record.capabilities.parallelToolCalls),
          ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })), tool_choice: "auto" } : {}),
        }),
      });
    } catch (error) {
      if (context.signal?.aborted) throw modelError("MODEL_CANCELLED", "Model call cancelled", false, error);
      if (timeout.aborted) throw modelError("MODEL_TIMEOUT", "Model call timed out", true, error);
      throw modelError("MODEL_NETWORK_ERROR", "Model endpoint unavailable", true, error);
    }
    if (!response.ok) {
      await response.arrayBuffer().catch(() => new ArrayBuffer(0));
      throw modelError(`MODEL_HTTP_${response.status}`, `Model request failed (${response.status})`, response.status === 429 || response.status >= 500);
    }
    const payload = await response.json();
    const choice = payload?.choices?.[0] || {};
    const message = choice.message || {};
    return {
      text: normalizePublicContent(message.content),
      toolCalls: (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((call) => ({ toolCallId: String(call.id), name: String(call.function?.name), argumentsText: typeof call.function?.arguments === "string" ? call.function.arguments : JSON.stringify(call.function?.arguments || {}) })),
      finishReason: normalizeFinishReason(choice.finish_reason),
      usage: payload.usage ? { inputTokens: Number(payload.usage.prompt_tokens || 0), outputTokens: Number(payload.usage.completion_tokens || 0) } : undefined,
      providerRequestId: String(payload.id || response.headers.get("x-request-id") || ""),
      completedAt: new Date(now()).toISOString(),
    };
  };
  return { capabilities: (modelId) => registry.require(modelId).capabilities, invoke, stream };
}
```

`normalizePublicContent()` accepts provider string/array content parts and returns only public text parts. It drops the registry-declared `reasoningField`, `<think>` segments and unknown provider metadata before model turns or events are persisted.

Implement `stream()` as an async generator over the response body's `ReadableStream`. Use a streaming `TextDecoder`, retain incomplete SSE frames, parse only `data:` records, and stop only on `[DONE]` or EOF. Maintain a map keyed by provider tool-call `index`, require a stable `id`, append arguments deltas in order, and emit:

```js
yield { type: "content_delta", text };
yield { type: "tool_call_delta", toolCallId, ...(name ? { name } : {}), argumentsDelta };
yield { type: "usage", inputTokens, outputTokens };
yield { type: "completed", response: { text: bufferedText, toolCalls: completedCalls, finishReason, usage, providerRequestId } };
```

The graph may consume `stream()` to measure first-content latency, but it buffers every content delta in server memory/artifact state and exposes nothing to the client until claim/render validation and final persistence. Tests assert the upstream stream can produce bytes while the event outbox still contains zero `answer.delta` rows.

Before returning either `invoke()` or `stream()`, call `context.isCancellationRequested()` and verify the signal again. Both paths use one shared `executeWithRetry()` that performs at most `record.capabilities.retryPolicy.maxAttempts`, retries only network/429/5xx errors, never retries caller cancellation or schema/content errors, observes the remaining timeout, and emits no credential/body in `safeMessage`. Diagnostic detail is hashed and stored through an injected `diagnosticSink`; only its ref may enter `AgentError`.

When `request.outputSchema` is present, validate normalized text as JSON. `native_json_schema` sends the provider's response-format field declared by the record transport; `json_prompt` appends the canonical schema instruction. One deterministic repair invocation with `purpose="repair"` is allowed. A second invalid result raises `MODEL_STRUCTURED_OUTPUT_INVALID`. Add exact tests for internal `max_token_length`, OpenAI `max_tokens`, byte-split SSE, multi-tool delta correlation, usage, retryable 500, non-retryable 400, timeout, durable cancellation polling, reasoning stripping, empty response and both structured-output modes.

- [ ] **Step 4: Route legacy `companyChat.mjs` through the adapter without changing its public exports**

Keep `requestCompanyChatCompletion`, `streamCompanyChatCompletion`, `writeSseEvent`, and `writeSseResponse`. The non-streaming function may delegate to the adapter; the existing raw streaming function remains legacy-only and receives an explicit `signal`. Add a test proving `AbortSignal` reaches `fetch`.

- [ ] **Step 5: Run adapter and compatibility tests**

```bash
npm test -- src/test/server/agentRuntime/modelAdapter.test.ts src/test/server/companyChat.test.ts
```

Expected: PASS; existing OCR/PDF expansion and legacy SSE tests remain green.

- [ ] **Step 6: Commit**

```bash
git add server/agentRuntime/modelAdapter.mjs server/companyChat.mjs src/test/server/agentRuntime/modelAdapter.test.ts src/test/server/companyChat.test.ts
git commit -m "feat: normalize internal model execution"
```

### Task 5: Enforce trusted identity, safe bind, CORS, and request limits

**Files:**
- Create: `server/agentRuntime/config.mjs`
- Create: `server/agentRuntime/identity.mjs`
- Create: `server/agentRuntime/httpUtils.mjs`
- Create: `src/test/server/agentRuntime/config.test.ts`
- Create: `src/test/server/agentRuntime/identity.test.ts`
- Create: `src/test/server/agentRuntime/httpUtils.test.ts`
- Modify: `vite.config.ts`

- [ ] **Step 1: Write failing security-boundary tests**

```ts
import { describe, expect, it } from "vitest";
import { createRuntimeConfig } from "../../../../server/agentRuntime/config.mjs";
import { createIdentityResolver } from "../../../../server/agentRuntime/identity.mjs";

describe("Phase 1 identity boundary", () => {
  it("allows DEV identity only on loopback", () => {
    expect(createRuntimeConfig({ MAIN_AGENT_IDENTITY_MODE: "dev", VIZION_API_HOST: "127.0.0.1" }).host).toBe("127.0.0.1");
    expect(() => createRuntimeConfig({ MAIN_AGENT_IDENTITY_MODE: "dev", VIZION_API_HOST: "0.0.0.0" })).toThrow(/DEV_IDENTITY_REQUIRES_LOOPBACK/);
  });

  it("derives actor and scopes from a trusted proxy, never request body", async () => {
    const resolveIdentity = createIdentityResolver({
      mode: "trusted-proxy",
      trustedProxyAddresses: ["127.0.0.1"],
      scopeProvider: async () => ({ workspaceIds: ["DTSV_China"], projectIds: ["SP25"], teamIds: ["DTSV"], allowedObjectTypes: ["defect"], rowPolicyIds: ["row-dtsv"], sensitiveFieldPolicyIds: ["redact-personal"], roles: ["qa"], scopeVersion: "scope-v1" }),
    });
    const actor = await resolveIdentity({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-proto": "https", "x-auth-request-user": "alice", "x-auth-request-session": "session-1" } });
    expect(actor.actorId).toBe("alice");
    expect(actor.scopes.workspaceIds).toEqual(["DTSV_China"]);
    expect(actor).not.toHaveProperty("body");
  });
});
```

Add `httpUtils.test.ts` cases proving: 1 MiB JSON rejects with `413 REQUEST_TOO_LARGE`; allowed origins receive matching JSON/SSE/preflight headers and `Access-Control-Expose-Headers: X-Agent-Protocol, X-Agent-Run-ID, X-Agent-Thread-ID`; disallowed origins receive `403`; wildcard with credentials is impossible.

- [ ] **Step 2: Run the tests and verify RED**

```bash
npm test -- \
  src/test/server/agentRuntime/config.test.ts \
  src/test/server/agentRuntime/identity.test.ts \
  src/test/server/agentRuntime/httpUtils.test.ts
```

Expected: FAIL because all three modules are missing.

- [ ] **Step 3: Implement fail-closed Runtime configuration**

```js
const LOOPBACKS = new Set(["127.0.0.1", "::1", "localhost"]);
const csv = (value) => String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
const positiveInt = (value, fallback, label) => {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`INVALID_${label}`);
  return parsed;
};

export function createRuntimeConfig(env) {
  const mode = String(env.MAIN_AGENT_RUNTIME_MODE || "legacy");
  if (!["legacy", "shadow", "langgraph"].includes(mode)) throw new Error("INVALID_MAIN_AGENT_RUNTIME_MODE");
  const host = String(env.VIZION_API_HOST || "127.0.0.1");
  const devHost = String(env.VIZION_DEV_HOST || "127.0.0.1");
  const identityMode = String(env.MAIN_AGENT_IDENTITY_MODE || "dev");
  if (identityMode === "dev" && (!LOOPBACKS.has(host) || !LOOPBACKS.has(devHost))) throw new Error("DEV_IDENTITY_REQUIRES_LOOPBACK");
  if (!['dev', 'trusted-proxy'].includes(identityMode)) throw new Error("INVALID_MAIN_AGENT_IDENTITY_MODE");
  const allowedOrigins = csv(env.MAIN_AGENT_ALLOWED_ORIGINS);
  const trustedProxyAddresses = csv(env.MAIN_AGENT_TRUSTED_PROXY_ADDRESSES || "127.0.0.1,::1");
  if ((!LOOPBACKS.has(host) || !LOOPBACKS.has(devHost)) && (identityMode !== "trusted-proxy" || trustedProxyAddresses.length === 0 || allowedOrigins.length === 0 || env.MAIN_AGENT_TRUST_PROXY_TLS !== "true")) {
    throw new Error("LAN_BIND_REQUIRES_TRUSTED_TLS_PROXY");
  }
  return Object.freeze({
    mode,
    host,
    devHost,
    port: positiveInt(env.VIZION_API_PORT, 3004, "VIZION_API_PORT"),
    identityMode,
    allowedOrigins,
    trustedProxyAddresses,
    requestBodyLimitBytes: positiveInt(env.MAIN_AGENT_REQUEST_BODY_LIMIT_BYTES, 1024 * 1024, "REQUEST_BODY_LIMIT"),
    runtimeDbPath: String(env.MAIN_AGENT_RUNTIME_DB_PATH || "database/runtime/agent-runtime.sqlite"),
    artifactRoot: String(env.MAIN_AGENT_ARTIFACT_ROOT || "database/runtime/artifacts"),
    activeExecutionBudgetMs: positiveInt(env.MAIN_AGENT_ACTIVE_BUDGET_MS, 120000, "ACTIVE_BUDGET"),
    interactionTtlMs: positiveInt(env.MAIN_AGENT_CLARIFICATION_TTL_MS, 24 * 60 * 60 * 1000, "CLARIFICATION_TTL"),
    runHardTtlMs: positiveInt(env.MAIN_AGENT_RUN_HARD_TTL_MS, 24 * 60 * 60 * 1000, "RUN_HARD_TTL"),
    eventRetentionDays: positiveInt(env.MAIN_AGENT_EVENT_RETENTION_DAYS, 30, "EVENT_RETENTION"),
    artifactRetentionDays: positiveInt(env.MAIN_AGENT_ARTIFACT_RETENTION_DAYS, 7, "ARTIFACT_RETENTION"),
    threadRetentionDays: positiveInt(env.MAIN_AGENT_THREAD_RETENTION_DAYS, 90, "THREAD_RETENTION"),
    auditRetentionDays: positiveInt(env.MAIN_AGENT_AUDIT_RETENTION_DAYS, 365, "AUDIT_RETENTION"),
    maxActorActiveRuns: 2,
    maxGlobalActiveRuns: 20,
    maxRunStartsPerMinute: 30,
    runStartBurst: 5,
  });
}
```

- [ ] **Step 4: Implement identity and HTTP helpers**

`createIdentityResolver()` generates `scopeVersion/scopeHash` from canonical scope JSON, rejects missing/untrusted proxy headers, and returns the explicit development actor only in `dev` mode. It emits the complete `ActorContext`, including object/property, row and sensitive-field policies:

```js
import { createHash } from "node:crypto";
const canonical = (value) => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  : Array.isArray(value) ? [...value].sort() : value;
const scopeHash = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const normalizePeer = (value) => String(value || "").replace(/^::ffff:/, "");

export function createIdentityResolver({ mode, trustedProxyAddresses, scopeProvider, devActor }) {
  return async function resolveIdentity(request) {
    if (mode === "dev") return Object.freeze({ ...devActor, scopeHash: scopeHash({ scopeVersion: devActor.scopeVersion, scopes: devActor.scopes }) });
    const peer = normalizePeer(request.socket?.remoteAddress);
    if (!trustedProxyAddresses.map(normalizePeer).includes(peer)) throw Object.assign(new Error("UNTRUSTED_IDENTITY_PROXY"), { statusCode: 401, code: "UNTRUSTED_IDENTITY_PROXY" });
    if (String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim() !== "https") throw Object.assign(new Error("TRUSTED_PROXY_TLS_REQUIRED"), { statusCode: 401, code: "TRUSTED_PROXY_TLS_REQUIRED" });
    const actorId = String(request.headers["x-auth-request-user"] || "").trim();
    const authSessionId = String(request.headers["x-auth-request-session"] || "").trim();
    if (!actorId || !authSessionId) throw Object.assign(new Error("IDENTITY_HEADERS_REQUIRED"), { statusCode: 401, code: "IDENTITY_HEADERS_REQUIRED" });
    const authorization = await scopeProvider({ actorId, authSessionId });
    const scopes = {
      workspaceIds: authorization.workspaceIds || [], projectIds: authorization.projectIds || [], teamIds: authorization.teamIds || [],
      allowedObjectTypes: authorization.allowedObjectTypes || [], allowedPropertyIds: authorization.allowedPropertyIds || [],
      rowPolicyIds: authorization.rowPolicyIds || [], sensitiveFieldPolicyIds: authorization.sensitiveFieldPolicyIds || [],
    };
    const actor = { actorId, authSessionId, roles: authorization.roles || [], scopes, scopeVersion: String(authorization.scopeVersion || "") };
    if (!actor.scopeVersion) throw Object.assign(new Error("SCOPE_VERSION_REQUIRED"), { statusCode: 403, code: "SCOPE_VERSION_REQUIRED" });
    return Object.freeze({ ...actor, scopeHash: scopeHash({ scopeVersion: actor.scopeVersion, scopes }) });
  };
}
```

Tests cover IPv4-mapped IPv6 peers, missing/forged headers, non-HTTPS forwarding, scope-order-stable hashes, scope rotation changing the hash, and body `actorId/scopes` being ignored. `readJsonBody(request, { maxBytes })` stops as soon as the limit is exceeded. CORS is applied to normal JSON, SSE, error, and preflight responses.

```js
export async function readJsonBody(request, { maxBytes }) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Object.assign(new Error("REQUEST_TOO_LARGE"), { statusCode: 413, code: "REQUEST_TOO_LARGE" });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error("INVALID_JSON"), { statusCode: 400, code: "INVALID_JSON" }); }
}

export async function readBinaryBody(request, { maxBytes }) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Object.assign(new Error("ARTIFACT_TOO_LARGE"), { statusCode: 413, code: "ARTIFACT_TOO_LARGE" });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function corsHeaders(origin, { allowedOrigins }) {
  if (!origin) return {};
  if (!allowedOrigins.includes(origin)) throw Object.assign(new Error("ORIGIN_NOT_ALLOWED"), { statusCode: 403, code: "ORIGIN_NOT_ALLOWED" });
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Headers": "content-type, authorization, last-event-id, x-csrf-token, x-artifact-file-name, x-agent-thread-id",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Expose-Headers": "X-Agent-Protocol, X-Agent-Run-ID, X-Agent-Thread-ID",
  };
}

export function applyCors(response, request, config) {
  const headers = corsHeaders(String(request.headers.origin || ""), config);
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
}
export function writeJson(response, request, config, statusCode, body, extraHeaders = {}) {
  applyCors(response, request, config);
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders });
  response.end(JSON.stringify(body));
}
export function writeSseHeaders(response, request, config, extraHeaders = {}) {
  applyCors(response, request, config);
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no", ...extraHeaders });
}
export function handlePreflight(response, request, config) {
  applyCors(response, request, config);
  response.writeHead(204); response.end();
}
export function writeHttpError(response, request, config, error) {
  const statusCode = Number(error?.statusCode || 500);
  const code = String(error?.code || "INTERNAL_ERROR");
  const safeMessage = statusCode >= 500 ? "Agent service is temporarily unavailable." : String(error?.safeMessage || code);
  writeJson(response, request, config, statusCode, { code, safeMessage, retryable: Boolean(error?.retryable), ...(error?.snapshotUrl ? { snapshotUrl: error.snapshotUrl } : {}) }, error?.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {});
}
```

- [ ] **Step 5: Make Vite loopback-safe by default**

Change `vite.config.ts` to use the already-validated `VIZION_DEV_HOST` value, defaulting to `127.0.0.1`, instead of `"::"`. Keep the existing `/api` catch-all proxy unchanged. `config.test.ts` proves that either Vite or Node binding to a non-loopback address fails unless trusted-proxy mode, a trusted peer list, a non-empty origin allowlist, and TLS termination acknowledgement are all present.

- [ ] **Step 6: Run focused tests**

```bash
npm test -- \
  src/test/server/agentRuntime/config.test.ts \
  src/test/server/agentRuntime/identity.test.ts \
  src/test/server/agentRuntime/httpUtils.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/agentRuntime/config.mjs server/agentRuntime/identity.mjs server/agentRuntime/httpUtils.mjs vite.config.ts src/test/server/agentRuntime/config.test.ts src/test/server/agentRuntime/identity.test.ts src/test/server/agentRuntime/httpUtils.test.ts
git commit -m "feat: secure main agent runtime ingress"
```

### Task 6: Create the versioned Runtime SQLite schema and offline migration

**Files:**
- Create: `server/agentRuntime/migrations/001-runtime.sql`
- Create: `server/agentRuntime/runtimeDb.mjs`
- Create: `server/agentRuntime/checkpoint.mjs` (offline Saver setup/readiness only; Task 9 adds canonical coordination)
- Create: `scripts/migrateAgentRuntime.mjs`
- Create: `src/test/server/agentRuntime/runtimeDb.test.ts`
- Create: `src/test/server/agentRuntime/runtimeDbFixture.ts`
- Create: `database/runtime/.gitkeep`
- Modify: `package.json`

- [ ] **Step 1: Write the failing migration and pragma tests**

Start the file with `// @vitest-environment node`, create a temporary directory per test, and assert both startup modes:

```ts
// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateRuntimeDb, openRuntimeDb } from "../../../../server/agentRuntime/runtimeDb.mjs";

const roots: string[] = [];
const nextDb = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runtime-"));
  roots.push(root);
  return path.join(root, "runtime.sqlite");
};
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe("Runtime SQLite", () => {
  it("requires the application and Saver offline migration before normal startup", async () => {
    const dbPath = nextDb();
    expect(() => openRuntimeDb({ dbPath, expectedVersion: 1 })).toThrow(/RUNTIME_SCHEMA_NOT_READY/);
    await migrateRuntimeDb({ dbPath, targetVersion: 1 });
    const runtime = openRuntimeDb({ dbPath, expectedVersion: 1 });
    expect(runtime.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(runtime.db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(runtime.db.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(runtime.db.prepare("SELECT version FROM agent_schema_migrations").pluck().all()).toEqual([1]);
    runtime.close();
  });

  it("keeps application SQL away from Saver-private tables", () => {
    const sql = fs.readFileSync("server/agentRuntime/migrations/001-runtime.sql", "utf8");
    const created = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)/gi)].map((match) => match[1]);
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((name) => name.startsWith("agent_"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

```bash
npm test -- src/test/server/agentRuntime/runtimeDb.test.ts
```

Expected: FAIL because `runtimeDb.mjs` is missing.

- [ ] **Step 3: Add the complete application-owned schema**

`001-runtime.sql` must contain these tables and constraints; no statement may reference a LangGraph Saver table:

```sql
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS agent_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_saver_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_threads (
  thread_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  parent_thread_id TEXT REFERENCES agent_threads(thread_id),
  parent_run_id TEXT,
  parent_checkpoint_id TEXT,
  supersedes_message_id TEXT,
  title TEXT NOT NULL DEFAULT '新对话',
  thread_version INTEGER NOT NULL DEFAULT 0 CHECK (thread_version >= 0),
  scope_version TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_threads_actor_updated ON agent_threads(actor_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES agent_threads(thread_id),
  actor_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  parent_run_id TEXT REFERENCES agent_runs(run_id),
  parent_checkpoint_id TEXT,
  request_hash TEXT NOT NULL,
  graph_definition_version TEXT NOT NULL,
  runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('legacy','shadow','langgraph')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_for_clarification','waiting_for_approval','completed','failed','cancelled')),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_owner TEXT,
  lease_expires_at TEXT,
  requested_model_id TEXT NOT NULL,
  actual_model_id TEXT NOT NULL,
  model_config_version TEXT NOT NULL,
  scope_version TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  canonical_checkpoint_id TEXT,
  canonical_state_hash TEXT,
  active_execution_budget_ms INTEGER NOT NULL,
  active_execution_consumed_ms INTEGER NOT NULL DEFAULT 0,
  active_segment_started_at TEXT,
  hard_expires_at TEXT NOT NULL,
  cancel_requested_at TEXT,
  answer_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  UNIQUE(actor_id, message_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_active_per_thread
  ON agent_runs(thread_id)
  WHERE status IN ('queued','running','waiting_for_clarification','waiting_for_approval');
CREATE INDEX IF NOT EXISTS agent_runs_reaper ON agent_runs(status, lease_expires_at, hard_expires_at);

CREATE TABLE IF NOT EXISTS agent_messages (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES agent_threads(thread_id),
  run_id TEXT REFERENCES agent_runs(run_id),
  parent_message_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  body_json TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(thread_id, message_id)
);
CREATE INDEX IF NOT EXISTS agent_messages_thread_created ON agent_messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS agent_summaries (
  summary_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES agent_threads(thread_id),
  body_json TEXT NOT NULL,
  source_message_ids_json TEXT NOT NULL,
  semantic_frame_refs_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  summary_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_model_turns (
  turn_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
  invocation_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content_ref TEXT,
  content_hash TEXT,
  tool_call_id TEXT,
  tool_name TEXT,
  body_json TEXT NOT NULL DEFAULT '{}',
  scope_hash TEXT NOT NULL,
  graph_definition_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_model_turns_run_created ON agent_model_turns(run_id, created_at);

CREATE TABLE IF NOT EXISTS agent_interactions (
  interaction_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
  kind TEXT NOT NULL CHECK (kind IN ('clarification','approval')),
  status TEXT NOT NULL CHECK (status IN ('pending','consumed','expired','cancelled')),
  payload_json TEXT NOT NULL,
  result_json TEXT,
  scope_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_interactions_one_pending_per_run
  ON agent_interactions(run_id) WHERE status='pending';

CREATE TABLE IF NOT EXISTS agent_step_journal (
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
  node_id TEXT NOT NULL,
  logical_attempt INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  graph_definition_version TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','completed','failed','unknown')),
  result_json TEXT,
  error_json TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY(run_id, node_id, logical_attempt, input_hash)
);

CREATE TABLE IF NOT EXISTS agent_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
  thread_id TEXT NOT NULL REFERENCES agent_threads(thread_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  state_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE(run_id, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_events_one_terminal
  ON agent_events(run_id)
  WHERE event_type IN ('run.completed','run.failed','run.cancelled');

CREATE TABLE IF NOT EXISTS agent_event_tombstones (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  expired_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_artifact_blobs (
  content_hash TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  storage_path TEXT NOT NULL,
  extraction_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_artifacts (
  artifact_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  workspace_scope_hash TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  content_hash TEXT NOT NULL REFERENCES agent_artifact_blobs(content_hash),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(actor_id, content_hash)
);

CREATE TABLE IF NOT EXISTS agent_thread_artifacts (
  thread_id TEXT NOT NULL REFERENCES agent_threads(thread_id),
  artifact_id TEXT NOT NULL REFERENCES agent_artifacts(artifact_id),
  scope_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(thread_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS agent_run_artifacts (
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
  artifact_id TEXT NOT NULL REFERENCES agent_artifacts(artifact_id),
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS agent_legacy_imports (
  actor_id TEXT NOT NULL,
  client_conversation_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES agent_threads(thread_id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(actor_id, client_conversation_id)
);

CREATE TABLE IF NOT EXISTS agent_audit (
  audit_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  thread_id TEXT,
  run_id TEXT,
  action TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS agent_audit_no_update BEFORE UPDATE ON agent_audit
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_AUDIT'); END;

CREATE TABLE IF NOT EXISTS agent_actor_rate_limits (
  actor_id TEXT PRIMARY KEY,
  tokens REAL NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_instance_guard (
  guard_key TEXT PRIMARY KEY CHECK (guard_key='sqlite-single-instance'),
  owner_id TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL
);

INSERT OR IGNORE INTO agent_schema_migrations(version, applied_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

COMMIT;
```

- [ ] **Step 4: Implement offline migration and version-checked open**

```js
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { setupSqliteSaverForMigration } from "./checkpoint.mjs";

const migrationPath = new URL("./migrations/001-runtime.sql", import.meta.url);
const configure = (db) => {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
};

export async function migrateRuntimeDb({ dbPath, targetVersion }) {
  if (targetVersion !== 1) throw new Error(`UNSUPPORTED_RUNTIME_SCHEMA_VERSION:${targetVersion}`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    configure(db);
    db.exec(fs.readFileSync(migrationPath, "utf8"));
  } finally { db.close(); }
  await setupSqliteSaverForMigration({ dbPath });
  const markerDb = new Database(dbPath);
  try {
    configure(markerDb);
    markerDb.prepare("INSERT OR REPLACE INTO agent_saver_migrations(version,applied_at) VALUES(?,?)").run("langgraph-sqlite-1.0.3", new Date().toISOString());
  } finally { markerDb.close(); }
}

export function openRuntimeDb({ dbPath, expectedVersion }) {
  if (!fs.existsSync(dbPath)) throw new Error("RUNTIME_SCHEMA_NOT_READY:database_missing");
  const db = new Database(dbPath);
  configure(db);
  let version;
  try { version = db.prepare("SELECT MAX(version) FROM agent_schema_migrations").pluck().get(); }
  catch { db.close(); throw new Error("RUNTIME_SCHEMA_NOT_READY:migration_table_missing"); }
  if (version !== expectedVersion) { db.close(); throw new Error(`RUNTIME_SCHEMA_NOT_READY:expected=${expectedVersion}:actual=${version}`); }
  const saverReady = db.prepare("SELECT 1 FROM agent_saver_migrations WHERE version=?").pluck().get("langgraph-sqlite-1.0.3");
  if (!saverReady) { db.close(); throw new Error("RUNTIME_SAVER_NOT_READY"); }
  return { db, transaction: (fn) => db.transaction(fn), close: () => db.close() };
}
```

`openRuntimeDb()` also exposes `claimSingleInstance({ ownerId, leaseMs })`, `renewSingleInstance()` and `releaseSingleInstance()`. The claim uses `BEGIN IMMEDIATE` and may replace the fixed guard row only when its database timestamp has expired; a second live owner receives `SQLITE_SINGLE_INSTANCE_REQUIRED`. Production composition claims it before starting background workers and renews it every 10 seconds.

`setupSqliteSaverForMigration()` is the only place that runs the checkpointer package's documented setup operation. Runtime composition may construct a Saver only after the marker/version check and must never call setup. Add one CLI test proving a clean app+Saver migration succeeds, one proving `--check` leaves DB hash/mtime unchanged, and one proving startup fails when only the application marker exists.

```js
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

export async function setupSqliteSaverForMigration({ dbPath }) {
  const saver = SqliteSaver.fromConnString(dbPath);
  try {
    // setup() is protected; an offline, read-only public call performs the documented lazy setup.
    await saver.getTuple({ configurable: { thread_id: "__migration_probe__", checkpoint_ns: "" } });
    await saver.deleteThread("__migration_probe__");
  } finally {
    saver.db.close();
  }
}

export function createReadySqliteSaver({ dbPath, runtimeDb }) {
  const ready = runtimeDb.db.prepare("SELECT 1 FROM agent_saver_migrations WHERE version=?").pluck().get("langgraph-sqlite-1.0.3");
  if (!ready) throw new Error("RUNTIME_SAVER_NOT_READY");
  return SqliteSaver.fromConnString(dbPath);
}
```

The migration CLI requires `--db-path`, supports `--check`, and refuses to migrate while the singleton guard is live. For an existing DB it creates a consistent backup with `better-sqlite3`'s backup API at `<db>.backup-<UTC timestamp>`; it never byte-copies a live WAL file. It runs `PRAGMA integrity_check` on the backup and source before applying, then awaits `migrateRuntimeDb()`. Add scripts:

```json
{
  "agent:runtime:migrate": "node scripts/migrateAgentRuntime.mjs",
  "agent:runtime:check": "node scripts/migrateAgentRuntime.mjs --check"
}
```

- [ ] **Step 5: Run focused tests and CLI smoke**

```bash
npm test -- src/test/server/agentRuntime/runtimeDb.test.ts
tmp_db="$(mktemp -d)/runtime.sqlite"
npm run agent:runtime:migrate -- --db-path "$tmp_db"
npm run agent:runtime:check -- --db-path "$tmp_db"
```

Expected: tests pass; migrate and check both exit 0.

Create `runtimeDbFixture.ts` with `createRuntimeDbFixture()`: it makes a temp directory, awaits the full app+Saver migration, opens the DB, and returns `{ root, dbPath, runtimeDb, cleanup }`. `cleanup()` closes the DB and recursively removes the directory. All later Node-environment Runtime tests import this helper so foreign keys and real migrations are never bypassed.

- [ ] **Step 6: Commit**

```bash
git add server/agentRuntime/migrations/001-runtime.sql server/agentRuntime/runtimeDb.mjs server/agentRuntime/checkpoint.mjs scripts/migrateAgentRuntime.mjs src/test/server/agentRuntime/runtimeDb.test.ts src/test/server/agentRuntime/runtimeDbFixture.ts database/runtime/.gitkeep package.json package-lock.json
git commit -m "feat: add main agent runtime database"
```

### Task 7: Implement thread, run, interaction, version, and lease lifecycle

**Files:**
- Create: `server/agentRuntime/threadStore.mjs`
- Create: `src/test/server/agentRuntime/threadStore.test.ts`
- Create: `src/test/server/agentRuntime/runLifecycle.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Use a migrated temporary DB and inject `now()` plus `randomUUID()` so assertions are deterministic. Cover all of these in concrete tests:

```ts
const fixture = await createRuntimeDbFixture();
let nowMs = Date.parse("2026-07-14T00:00:00.000Z");
const clock = { now: () => new Date(nowMs).toISOString(), advance: (ms: number) => { nowMs += ms; } };
let id = 0;
const store = createThreadStore({
  db: fixture.runtimeDb.db,
  now: clock.now,
  randomUUID: () => `id-${++id}`,
  writeEventsInTransaction: (_tx, events) => events,
});
const actor = { actorId: "alice", authSessionId: "session-1", roles: ["qa"], scopes: { workspaceIds: ["DTSV_China"], projectIds: ["SP25"], teamIds: ["DTSV"], allowedObjectTypes: ["defect"], allowedPropertyIds: [], rowPolicyIds: ["dtsv"], sensitiveFieldPolicyIds: [] }, scopeVersion: "scope-v1", scopeHash: "scope-a" };
const sameInput = {
  actor, expectedThreadVersion: 0, messageId: "msg-1", requestHash: "hash-a",
  graphDefinitionVersion: "main-agent-v1", runtimeMode: "langgraph",
  requestedModelId: "deepseek-v4-flash", actualModelId: "deepseek-v4-flash", modelConfigVersion: "test-v1",
  activeExecutionBudgetMs: 120000, hardExpiresAt: "2026-07-15T00:00:00.000Z",
};
const thread = store.createThread({ actor, title: "新对话" });
expect(thread).toMatchObject({ threadVersion: 0, actorId: "alice" });

const first = store.createRun({ ...sameInput, threadId: thread.threadId });
const retry = store.createRun({ ...sameInput, threadId: thread.threadId });
expect(retry.runId).toBe(first.runId);
expect(() => store.createRun({ ...sameInput, threadId: thread.threadId, requestHash: "different" })).toThrow(/IDEMPOTENCY_CONFLICT/);

const lease = store.claimRun({ runId: first.runId, workerId: "worker-a", leaseMs: 30000 });
expect(() => store.claimRun({ runId: first.runId, workerId: "worker-b", leaseMs: 30000 })).toThrow(/RUN_LEASE_HELD/);
clock.advance(30001);
const replacement = store.claimRun({ runId: first.runId, workerId: "worker-b", leaseMs: 30000 });
expect(replacement.leaseEpoch).toBe(lease.leaseEpoch + 1);
expect(() => store.commitState({ runId: first.runId, expectedStateVersion: 0, leaseEpoch: lease.leaseEpoch, patch: { status: "running" } })).toThrow(/STALE_RUN_LEASE/);
```

Add named tests with these exact calls/outcomes:

| Test | Assertion |
|---|---|
| `denies a different actor` | `getThread/getRun/listMessages` throw `NOT_FOUND` for `bob` |
| `keeps one active run per thread` | second `createRun` with a new message returns `THREAD_BUSY` |
| `separates visible and internal versions` | tool progress increments `stateVersion` only; message/interaction/final/metadata increments `threadVersion` |
| `consumes a clarification once` | first consume stores canonical `result_json` and sets run `running`; identical retry returns it, changed value returns `409 INTERACTION_ALREADY_CONSUMED` |
| `cancels a waiting run` | interaction becomes `cancelled`, epoch increments, run becomes `cancelled`; repeated cancel is idempotent |
| `settles active time once` | two CAS attempts over the same segment add elapsed database milliseconds once |
| `reaps deterministically` | interaction expiry and hard deadline transitions are idempotent and release the active-thread index |

- [ ] **Step 2: Run the tests and verify RED**

```bash
npm test -- src/test/server/agentRuntime/threadStore.test.ts src/test/server/agentRuntime/runLifecycle.test.ts
```

Expected: FAIL because `threadStore.mjs` does not exist.

- [ ] **Step 3: Implement the public store contract with fenced SQL**

Export `createThreadStore({ db, now, randomUUID, writeEventsInTransaction })` with exactly these methods:

```js
{
  createThread, getThread, updateThread, importLegacyThread, forkThread,
  appendMessage, listMessages,
  createRun, getRun, claimRun, renewLease, assertLease, commitState, promoteCanonicalCheckpoint,
  createInteraction, consumeInteraction, cancelRun, completeRun, failRun,
  listExpiredInteractions, listRecoverableRuns, reapExpiredRun,
}
```

Canonical request hashes use sorted-key JSON, include target thread/version plus optional parent run/checkpoint branch, and exclude `eventProtocolVersion`, event cursor, and other transport-only fields. `createRun()` performs its lookup/insert and active-run check in one `BEGIN IMMEDIATE` transaction. Every worker write must contain both fences:

```sql
UPDATE agent_runs
SET state_version = state_version + 1,
    status = @status,
    updated_at = @now
WHERE run_id = @runId
  AND state_version = @expectedStateVersion
  AND lease_epoch = @leaseEpoch;
```

If `changes !== 1`, re-read the run and throw `STALE_RUN_LEASE` when epoch differs, otherwise `STATE_VERSION_CONFLICT`. Terminal methods first verify status is not already terminal and require `writeEventsInTransaction(tx, events)` inside the same `db.transaction()` that updates run/thread/interaction state. Task 7 tests inject a recording writer; Task 8 supplies the validated outbox writer. Without it, terminal methods throw `EVENT_WRITER_REQUIRED` rather than committing a status with no terminal event.

`createRun()` initializes the required durable timing fields exactly:

```js
{
  status: "queued",
  stateVersion: 0,
  leaseEpoch: 0,
  activeExecutionBudgetMs: input.activeExecutionBudgetMs,
  activeExecutionConsumedMs: 0,
  activeSegmentStartedAt: now(),
  hardExpiresAt: input.hardExpiresAt,
}
```

`forkThread()` authorizes the parent, requires `parentCheckpointId` to be the exact canonical ID of `parentRunId`, and first calls the coordinator catch-up hook injected by Runtime. It creates a server ID and branch-provenance columns, copies only messages and authorized summaries up to that checkpoint plus explicitly confirmed semantic refs, and copies no run-scoped evidence, model turns, tool attempts, pending interaction, answer draft or action state. An edit records `supersedesMessageId` and appends the replacement under a new message ID.

- [ ] **Step 4: Implement interaction and reaper CAS behavior**

For a valid clarification resume, one transaction marks the interaction `consumed`, stores canonical `result_json`, increments `threadVersion`, fences/increments the lease and changes the run to `running`; this is not terminal. For cancel or expiry, the same transaction sets interaction `cancelled/expired`, increments `threadVersion` and lease, writes `run.cancelled` or `interaction.expired + run.failed`, and terminalizes. Never wait for an in-memory worker when a run is already waiting. A late resume returns `INTERACTION_EXPIRED` or `INTERACTION_ALREADY_CONSUMED`; it never creates a second run.

- [ ] **Step 5: Run focused tests**

```bash
npm test -- src/test/server/agentRuntime/threadStore.test.ts src/test/server/agentRuntime/runLifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/agentRuntime/threadStore.mjs src/test/server/agentRuntime/threadStore.test.ts src/test/server/agentRuntime/runLifecycle.test.ts
git commit -m "feat: persist agent thread and run lifecycle"
```

### Task 8: Add the transactional event outbox and replayable SSE profiles

**Files:**
- Create: `server/agentRuntime/events.mjs`
- Create: `src/test/server/agentRuntime/events.test.ts`

- [ ] **Step 1: Write failing event-store and replay tests**

```ts
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContractRegistry } from "../../../../server/agentRuntime/contracts.mjs";
import { createEventStore, mapEventToLegacy } from "../../../../server/agentRuntime/events.mjs";
import { createThreadStore } from "../../../../server/agentRuntime/threadStore.mjs";
import { createRuntimeDbFixture } from "./runtimeDbFixture";

describe("Agent event outbox", () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeDbFixture>>;
  let events: ReturnType<typeof createEventStore>;
  let store: ReturnType<typeof createThreadStore>;
  const actor = { actorId: "alice", authSessionId: "s1", roles: ["qa"], scopes: { workspaceIds: ["DTSV"], projectIds: ["SP25"], teamIds: ["DTSV"], allowedObjectTypes: ["defect"], allowedPropertyIds: [], rowPolicyIds: ["dtsv"], sensitiveFieldPolicyIds: [] }, scopeVersion: "v1", scopeHash: "scope-a" };
  let run: { runId: string; threadId: string; stateVersion: number; leaseEpoch: number };

  beforeEach(async () => {
    fixture = await createRuntimeDbFixture();
    events = createEventStore({ db: fixture.runtimeDb.db, contracts: createContractRegistry(), now: () => "2026-07-14T00:00:00.000Z", randomUUID: (() => { let id = 0; return () => `event-${++id}`; })(), authorizeRun: ({ actor: current, row }) => current.actorId === row.actor_id && current.scopeHash === row.scope_hash });
    store = createThreadStore({ db: fixture.runtimeDb.db, now: () => "2026-07-14T00:00:00.000Z", randomUUID: (() => { let id = 0; return () => `store-${++id}`; })(), writeEventsInTransaction: events.writeInTransaction });
    const thread = store.createThread({ actor, title: "test" });
    const created = store.createRun({ actor, threadId: thread.threadId, expectedThreadVersion: 0, messageId: "msg-1", requestHash: "hash-1", graphDefinitionVersion: "main-agent-v1", runtimeMode: "langgraph", requestedModelId: "deepseek-v4-flash", actualModelId: "deepseek-v4-flash", modelConfigVersion: "test-v1", activeExecutionBudgetMs: 120000, hardExpiresAt: "2026-07-15T00:00:00.000Z" });
    run = store.claimRun({ runId: created.runId, workerId: "worker-1", leaseMs: 30000 });
  });
  afterEach(() => fixture.cleanup());

  it("allocates one monotonic sequence and rejects a second terminal event", () => {
    const [started] = events.commitTransition({ actor, runId: run.runId, expectedStateVersion: 0, leaseEpoch: run.leaseEpoch, patch: { status: "running" }, eventInputs: [{ type: "tool.started", payload: { attemptId: "a1", stepId: "s1", toolName: "query_dashboard_summary", redactedCanonicalArgs: {} } }] });
    const completed = events.appendAnswer({ actor, runId: run.runId, expectedStateVersion: 1, leaseEpoch: run.leaseEpoch, assistantMessageId: "assistant-1", threadVersion: 2, durationMs: 10, answer: { schemaVersion: "1.0", answerId: "answer-1", text: "答案", contentHash: "hash", acceptedClaimIds: [], citations: [], assumptions: [], limitations: [], groundingStatus: "legacy_equivalence", sourceRevisionSet: {} } });
    expect([started.sequence, completed.sequence]).toEqual([1, 3]);
    expect(() => events.commitTransition({ actor, runId: run.runId, expectedStateVersion: 2, leaseEpoch: run.leaseEpoch, patch: { status: "failed" }, eventInputs: [{ type: "run.failed", payload: { code: "X", safeMessage: "x", retryable: false, threadVersion: 3 } }] })).toThrow(/TERMINAL_EVENT_EXISTS|RUN_ALREADY_TERMINAL/);
  });

  it("replays strictly after Last-Event-ID and keeps profiles exclusive", () => {
    const [first] = events.commitTransition({ actor, runId: run.runId, expectedStateVersion: 0, leaseEpoch: run.leaseEpoch, patch: { status: "running" }, eventInputs: [{ type: "tool.started", payload: { attemptId: "a1", stepId: "s1", toolName: "query_dashboard_summary", redactedCanonicalArgs: {} } }] });
    events.appendAnswer({ actor, runId: run.runId, expectedStateVersion: 1, leaseEpoch: run.leaseEpoch, assistantMessageId: "assistant-1", threadVersion: 2, durationMs: 10, answer: { schemaVersion: "1.0", answerId: "answer-1", text: "答案", contentHash: "hash", acceptedClaimIds: [], citations: [], assumptions: [], limitations: [], groundingStatus: "legacy_equivalence", sourceRevisionSet: {} } });
    const replay = events.listAfter({ runId: run.runId, afterEventId: first.eventId, actor });
    expect(replay.map((item) => item.type)).toEqual(["answer.delta", "run.completed"]);
    expect(mapEventToLegacy(replay[0], { resolveToolName: () => "query_dashboard_summary" })).toEqual({ choices: [{ delta: { content: "答案" } }] });
  });

  it("uses UTF-8 byte offsets for persisted answer chunks", () => {
    events.appendAnswer({ actor, runId: run.runId, expectedStateVersion: 0, leaseEpoch: run.leaseEpoch, assistantMessageId: "assistant-1", threadVersion: 2, durationMs: 10, maxChunkCharacters: 1, answer: { schemaVersion: "1.0", answerId: "answer-1", text: "中文A", contentHash: "hash", acceptedClaimIds: [], citations: [], assumptions: [], limitations: [], groundingStatus: "legacy_equivalence", sourceRevisionSet: {} } });
    const chunks = events.listAfter({ runId: run.runId, afterSequence: 0, actor }).filter((item) => item.type === "answer.delta");
    expect(chunks.map((item) => item.payload.offset)).toEqual([0, 3, 6]);
    expect(chunks[0].payload.offset).toBe(0);
    expect(Buffer.byteLength(chunks.map((item) => item.payload.text).join(""), "utf8")).toBe(7);
  });
});
```

Add explicit cases for stale `leaseEpoch`, state CAS conflict, actor denial, scope rotation, unknown event type, duplicate `(run, sequence)`, live cursor from another run, retained tombstone returning `410 EVENT_HISTORY_EXPIRED` plus snapshot link, forged cursor returning `400 INVALID_EVENT_CURSOR`, terminal followed by any late event, replay/subscribe race, and heartbeat comments consuming no sequence.

- [ ] **Step 2: Run the event tests and verify RED**

```bash
npm test -- src/test/server/agentRuntime/events.test.ts
```

Expected: FAIL because `events.mjs` does not exist.

- [ ] **Step 3: Implement event append/list and terminal enforcement**

```js
import { EventEmitter } from "node:events";

export function createEventStore({ db, contracts, now, randomUUID, authorizeRun }) {
  const notifier = new EventEmitter();
  const writeInTransaction = (tx, { run, stateVersion, leaseEpoch, eventInputs }) => {
    const alreadyTerminal = tx.prepare("SELECT 1 FROM agent_events WHERE run_id=? AND event_type IN ('run.completed','run.failed','run.cancelled')").get(run.run_id);
    if (alreadyTerminal) throw new Error("TERMINAL_EVENT_EXISTS");
    let sequence = Number(tx.prepare("SELECT COALESCE(MAX(sequence),0) FROM agent_events WHERE run_id=?").pluck().get(run.run_id));
    return eventInputs.map((input) => {
      sequence += 1;
      const event = contracts.validateAgentEvent({ schemaVersion: "1.0", eventId: randomUUID(), runId: run.run_id, threadId: run.thread_id, stateVersion, sequence, timestamp: now(), type: input.type, payload: input.payload });
      tx.prepare("INSERT INTO agent_events(event_id,run_id,thread_id,sequence,state_version,event_type,payload_json,scope_hash,lease_epoch,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(event.eventId, event.runId, event.threadId, event.sequence, event.stateVersion, event.type, JSON.stringify(event.payload), run.scope_hash, leaseEpoch, event.timestamp);
      return event;
    });
  };
  const transition = db.transaction((input) => {
    const run = db.prepare("SELECT * FROM agent_runs WHERE run_id=?").get(input.runId);
    if (!run || run.actor_id !== input.actor.actorId) throw new Error("NOT_FOUND");
    authorizeRun({ actor: input.actor, row: run });
    if (run.state_version !== input.expectedStateVersion) throw new Error("STATE_VERSION_CONFLICT");
    if (run.lease_epoch !== input.leaseEpoch) throw new Error("STALE_RUN_LEASE");
    if (["completed", "failed", "cancelled"].includes(run.status)) throw new Error("RUN_ALREADY_TERMINAL");
    input.mutate?.(db, run);
    const nextStateVersion = run.state_version + 1;
    const updated = db.prepare("UPDATE agent_runs SET state_version=?,status=?,updated_at=?,answer_json=COALESCE(?,answer_json),error_json=COALESCE(?,error_json),terminal_at=CASE WHEN ? IN ('completed','failed','cancelled') THEN ? ELSE terminal_at END WHERE run_id=? AND state_version=? AND lease_epoch=?")
      .run(nextStateVersion, input.patch.status || run.status, now(), input.patch.answerJson || null, input.patch.errorJson || null, input.patch.status || run.status, now(), run.run_id, run.state_version, run.lease_epoch);
    if (updated.changes !== 1) throw new Error("STALE_RUN_TRANSITION");
    return writeInTransaction(db, { run, stateVersion: nextStateVersion, leaseEpoch: run.lease_epoch, eventInputs: input.eventInputs });
  });
  const commitTransition = (input) => {
    const committed = transition(input);
    queueMicrotask(() => committed.forEach((event) => notifier.emit(event.runId, event)));
    return committed;
  };
  const listAfter = ({ runId, afterEventId, afterSequence = 0, actor }) => {
    const run = db.prepare("SELECT * FROM agent_runs WHERE run_id=?").get(runId);
    if (!run) throw new Error("NOT_FOUND");
    authorizeRun({ actor, row: run });
    let sequence = afterSequence;
    if (afterEventId) {
      const cursor = db.prepare("SELECT sequence FROM agent_events WHERE run_id=? AND event_id=?").get(runId, afterEventId);
      if (!cursor) {
        const tombstone = db.prepare("SELECT run_id,sequence FROM agent_event_tombstones WHERE event_id=?").get(afterEventId);
        if (tombstone?.run_id === runId) throw Object.assign(new Error("EVENT_HISTORY_EXPIRED"), { statusCode: 410, code: "EVENT_HISTORY_EXPIRED", snapshotUrl: `/api/agent/threads/${run.thread_id}` });
        throw Object.assign(new Error("INVALID_EVENT_CURSOR"), { statusCode: 400, code: "INVALID_EVENT_CURSOR" });
      }
      sequence = cursor.sequence;
    }
    return db.prepare("SELECT * FROM agent_events WHERE run_id=? AND sequence>? ORDER BY sequence").all(runId, sequence).map((row) => ({
      schemaVersion: "1.0", eventId: row.event_id, runId: row.run_id, threadId: row.thread_id,
      stateVersion: row.state_version, sequence: row.sequence, timestamp: row.created_at,
      type: row.event_type, payload: JSON.parse(row.payload_json),
    }));
  };
  return { writeInTransaction, commitTransition, listAfter, notifier };
}
```

`appendAnswer()` accepts only a contract-validated `AnswerEnvelope`, splits `Array.from(answer.text)` into at most 512-code-point chunks, calculates each offset from the UTF-8 bytes of the preceding text, and calls the same fenced transition once with `patch.status="completed"` and `patch.answerJson`. Its mutation inserts the assistant conversation message by stable ID and CAS-increments `agent_threads.thread_version`; its event inputs are all `answer.delta` rows followed by exactly one `run.completed`, and it returns that terminal event. Thus answer/message/thread/run persistence, deltas and terminal status/event either all commit or all roll back. It never accepts raw model chunks. Terminal transitions with no terminal event, a terminal event without terminal status, or any post-terminal event are rejected.

Before insertion, coalesce `tool.progress` per attempt to at most four committed events per second. Progress is advisory and never replaces `tool.completed/tool.failed`; heartbeat remains an SSE comment outside the event table.

- [ ] **Step 4: Implement explicit protocol mapping and streaming**

```js
export function mapEventToLegacy(event, { resolveToolName }) {
  if (event.type === "tool.started") return { type: "tool-input-available", toolCallId: event.payload.attemptId, toolName: event.payload.toolName, input: event.payload.redactedCanonicalArgs };
  if (event.type === "tool.completed") return { type: "tool-output-available", toolCallId: event.payload.attemptId, toolName: resolveToolName(event.payload.attemptId), outputSummary: `${event.payload.status}: ${event.payload.evidenceIds.join(",")}` };
  if (event.type === "tool.failed") return { type: "tool-output-available", toolCallId: event.payload.attemptId, toolName: resolveToolName(event.payload.attemptId), outputSummary: `${event.payload.status}: ${event.payload.safeMessage}` };
  if (event.type === "answer.delta") return { choices: [{ delta: { content: event.payload.text } }] };
  if (event.type === "run.failed") return { type: "error", message: event.payload.safeMessage };
  if (event.type === "run.cancelled") return { type: "error", message: "Request cancelled" };
  if (["run.started", "input.prepared", "intent.resolved", "ontology.resolved", "clarification.required", "plan.updated", "plan.validated", "evidence.added", "claims.validated", "run.resumed", "interaction.expired"].includes(event.type)) {
    return { type: "status", message: event.type };
  }
  return null;
}

export const encodeSseEvent = (event, profile, dependencies) => {
  const payload = profile === "agent-v1" ? event : mapEventToLegacy(event, dependencies);
  if (!payload) return "";
  return `id: ${event.eventId}\nevent: message\ndata: ${JSON.stringify(payload)}\n\n`;
};
export const encodeHeartbeat = () => `: heartbeat\n\n`;
```

`streamEvents()` subscribes before querying replay, buffers notifications during the query, emits committed replay rows, then drains the buffer through an event-ID/sequence deduper; this closes the replay/subscribe race. It polls the DB every second as a safety net, writes a heartbeat every 15 seconds, and removes timers/listeners on request abort or response close. It refreshes/authorizes `ActorContext` on every reconnect and before emitting buffered rows; a changed scope returns `SCOPE_CHANGED_RELOAD_REQUIRED` instead of replaying old payloads. Legacy profile writes `data: [DONE]\n\n` only after a terminal event; agent-v1 never emits `[DONE]`.

- [ ] **Step 5: Run the event tests**

```bash
npm test -- src/test/server/agentRuntime/events.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/agentRuntime/events.mjs src/test/server/agentRuntime/events.test.ts
git commit -m "feat: add replayable agent event outbox"
```

### Task 9: Add the fenced step journal and canonical checkpoint coordinator

**Files:**
- Create: `server/agentRuntime/stepJournal.mjs`
- Modify: `server/agentRuntime/checkpoint.mjs`
- Create: `src/test/server/agentRuntime/stepJournal.test.ts`
- Create: `src/test/server/agentRuntime/checkpoint.test.ts`

- [ ] **Step 1: Write failing journal tests**

```ts
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createStepJournal, hashStepInput } from "../../../../server/agentRuntime/stepJournal.mjs";

it("includes graph version, refreshed scope and source revisions in the stable key", () => {
  const common = { graphDefinitionVersion: "main-agent-v1", scopeHash: "scope-a", sourceRevisionSet: { analytics: { revisionId: "r1" } }, input: { filters: { years: "2026" } } };
  expect(hashStepInput(common)).not.toBe(hashStepInput({ ...common, scopeHash: "scope-b" }));
  expect(hashStepInput(common)).not.toBe(hashStepInput({ ...common, graphDefinitionVersion: "main-agent-v2" }));
});

it("returns a committed result instead of repeating an external call", async () => {
  const { journal, input } = await setupJournalFixture({ boundaryKind: "read" });
  const execute = vi.fn().mockResolvedValue({ rows: 3 });
  await expect(journal.run(input, execute)).resolves.toEqual({ rows: 3 });
  await expect(journal.run(input, execute)).resolves.toEqual({ rows: 3 });
  expect(execute).toHaveBeenCalledTimes(1);
});
```

`setupJournalFixture()` is defined in the test file from `createRuntimeDbFixture()`, the real thread/event stores, one owning actor/thread/run and one claimed lease. Its `input` contains `runId`, `nodeId="execute_tool"`, `logicalAttempt=1`, `boundaryKind`, graph/scope/revision/input values, `expectedStateVersion`, `leaseEpoch`, one `tool.started` input and a function producing `tool.completed`.

Add concrete concurrency assertions: two simultaneous `journal.run()` calls cause one external invocation and one `STEP_IN_PROGRESS`; advancing the clock past the run lease lets a new worker retry an unfinished read boundary; stale worker completion writes neither result/state/event; a write boundary whose transport outcome is uncertain becomes `unknown` and all replays return `STEP_REQUIRES_RECONCILIATION`. Phase 1 registers no write boundary, but the safe status is reserved.

- [ ] **Step 2: Write failing checkpoint tests**

Use a fake graph with `getState`/`updateState` spies and a fake thread store. Start with canonical checkpoint `canonical-1` at state version 4 and committed journal projection at version 5. Assert `ensureCheckpointCaughtUp()` calls `getState()` with `{ thread_id, checkpoint_ns:"", checkpoint_id:"canonical-1" }`, applies the deterministic projection, reads candidate `candidate-2`, and calls `promoteCanonicalCheckpoint({ runId, expectedStateVersion:5, leaseEpoch, checkpointId:"candidate-2", stateHash })`. If promotion returns a CAS conflict, `canonicalConfigForRun()` still returns `canonical-1`; it never selects the Saver latest/orphan.

Add test cases for: a brand-new thread at state version 0 may use an empty root config; any progressed run without a canonical ID fails `CANONICAL_CHECKPOINT_MISSING`; exact state match performs no update; graph version mismatch returns `GRAPH_VERSION_MISMATCH`; and four callers labelled `new-message`, `resume`, `fork`, `recovery` all invoke catch-up before advancing/copying state.

- [ ] **Step 3: Run both test files and verify RED**

```bash
npm test -- src/test/server/agentRuntime/stepJournal.test.ts src/test/server/agentRuntime/checkpoint.test.ts
```

Expected: FAIL because `stepJournal.mjs` is missing and the Task 6 checkpoint module has no canonical coordinator yet.

- [ ] **Step 4: Implement deterministic journal execution**

```js
import { createHash } from "node:crypto";
const stable = (value) => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  : Array.isArray(value) ? value.map(stable) : value;
export const hashStepInput = (value) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");

export function createStepJournal({ db, threadStore, now }) {
  return {
    async run(input, execute) {
      const inputHash = hashStepInput({
        graphDefinitionVersion: input.graphDefinitionVersion,
        scopeHash: input.scopeHash,
        sourceRevisionSet: input.sourceRevisionSet,
        input: input.input,
      });
      const key = [input.runId, input.nodeId, input.logicalAttempt, inputHash];
      const existing = db.prepare("SELECT * FROM agent_step_journal WHERE run_id=? AND node_id=? AND logical_attempt=? AND input_hash=?").get(...key);
      if (existing?.status === "completed") return JSON.parse(existing.result_json);
      if (existing?.status === "unknown") throw new Error("STEP_REQUIRES_RECONCILIATION");
      if (existing?.status === "started" && existing.lease_epoch === input.leaseEpoch) throw new Error("STEP_IN_PROGRESS");
      if (existing?.status === "started" && input.boundaryKind === "write") {
        db.prepare("UPDATE agent_step_journal SET status='unknown',completed_at=? WHERE run_id=? AND node_id=? AND logical_attempt=? AND input_hash=? AND status='started'").run(now(), ...key);
        throw new Error("STEP_REQUIRES_RECONCILIATION");
      }
      input.eventStore.commitTransition({
        actor: input.actor, runId: input.runId, expectedStateVersion: input.expectedStateVersion, leaseEpoch: input.leaseEpoch,
        patch: { status: "running" },
        mutate(tx) {
          const claimed = tx.prepare("INSERT INTO agent_step_journal(run_id,node_id,logical_attempt,input_hash,scope_hash,graph_definition_version,lease_epoch,status,started_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,node_id,logical_attempt,input_hash) DO UPDATE SET lease_epoch=excluded.lease_epoch,status='started',started_at=excluded.started_at,error_json=NULL WHERE agent_step_journal.status IN ('failed','started') AND agent_step_journal.lease_epoch<>excluded.lease_epoch")
            .run(...key, input.scopeHash, input.graphDefinitionVersion, input.leaseEpoch, "started", now());
          if (claimed.changes !== 1) throw new Error("STEP_IN_PROGRESS");
        },
        eventInputs: [input.startedEvent],
      });
      try {
        const result = await execute();
        input.eventStore.commitTransition({
          actor: input.actor, runId: input.runId, expectedStateVersion: input.expectedStateVersion + 1, leaseEpoch: input.leaseEpoch,
          patch: { status: "running" },
          mutate(tx) {
            input.applyResult?.(tx, result);
            const updated = tx.prepare("UPDATE agent_step_journal SET status='completed',result_json=?,completed_at=? WHERE run_id=? AND node_id=? AND logical_attempt=? AND input_hash=? AND lease_epoch=? AND status='started'")
              .run(JSON.stringify(result), now(), ...key, input.leaseEpoch);
            if (updated.changes !== 1) throw new Error("STALE_RUN_LEASE");
          },
          eventInputs: [input.completedEvent(result)],
        });
        return result;
      } catch (error) {
        const uncertain = Boolean(input.classifyUncertain?.(error) && input.boundaryKind === "write");
        input.eventStore.commitTransition({
          actor: input.actor, runId: input.runId, expectedStateVersion: input.expectedStateVersion + 1, leaseEpoch: input.leaseEpoch,
          patch: { status: "running" },
          mutate(tx) {
            const updated = tx.prepare(`UPDATE agent_step_journal SET status=?,error_json=?,completed_at=? WHERE run_id=? AND node_id=? AND logical_attempt=? AND input_hash=? AND lease_epoch=? AND status='started'`)
              .run(uncertain ? "unknown" : "failed", JSON.stringify({ code: error.code || (uncertain ? "UNKNOWN_COMMIT_STATE" : "STEP_FAILED") }), now(), ...key, input.leaseEpoch);
            if (updated.changes !== 1) throw new Error("STALE_RUN_LEASE");
          },
          eventInputs: [input.failedEvent(error, { uncertain })],
        });
        throw error;
      }
    },
  };
}
```

- [ ] **Step 5: Implement the checkpointer wrapper and canonical promotion**

```js
export const checkpointConfig = ({ threadId, checkpointId }) => ({
  configurable: {
    thread_id: threadId,
    checkpoint_ns: "",
    ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
  },
});

export function createCheckpointCoordinator({ saver, threadStore, graphDefinitionVersion, projectCommittedTransitions, hashState }) {
  return {
    saver,
    canonicalConfigForRun(run) {
      if (!run.canonicalCheckpointId && run.stateVersion !== 0) throw new Error("CANONICAL_CHECKPOINT_MISSING");
      if (!run.canonicalCheckpointId) return checkpointConfig({ threadId: run.threadId });
      return checkpointConfig({ threadId: run.threadId, checkpointId: run.canonicalCheckpointId });
    },
    promoteSnapshot({ run, snapshot, stateHash }) {
      const checkpointId = snapshot?.config?.configurable?.checkpoint_id;
      if (!checkpointId) throw new Error("CHECKPOINT_ID_MISSING");
      return threadStore.promoteCanonicalCheckpoint({ runId: run.runId, expectedStateVersion: run.stateVersion, leaseEpoch: run.leaseEpoch, checkpointId, stateHash });
    },
    async ensureCheckpointCaughtUp({ run, graph }) {
      if (run.graphDefinitionVersion !== graphDefinitionVersion) throw new Error("GRAPH_VERSION_MISMATCH");
      const config = this.canonicalConfigForRun(run);
      if (!run.canonicalCheckpointId && run.stateVersion === 0) return config;
      const snapshot = await graph.getState(config);
      if (snapshot?.values?.stateVersion === run.stateVersion) return config;
      if (!snapshot || snapshot.values.stateVersion > run.stateVersion) throw new Error("CANONICAL_STATE_DIVERGED");
      const delta = await projectCommittedTransitions({ run, fromStateVersion: snapshot.values.stateVersion, toStateVersion: run.stateVersion, baseState: snapshot.values });
      const candidateConfig = await graph.updateState(config, delta, `recovery:${snapshot.values.stateVersion}->${run.stateVersion}`);
      const candidate = await graph.getState(candidateConfig);
      if (candidate?.values?.stateVersion !== run.stateVersion) throw Object.assign(new Error("THREAD_RECOVERING"), { code: "THREAD_RECOVERING", retryable: true });
      this.promoteSnapshot({ run, snapshot: candidate, stateHash: hashState(candidate.values) });
      return checkpointConfig({ threadId: run.threadId, checkpointId: candidate.config.configurable.checkpoint_id });
    },
  };
}
```

Task 6 already performed Saver setup offline. Production injects the ready Saver here; this factory never invokes `setup()`. At run start, a new thread writes and promotes an initial state-version-0 checkpoint before any external boundary. A new run on an existing thread inherits the previous exact canonical checkpoint ID. A replayed node obtains the completed journal result, `projectCommittedTransitions()` applies only committed state/model-turn/evidence refs, LangGraph writes a candidate, and only a successful application CAS promotes it. The recovery worker is Task 14, not the graph task.

Wrap the ready Saver with `createCandidateTrackingCheckpointer({ saver, executionContext, onCandidate })`. It delegates the documented Saver methods unchanged. Its `put()` awaits the underlying `put()`, obtains the exact returned `checkpoint_id`, reads run/state/lease identity from `AsyncLocalStorage`, hashes the checkpoint channel values and calls `onCandidate` with that exact candidate. `onCandidate` performs the application CAS promotion; a failed CAS records the ID as orphan and never changes the config used by the running worker. This is the only mechanism used to discover candidate IDs—no call asks the Saver for “latest.” Tests inject two workers and prove the stale worker's later Saver `put()` cannot promote.

- [ ] **Step 6: Run focused tests**

```bash
npm test -- src/test/server/agentRuntime/stepJournal.test.ts src/test/server/agentRuntime/checkpoint.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/agentRuntime/stepJournal.mjs server/agentRuntime/checkpoint.mjs src/test/server/agentRuntime/stepJournal.test.ts src/test/server/agentRuntime/checkpoint.test.ts
git commit -m "feat: fence agent steps and checkpoints"
```

### Task 10: Store bounded, content-addressed artifacts

**Files:**
- Create: `server/agentRuntime/artifactStore.mjs`
- Create: `server/agentRuntime/artifactExtractionWorker.mjs`
- Create: `src/test/server/agentRuntime/artifactStore.test.ts`
- Create: `src/test/server/agentRuntime/artifactExtractionWorker.test.ts`
- Create: `src/test/server/agentRuntime/artifactFixture.ts`

- [ ] **Step 1: Write failing artifact ACL and quota tests**

```ts
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { setupArtifactFixture } from "./artifactFixture";

it("stores an allowed PDF by server-generated content path", async () => {
  const { store, actor, threadId } = await setupArtifactFixture();
  const bytes = Buffer.from("%PDF-1.4\nfixture");
  const artifact = await store.put({ actor, threadId, fileName: "requirement.pdf", declaredMime: "application/pdf", bytes });
  expect(artifact).not.toHaveProperty("storagePath");
  expect(artifact.contentHash).toHaveLength(64);
  expect(store.get({ actor, artifactId: artifact.artifactId }).bytes.equals(bytes)).toBe(true);
});

it("denies cross-actor reads, spoofed MIME, and quota overflow", async () => {
  const { store, actor, otherActor, threadId } = await setupArtifactFixture({ perArtifactBytes: 16, perRunBytes: 20, perActorBytes: 32 });
  const artifact = await store.put({ actor, threadId, fileName: "a.txt", declaredMime: "text/plain", bytes: Buffer.from("text") });
  expect(() => store.get({ actor: otherActor, artifactId: artifact.artifactId })).toThrow(/ARTIFACT_NOT_FOUND/);
  await expect(store.put({ actor, threadId, fileName: "fake.png", declaredMime: "image/png", bytes: Buffer.from("not png") })).rejects.toThrow(/MIME_MISMATCH/);
  await expect(store.put({ actor, threadId, fileName: "large.txt", declaredMime: "text/plain", bytes: Buffer.alloc(17, 65) })).rejects.toThrow(/ARTIFACT_TOO_LARGE/);
});
```

`artifactFixture.ts` is created beside the test: it uses `createRuntimeDbFixture()`, creates two actor-owned threads and one queued run, creates a temporary artifact root, constructs the real store and returns cleanup. Add tests that `attachToRun()` rejects the sixth artifact and aggregate byte 21; actor byte 33 is rejected in the small fixture; the same actor/hash can bind to two threads through distinct join rows; another actor receives a distinct authorized ref over a shared blob; expired/removed refs free quota after cleanup. Legacy data-URL import decodes once, deduplicates `(actor,contentHash)`, returns only refs, and leaves no base64 in messages/model turns/checkpoints.

- [ ] **Step 2: Run the tests and verify RED**

```bash
npm test -- src/test/server/agentRuntime/artifactStore.test.ts
```

Expected: FAIL because the artifact store is missing.

- [ ] **Step 3: Implement MIME sniffing, generated paths, ACL and quotas**

Use exact magic signatures for PDF (`%PDF-`), PNG, JPEG, and WebP. Text uses `new TextDecoder("utf-8", { fatal: true }).decode(bytes)` and rejects NUL/control-binary content; JSON additionally must parse. Normalize a display name with `path.basename()` but never use it as a storage path. Store bytes at `<artifactRoot>/<sha256>` using `wx` creation, record the physical blob in `agent_artifact_blobs`, the actor ref in `agent_artifacts`, and thread/run bindings in the join tables.

```js
const MIME_LIMIT = 8 * 1024 * 1024;
const RUN_LIMIT = 20 * 1024 * 1024;
const ACTOR_LIMIT = 200 * 1024 * 1024;
const ALLOWED = new Set(["text/plain", "text/markdown", "application/json", "application/pdf", "image/png", "image/jpeg", "image/webp"]);
const sniff = (bytes) => {
  if (bytes.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.includes("\0")) return "text/plain";
  } catch {}
  return "application/octet-stream";
};
```

For JSON and Markdown, permit the text sniff result only when the declared MIME is one of the three text types. `put()` returns `{ artifactId, fileName, mimeType, sizeBytes, contentHash, expiresAt }` only. `get()` queries actor ref plus current scope/thread binding before an internal blob lookup; expired artifacts are indistinguishable from missing artifacts. `attachToRun({ actor, runId, artifactIds })` runs in one transaction, requires at most 5 refs, sums at most 20 MiB and inserts the run/thread bindings only after current-scope authorization. Actor quota sums distinct, unexpired actor refs and is capped at 200 MiB.

- [ ] **Step 4: Reuse current extraction runners through refs**

`extractText({ actor, artifactId, signal })` reads authorized bytes and starts `artifactExtractionWorker.mjs` with Node `Worker`, a 30-second parent timeout and restrictive `resourceLimits`. The worker clears inherited secrets, replaces network APIs with throwing stubs, never follows PDF/image links or executes embedded content, calls injected/allowlisted PDF or OCR parser code, rejects PDF page count above 100, and returns text plus parser metadata. The parent terminates on timeout/cancel, caps text at 200,000 characters, stores extracted text as a second content-addressed blob/ref, and persists only `{ textRef, truncated, pageCount, parserVersion }`. Graph state receives `textRef`, never text/base64. Tests cover timeout termination, 101-page rejection, invalid UTF-8, JSON parse failure, network-attempt denial, 200,001-character truncation and cancellation.

- [ ] **Step 5: Run tests**

```bash
npm test -- src/test/server/agentRuntime/artifactStore.test.ts src/test/server/agentRuntime/artifactExtractionWorker.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/agentRuntime/artifactStore.mjs server/agentRuntime/artifactExtractionWorker.mjs src/test/server/agentRuntime/artifactStore.test.ts src/test/server/agentRuntime/artifactExtractionWorker.test.ts src/test/server/agentRuntime/artifactFixture.ts
git commit -m "feat: add scoped agent artifact storage"
```

### Task 11: Compile hard policy and typed adapters over the existing tools

**Files:**
- Create: `server/agentRuntime/policy.mjs`
- Create: `server/agentRuntime/toolRegistry.mjs`
- Create: `src/test/server/agentRuntime/policy.test.ts`
- Create: `src/test/server/agentRuntime/toolRegistry.test.ts`
- Modify: `server/mainAgentToolLoop.mjs`
- Test: `src/test/server/mainAgentToolLoop.test.ts`
- Test: `src/test/server/mainAgentTools.test.ts`

- [ ] **Step 1: Write the failing flag-matrix and mode-policy tests**

```ts
import { describe, expect, it } from "vitest";
import { createRuntimePolicy } from "../../../../server/agentRuntime/policy.mjs";

const actor = { actorId: "alice", scopeHash: "scope-a", scopes: { workspaceIds: ["DTSV_China"], projectIds: ["SP25"], teamIds: ["DTSV"] } };
const request = { useAnalyticsContext: false, useDefectContext: false };

describe("LegacyPlanValidator policy", () => {
  const policy = createRuntimePolicy({ maxExternalSteps: 6, maxCallsPerStep: 3 });

  it.each([
    [request, "langgraph", "query_dashboard_summary", "ANALYTICS_CONTEXT_DISABLED"],
    [{ ...request, useAnalyticsContext: true }, "langgraph", "search_duplicates", "DEFECT_CONTEXT_DISABLED"],
    [{ useAnalyticsContext: true, useDefectContext: true }, "shadow", "search_duplicates", "SHADOW_DUPLICATE_SEARCH_FORBIDDEN"],
  ])("denies flags=%o mode=%s tool=%s", (flags, runtimeMode, toolName, code) => {
    expect(() => policy.authorizeTool({ actor, request: flags, runtimeMode, toolName, externalStepIndex: 0, callsInStep: 1 })).toThrow(code);
  });

  it("allows each tool only when its explicit request flag permits it", () => {
    expect(policy.authorizeTool({ actor, request: { useAnalyticsContext: true, useDefectContext: false }, runtimeMode: "langgraph", toolName: "query_dashboard_summary", externalStepIndex: 0, callsInStep: 1 })).toMatchObject({ riskLevel: "R0" });
    expect(policy.authorizeTool({ actor, request: { useAnalyticsContext: false, useDefectContext: true }, runtimeMode: "langgraph", toolName: "search_duplicates", externalStepIndex: 0, callsInStep: 1 })).toMatchObject({ riskLevel: "R0" });
  });

  it("rejects unregistered capabilities and budget overflow", () => {
    expect(() => policy.authorizeTool({ actor, request: { useAnalyticsContext: true, useDefectContext: true }, runtimeMode: "langgraph", toolName: "run_sql", externalStepIndex: 0, callsInStep: 1 })).toThrow(/TOOL_NOT_REGISTERED/);
    expect(() => policy.authorizeTool({ actor, request: { useAnalyticsContext: true, useDefectContext: true }, runtimeMode: "langgraph", toolName: "ask_clarification", externalStepIndex: 0, callsInStep: 1 })).toThrow(/TOOL_NOT_REGISTERED/);
    expect(() => policy.authorizeTool({ actor, request: { useAnalyticsContext: true, useDefectContext: true }, runtimeMode: "langgraph", toolName: "query_dashboard_summary", externalStepIndex: 6, callsInStep: 1 })).toThrow(/RUN_STEP_BUDGET_EXCEEDED/);
  });
});
```

This matrix deliberately proves that the two flags are independent: an analytics question does not need defect permission, a Duplicate Search question does not need analytics permission, and neither may be enabled by `pageContext`.

- [ ] **Step 2: Write failing typed-registry tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { createRuntimePolicy } from "../../../../server/agentRuntime/policy.mjs";
import { createToolRegistry } from "../../../../server/agentRuntime/toolRegistry.mjs";

const actor = { actorId: "alice", scopeHash: "scope-a", scopes: { workspaceIds: ["DTSV_China"], projectIds: ["SP25"], teamIds: ["DTSV"] } };
const baseContext = {
  runId: "run-1", threadId: "thread-1", actor, leaseEpoch: 1,
  signal: new AbortController().signal,
  isCancellationRequested: async () => false,
  refreshActor: async () => actor,
  assertCurrentLease: async () => undefined,
};

const makeRegistry = (executeLegacyTool = vi.fn().mockResolvedValue({
  toolMessage: { role: "tool", tool_call_id: "call-1", name: "query_dashboard_summary", content: "{\"overview\":{\"ticket_count\":12}}" },
  contextText: "Result: 12 defects",
})) => createToolRegistry({
  policy: createRuntimePolicy({ maxExternalSteps: 6, maxCallsPerStep: 3 }),
  executeLegacyTool,
  analyticsFetch: vi.fn(),
  analyticsApiBase: "http://127.0.0.1:3003",
  runDuplicateBridge: vi.fn(),
  ensureDuplicateWarmup: vi.fn(),
});

describe("typed main Agent tools", () => {
  it("publishes only the five read-only graph tools", () => {
    expect(makeRegistry().listForPlanner({ request: { useAnalyticsContext: true, useDefectContext: true }, runtimeMode: "langgraph" }).map((tool) => tool.name)).toEqual([
      "query_dashboard_summary",
      "query_testing_coverage_project_status",
      "query_defect_high_frequency_analysis",
      "query_full_picture_module",
      "search_duplicates",
    ]);
  });

  it("rejects unknown arguments before the existing executor sees them", async () => {
    const executeLegacyTool = vi.fn();
    const registry = makeRegistry(executeLegacyTool);
    await expect(registry.execute({
      call: { toolCallId: "call-1", name: "query_dashboard_summary", argumentsText: "{\"filters\":{},\"sql\":\"select 1\"}" },
      request: { useAnalyticsContext: true, useDefectContext: false }, runtimeMode: "langgraph", externalStepIndex: 0, callsInStep: 1,
      context: baseContext,
    })).rejects.toMatchObject({ code: "TOOL_ARGUMENTS_INVALID", retryable: false });
    expect(executeLegacyTool).not.toHaveBeenCalled();
  });

  it("passes the Duplicate bridge exactly its approved payload", async () => {
    const runDuplicateBridge = vi.fn().mockResolvedValue({ success: true, result: { candidates: [] } });
    const registry = createToolRegistry({
      policy: createRuntimePolicy({ maxExternalSteps: 6, maxCallsPerStep: 3 }),
      analyticsFetch: vi.fn(), analyticsApiBase: "http://127.0.0.1:3003",
      runDuplicateBridge, ensureDuplicateWarmup: vi.fn().mockResolvedValue(undefined),
    });
    await registry.execute({
      call: { toolCallId: "call-dup", name: "search_duplicates", argumentsText: "{\"query\":\"camera black screen\",\"top_k\":3}" },
      request: { useAnalyticsContext: false, useDefectContext: true }, runtimeMode: "langgraph", externalStepIndex: 0, callsInStep: 1,
      context: baseContext,
    });
    expect(runDuplicateBridge).toHaveBeenCalledTimes(1);
    expect(runDuplicateBridge).toHaveBeenCalledWith({ action: "search", query: "camera black screen", top_k: 3 });
  });
});
```

Add one timeout test for an analytics promise that never settles and one cancellation test in which the Duplicate bridge resolves after `signal.abort()`: both return typed `timeout`/`cancelled` errors, and `assertCurrentLease()` prevents the late result from being committed. Do not add `AbortSignal` or other behavior to `duplicateBridgeRuntime.cjs` in Phase 1.

- [ ] **Step 3: Run both files and verify RED**

```bash
npm test -- src/test/server/agentRuntime/policy.test.ts src/test/server/agentRuntime/toolRegistry.test.ts
```

Expected: FAIL because `policy.mjs` and `toolRegistry.mjs` do not exist.

- [ ] **Step 4: Implement the hard policy**

```js
const ANALYTICS_TOOLS = new Set([
  "query_dashboard_summary",
  "query_testing_coverage_project_status",
  "query_defect_high_frequency_analysis",
  "query_full_picture_module",
]);
const DEFECT_TOOLS = new Set(["search_duplicates"]);
const REGISTERED = new Set([...ANALYTICS_TOOLS, ...DEFECT_TOOLS]);
const deny = (code) => { throw Object.assign(new Error(code), { code, retryable: false }); };

export function createRuntimePolicy({ maxExternalSteps = 6, maxCallsPerStep = 3 } = {}) {
  return Object.freeze({
    authorizeTool({ actor, request, runtimeMode, toolName, externalStepIndex, callsInStep }) {
      if (!actor?.actorId || !actor?.scopeHash) deny("ACTOR_SCOPE_REQUIRED");
      if (!REGISTERED.has(toolName)) deny("TOOL_NOT_REGISTERED");
      if (externalStepIndex >= maxExternalSteps) deny("RUN_STEP_BUDGET_EXCEEDED");
      if (callsInStep < 1 || callsInStep > maxCallsPerStep) deny("STEP_TOOL_CALL_LIMIT_EXCEEDED");
      if (ANALYTICS_TOOLS.has(toolName) && request.useAnalyticsContext !== true) deny("ANALYTICS_CONTEXT_DISABLED");
      if (DEFECT_TOOLS.has(toolName) && request.useDefectContext !== true) deny("DEFECT_CONTEXT_DISABLED");
      if (runtimeMode === "shadow" && DEFECT_TOOLS.has(toolName)) deny("SHADOW_DUPLICATE_SEARCH_FORBIDDEN");
      if (!["legacy", "shadow", "langgraph"].includes(runtimeMode)) deny("RUNTIME_MODE_INVALID");
      return { riskLevel: "R0", actorScopeHash: actor.scopeHash, readOnly: true };
    },
  });
}

export { ANALYTICS_TOOLS, DEFECT_TOOLS };
```

- [ ] **Step 5: Implement the typed registry without changing tool business code**

Build one registry record from every `MAIN_AGENT_TOOLS` entry except `ask_clarification`. Convert its compatible schema object to JSON Schema 2020-12 and compile it through Task 2's `contracts.compileToolSchema()`; no second Ajv instance is created and unknown properties are rejected rather than removed. Expose this exact public shape:

```js
{
  listForPlanner({ request, runtimeMode }),
  get(name),
  execute({ call, request, runtimeMode, externalStepIndex, callsInStep, context }),
}
```

The execution adapter must use these exact boundaries:

```js
const parsedArgs = JSON.parse(call.argumentsText || "{}");
if (!record.validate(parsedArgs)) {
  throw Object.assign(new Error(`TOOL_ARGUMENTS_INVALID:${ajv.errorsText(record.validate.errors)}`), { code: "TOOL_ARGUMENTS_INVALID", retryable: false });
}
const refreshedActor = await context.refreshActor();
policy.authorizeTool({ actor: refreshedActor, request, runtimeMode, toolName: call.name, externalStepIndex, callsInStep });
if (await context.isCancellationRequested() || context.signal.aborted) {
  throw Object.assign(new Error("TOOL_CANCELLED"), { code: "TOOL_CANCELLED", retryable: false, status: "cancelled" });
}

const timeoutController = new AbortController();
const timeoutId = setTimeout(() => timeoutController.abort("timeout"), record.timeoutMs);
const signal = AbortSignal.any([context.signal, timeoutController.signal]);
const analyticsFetchWithSignal = (url, init = {}) => analyticsFetch(url, { ...init, signal });
try {
  const result = await executeLegacyTool({
    id: call.toolCallId,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(parsedArgs) },
  }, {
    analyticsFetch: analyticsFetchWithSignal,
    analyticsApiBase,
    runDuplicateBridge,
    ensureDuplicateWarmup,
  });
  await context.assertCurrentLease();
  if (signal.aborted) {
    const timeout = timeoutController.signal.aborted && !context.signal.aborted;
    throw Object.assign(new Error(timeout ? "TOOL_TIMEOUT" : "TOOL_CANCELLED"), { code: timeout ? "TOOL_TIMEOUT" : "TOOL_CANCELLED", retryable: timeout, status: timeout ? "timeout" : "cancelled" });
  }
  return {
    status: "succeeded",
    toolName: call.name,
    toolVersion: "legacy-tool-v1",
    canonicalArgs: parsedArgs,
    rawResult: result,
  };
} finally {
  clearTimeout(timeoutId);
}
```

Every record contains `{ name, version:"legacy-tool-v1", riskLevel:"R0", inputSchema, outputSchema, timeoutMs, maxOutputBytes:262144, idempotent:true, retryPolicy:{ maxAttempts:2, backoffMs:250 } }`. The common `RawToolResult` is `{ status:"succeeded"|"partial", toolName, toolVersion, canonicalArgs, payloadRef?, preview, contentHash, truncated, sourceRevision? }`; validate it before journaling. If canonical output exceeds 256 KiB, write the full result through the scoped artifact store, keep a bounded redacted preview and set `status="partial", truncated=true`. Set analytics timeout to 12 seconds and Duplicate Search timeout to the smaller of 120 seconds and the run's remaining active budget. Retry only idempotent analytics network/429/5xx failures; never retry validation, denial or cancellation. Never expose credentials, raw scope fields, or unredacted attachment text in `listForPlanner()` or `tool.started`.

Add an optional `tools` argument to `resolveMainAgentToolContext()`, defaulting to the existing `MAIN_AGENT_TOOLS` for direct legacy tests. The `/api/ai/chat` handler always supplies a policy-filtered list: analytics tools only when `useAnalyticsContext===true`, `search_duplicates` only when `useDefectContext===true`, and legacy `ask_clarification` only in the old loop. Add a regression where `useAnalyticsContext=true/useDefectContext=false` and a fake planner requests `search_duplicates`; execution count must be zero and the call is rejected before the bridge. The existing direct defect-context path still runs only when `useDefectContext===true`.

- [ ] **Step 6: Run policy, adapter, and Duplicate boundary regressions**

```bash
npm test -- \
  src/test/server/agentRuntime/policy.test.ts \
  src/test/server/agentRuntime/toolRegistry.test.ts \
  src/test/server/mainAgentTools.test.ts \
  src/test/server/mainAgentToolLoop.test.ts
```

Expected: PASS, including the unchanged exact Duplicate bridge payload test.

- [ ] **Step 7: Commit**

```bash
git add server/agentRuntime/policy.mjs server/agentRuntime/toolRegistry.mjs server/mainAgentToolLoop.mjs src/test/server/agentRuntime/policy.test.ts src/test/server/agentRuntime/toolRegistry.test.ts src/test/server/mainAgentToolLoop.test.ts
git commit -m "feat: enforce typed main agent tool policy"
```

### Task 12: Normalize legacy evidence and gate every factual claim

**Files:**
- Create: `server/agentRuntime/evidence.mjs`
- Create: `src/test/server/agentRuntime/evidence.test.ts`

- [ ] **Step 1: Write failing normalization and claim-validation tests**

```ts
import { describe, expect, it } from "vitest";
import {
  createLegacyEvidence,
  validateLegacyClaims,
  validateRenderedAnswer,
  renderDeterministicFallback,
} from "../../../../server/agentRuntime/evidence.mjs";

const actor = { actorId: "alice", scopeHash: "scope-a" };
const analyticsEvidence = createLegacyEvidence({
  evidenceId: "ev-analytics", actor, attemptId: "attempt-1", toolName: "query_dashboard_summary",
  toolVersion: "legacy-tool-v1", canonicalArgs: { filters: { years: 2026 } },
  rawResult: { toolMessage: { content: "{\"overview\":{\"ticket_count\":12},\"snapshot_version\":\"snapshot-1\"}" }, contextText: "Result: 12 defects" },
  retrievedAt: "2026-07-14T00:00:00.000Z",
});
const duplicateEvidence = createLegacyEvidence({
  evidenceId: "ev-duplicate", actor, attemptId: "attempt-2", toolName: "search_duplicates",
  toolVersion: "legacy-tool-v1", canonicalArgs: { query: "camera black screen", top_k: 3 },
  rawResult: { toolMessage: { content: "{\"result\":{\"candidates\":[{\"ticketId\":\"2687001\",\"score1to10\":9}]}}" }, contextText: "Candidate count: 1" },
  retrievedAt: "2026-07-14T00:00:01.000Z",
});

describe("legacy-v0 evidence", () => {
  it("never upgrades provisional results to grounded", () => {
    expect(analyticsEvidence).toMatchObject({
      schemaVersion: "1.0", ontologyVersion: "legacy-provisional", schemaFingerprint: "legacy-unknown",
      evidenceType: "metric", sourceRevision: { sourceId: "analytics:legacy", status: "unknown" },
      quality: { groundingStatus: "legacy_equivalence" }, authorization: { actorScopeHash: "scope-a" },
    });
    expect(analyticsEvidence.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(duplicateEvidence.evidenceType).toBe("similarity");
    expect(duplicateEvidence.source.system).toBe("duplicate-search");
  });

  it("accepts supported numbers and rejects unsupported numbers or similarity-as-statistic", () => {
    const claims = [
      { claimId: "c1", type: "observed", text: "2026 年共有 12 个缺陷。", fact: { subjectRef: "DTSV", predicateId: "defect.count", value: 12, unit: "defects", scopeEvidenceId: "ev-analytics" }, evidenceIds: ["ev-analytics"], confidence: 1, caveats: [] },
      { claimId: "c2", type: "observed", text: "2026 年共有 13 个缺陷。", fact: { subjectRef: "DTSV", predicateId: "defect.count", value: 13, unit: "defects", scopeEvidenceId: "ev-analytics" }, evidenceIds: ["ev-analytics"], confidence: 1, caveats: [] },
      { claimId: "c3", type: "observed", text: "系统共有 1 个缺陷。", fact: { subjectRef: "DTSV", predicateId: "defect.count", value: 1, unit: "defects", scopeEvidenceId: "ev-duplicate" }, evidenceIds: ["ev-duplicate"], confidence: 1, caveats: [] },
    ];
    const validation = validateLegacyClaims({ claims, evidence: [analyticsEvidence, duplicateEvidence] });
    expect(validation.acceptedClaimIds).toEqual(["c1"]);
    expect(validation.rejected.map((item) => item.claimId)).toEqual(["c2", "c3"]);
    expect(validation.status).toBe("repair");
  });

  it("blocks a rendered answer that introduces a new ID", () => {
    const validation = validateRenderedAnswer({ text: "2026 年共有 12 个缺陷，示例 ID 为 9999999。", acceptedClaims: [{ claimId: "c1", text: "2026 年共有 12 个缺陷。", evidenceIds: ["ev-analytics"] }], evidence: [analyticsEvidence] });
    expect(validation).toMatchObject({ valid: false, unsupportedTokens: ["9999999"] });
    expect(renderDeterministicFallback({ acceptedClaims: [{ claimId: "c1", text: "2026 年共有 12 个缺陷。", evidenceIds: ["ev-analytics"] }], limitations: ["数据来源为 Phase 1 legacy equivalence。"] })).toContain("2026 年共有 12 个缺陷");
  });
});
```

Also assert that zero, missing, and unknown produce distinct `quality.missingness` values; truncated tool output remains `completeness="partial"`; raw payload, canonical arguments, and tool version all change `contentHash`; a claim referencing evidence from another actor scope is rejected.

- [ ] **Step 2: Run the tests and verify RED**

```bash
npm test -- src/test/server/agentRuntime/evidence.test.ts
```

Expected: FAIL because `evidence.mjs` does not exist.

- [ ] **Step 3: Implement deterministic `legacy-v0` envelopes**

Use sorted-key JSON before every hash. Parse `toolMessage.content` only as untrusted JSON; retain both the parsed payload and `contextText` in the content hash. Phase 1 source revisions are always `unknown`, even if a legacy payload contains a display-only snapshot label, because the existing APIs do not yet prove a pinned transaction watermark.

```js
import { createHash } from "node:crypto";
const stable = (value) => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  : Array.isArray(value) ? value.map(stable) : value;
const hash = (value) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const parseContent = (rawResult) => {
  try { return JSON.parse(String(rawResult?.toolMessage?.content || "null")); }
  catch { return { unparsed: String(rawResult?.toolMessage?.content || "") }; }
};

export function createLegacyEvidence(input) {
  const payload = parseContent(input.rawResult);
  const duplicate = input.toolName === "search_duplicates";
  const preview = { payload, contextText: String(input.rawResult?.contextText || "").slice(0, 20000) };
  const truncated = String(input.rawResult?.contextText || "").length > 20000;
  return {
    schemaVersion: "1.0",
    evidenceId: input.evidenceId,
    ontologyVersion: "legacy-provisional",
    schemaFingerprint: "legacy-unknown",
    evidenceType: duplicate ? "similarity" : (Array.isArray(payload) ? "records" : "metric"),
    source: {
      system: duplicate ? "duplicate-search" : "analytics",
      toolName: input.toolName,
      toolVersion: input.toolVersion,
      attemptId: input.attemptId,
      queryFingerprint: hash(input.canonicalArgs),
      canonicalArgsHash: hash(input.canonicalArgs),
    },
    sourceRevision: { sourceId: duplicate ? "duplicate-search:legacy" : "analytics:legacy", status: "unknown" },
    scope: { objectType: duplicate ? "defect.similarity_candidate" : "legacy.analytics_result", timeScopes: [] },
    contentHash: hash({ payload, contextText: input.rawResult?.contextText, canonicalArgs: input.canonicalArgs, toolVersion: input.toolVersion }),
    preview,
    quality: {
      groundingStatus: "legacy_equivalence",
      completeness: truncated ? "partial" : "unknown",
      truncation: { truncated },
      missingness: payload == null ? "missing" : "unknown",
      warnings: ["Phase 1 legacy-v0 evidence; source revision is not pinned."],
    },
    authorization: { actorScopeHash: input.actor.scopeHash, redactionStatus: "not_required" },
    retrievedAt: input.retrievedAt,
  };
}
```

When a legacy adapter can prove an explicit zero field, set `missingness="zero"`; an absent field is `missing`; an unavailable/ambiguous source is `unknown`. Never infer zero from an empty preview without a metric contract.

- [ ] **Step 4: Implement claim and rendered-answer gates**

Extract deterministic tokens with this exact order so dates and IDs are not split into smaller numbers:

```js
const TOKEN_RE = /\b\d{4}-\d{2}-\d{2}\b|\b[A-Za-z][A-Za-z0-9_-]*-\d+\b|\b\d+(?:\.\d+)?%?\b/g;
const tokens = (text) => [...String(text || "").matchAll(TOKEN_RE)].map((match) => match[0]);
```

`validateLegacyClaims()` must:

1. Resolve every `evidenceId` and require `authorization.actorScopeHash` to equal the current run scope.
2. Require `observed` and `derived` claims to include `fact`, `scopeEvidenceId`, and at least one evidence ID.
3. Require every token from `claim.text` and `fact.value` to appear in the canonical preview of the referenced evidence.
4. Reject a statistical/count predicate backed only by `evidenceType="similarity"`.
5. Reject causal/completeness language (`导致`, `证明`, `全部`, `complete`, `caused by`) unless a versioned deterministic derivation rule and all input evidence are present; otherwise force it to an explicit hypothesis/limitation.
6. Reject cross-source ratios/comparisons whenever either Phase 1 revision is `unknown`, and invalidate/re-execute the dependent subgraph if a source revision changes during the run.
7. Return and persist `{ validationId, status, acceptedClaimIds, rejected, warnings }`; status is `valid` when none are rejected, `repair` when at least one safe claim remains, and `rejected` when none remain.

`validateRenderedAnswer()` repeats token support over accepted claims plus their evidence and rejects any unaccepted claim text. Permit exactly one constrained model repair. On a second failure, call `renderDeterministicFallback()` to join accepted claim text, citations, assumptions, and limitations without asking a model. `createAnswerEnvelope()` hashes the final text and always sets `groundingStatus="legacy_equivalence"` or `insufficient_evidence`; Phase 1 has no path that returns `grounded`.

- [ ] **Step 5: Run the evidence tests**

```bash
npm test -- src/test/server/agentRuntime/evidence.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/agentRuntime/evidence.mjs src/test/server/agentRuntime/evidence.test.ts
git commit -m "feat: validate legacy evidence and claims"
```

### Task 13: Assemble the explicit Phase 1 LangGraph

**Files:**
- Create: `server/agentRuntime/legacyAdapter.mjs`
- Create: `server/agentRuntime/graph.mjs`
- Create: `src/test/server/agentRuntime/legacyAdapter.test.ts`
- Create: `src/test/server/agentRuntime/graph.test.ts`
- Create: `src/test/server/agentRuntime/graphResume.test.ts`

- [ ] **Step 1: Lock the provisional semantics and plan compiler with failing tests**

```ts
import { describe, expect, it } from "vitest";
import { createLegacySemanticAdapter, validateLegacyPlan } from "../../../../server/agentRuntime/legacyAdapter.mjs";

describe("Phase 1 semantic compatibility", () => {
  it("marks all frames provisional and anchors relative dates in Asia/Shanghai", () => {
    const adapter = createLegacySemanticAdapter({ timezone: "Asia/Shanghai" });
    const frame = adapter.resolve({
      query: "最近一周 DTSV 新建缺陷有多少？",
      requestAnchorAt: "2026-07-14T02:00:00.000Z",
      pageContext: { moduleKey: "dashboard", moduleLabel: "Dashboard" },
    });
    expect(frame.ref).toMatchObject({ ontologyVersion: "legacy-provisional", schemaFingerprint: "legacy-unknown", requestAnchorAt: "2026-07-14T02:00:00.000Z" });
    expect(frame.timeScopes[0]).toMatchObject({ fieldId: "legacy.creation_time", start: "2026-07-08", end: "2026-07-14", timezone: "Asia/Shanghai" });
  });

  it("cannot compile around either request flag", () => {
    const candidate = { steps: [{ stepId: "s1", toolName: "search_duplicates", canonicalArgs: { query: "camera", top_k: 3 }, dependsOn: [] }] };
    expect(validateLegacyPlan({ candidate, actor: { scopeHash: "scope-a" }, request: { useAnalyticsContext: true, useDefectContext: false }, runtimeMode: "langgraph" })).toMatchObject({ status: "denied", violations: ["DEFECT_CONTEXT_DISABLED"] });
  });
});
```

`LegacySemanticAdapter` recognizes only the intent/filter vocabulary already supported by the current tool loop. Any unsupported business object, ambiguous time field, or test-case-generation intent yields a clarification or `LEGACY_EQUIVALENCE_NOT_ALLOWLISTED`; it does not call the Python Ontology prototype.

- [ ] **Step 2: Write failing graph tests around observable behavior**

Use a migrated temporary Runtime DB, deterministic IDs, `SqliteSaver`, a fake model adapter, fake tool registry, and the real evidence gate. The fixture drives these exact paths:

```text
analytics happy path:
receive_request -> prepare_inputs -> compact_context -> resolve_intent -> resolve_semantics
-> create_plan -> validate_and_compile_plan -> execute_tool
-> normalize_evidence -> derive_facts -> draft_claims -> validate_claims
-> render_answer -> validate_rendered_answer -> publish_answer -> persist_terminal_state

clarification path:
resolve_semantics -> request_clarification -> interrupt
-> Command({ resume }) -> consume_clarification -> create_plan

denied/no-evidence path:
validate_and_compile_plan | validate_claims
-> deterministic_limited_answer -> validate_rendered_answer -> publish_answer
```

Assert all of the following in `graph.test.ts` and `graphResume.test.ts`:

- `ontology.resolved.payload.mode` is `legacy_provisional` and every evidence event says `legacy_equivalence`.
- `useAnalyticsContext=false` and `useDefectContext=false` produce zero calls in their respective categories, even when the fake planner requests them.
- `ask_clarification` never appears in `toolRegistry.listForPlanner()`; the graph persists one interaction, emits `clarification.required`, and resumes the same `runId` with LangGraph `Command`.
- the same `(toolName, canonicalArgs)` cannot run twice without a new evidence ID; two consecutive no-new-evidence transitions stop the graph.
- no more than six model/tool steps and no more than three calls per candidate step execute.
- `modelTurns` preserve assistant `toolCalls[].toolCallId` and the matching tool message `toolCallId` through checkpoint/resume.
- context compaction preserves negative constraints, time range, actor scope, pending interaction and semantic/evidence refs while replacing only older source messages with a versioned summary.
- planner nodes reject `chat_only/planner_candidate` models; configured fallback is used only when independently certified and emits `model.fallback`; certification tests disable fallback.
- an unsupported claim triggers one repair; a second invalid render uses the deterministic fallback.
- the event store contains zero `answer.delta` rows until claim and rendered-answer validation have passed and the final `AnswerEnvelope` is stored.
- no Runtime state/checkpoint contains an `AbortController`, function, credential, raw response object, full attachment bytes, or base64 data URL.
- defect comments, requirement text, attachment text and tool payloads containing prompt-like instructions remain quoted data and cannot register tools, change policy or bypass claim validation.

- [ ] **Step 3: Run the tests and verify RED**

```bash
npm test -- \
  src/test/server/agentRuntime/legacyAdapter.test.ts \
  src/test/server/agentRuntime/graph.test.ts \
  src/test/server/agentRuntime/graphResume.test.ts
```

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Define reducers explicitly**

```js
import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";

const mergeBy = (key) => (left = [], right = []) => {
  const map = new Map(left.map((item) => [item[key], item]));
  for (const item of right) map.set(item[key], { ...map.get(item[key]), ...item });
  return [...map.values()];
};
const replace = (_left, right) => right;

export const AgentState = Annotation.Root({
  schemaVersion: Annotation({ reducer: replace, default: () => "1.0" }),
  graphDefinitionVersion: Annotation({ reducer: replace }),
  runId: Annotation({ reducer: replace }),
  threadId: Annotation({ reducer: replace }),
  threadVersion: Annotation({ reducer: replace, default: () => 0 }),
  stateVersion: Annotation({ reducer: replace, default: () => 0 }),
  leaseEpoch: Annotation({ reducer: replace, default: () => 0 }),
  runStatus: Annotation({ reducer: replace, default: () => "queued" }),
  actor: Annotation({ reducer: replace }),
  request: Annotation({ reducer: replace }),
  branch: Annotation({ reducer: replace }),
  messages: Annotation({ reducer: mergeBy("messageId"), default: () => [] }),
  summaries: Annotation({ reducer: mergeBy("summaryId"), default: () => [] }),
  modelTurns: Annotation({ reducer: mergeBy("turnId"), default: () => [] }),
  intent: Annotation({ reducer: replace }),
  semanticFrame: Annotation({ reducer: replace }),
  sourceRevisionSet: Annotation({ reducer: replace, default: () => ({}) }),
  plan: Annotation({ reducer: replace }),
  nextStepIndex: Annotation({ reducer: replace, default: () => 0 }),
  toolAttempts: Annotation({ reducer: mergeBy("attemptId"), default: () => [] }),
  evidence: Annotation({ reducer: mergeBy("evidenceId"), default: () => [] }),
  claims: Annotation({ reducer: mergeBy("claimId"), default: () => [] }),
  claimValidation: Annotation({ reducer: replace }),
  pendingInteraction: Annotation({ reducer: replace }),
  activeExecutionBudgetMs: Annotation({ reducer: replace }),
  activeExecutionConsumedMs: Annotation({ reducer: replace, default: () => 0 }),
  activeSegmentStartedAt: Annotation({ reducer: replace }),
  runHardExpiresAt: Annotation({ reducer: replace }),
  answerDraft: Annotation({ reducer: replace }),
  answer: Annotation({ reducer: replace }),
  cancelRequestedAt: Annotation({ reducer: replace }),
  warnings: Annotation({ reducer: (left = [], right = []) => [...new Set([...left, ...right])], default: () => [] }),
  errors: Annotation({ reducer: mergeBy("code"), default: () => [] }),
  modelTrace: Annotation({ reducer: mergeBy("invocationId"), default: () => [] }),
  threadCreatedAt: Annotation({ reducer: replace }),
  runCreatedAt: Annotation({ reducer: replace }),
  updatedAt: Annotation({ reducer: replace }),
  repairCount: Annotation({ reducer: replace, default: () => 0 }),
  consecutiveNoEvidence: Annotation({ reducer: replace, default: () => 0 }),
});
```

`begin_new_run` is a deterministic reducer helper invoked by `receive_request`. It replaces every run-scoped field listed above, preserves only ID-deduplicated conversation messages/summaries, refreshes actor scope, and refuses to start unless the previous run is terminal and `threadVersion` matches.

- [ ] **Step 5: Build the graph with named nodes and explicit conditional edges**

Export `createMainAgentGraph(deps)` and compile with `deps.checkpointCoordinator.saver`. Node functions are injected from `createGraphNodes(deps)` so unit tests can substitute deterministic model/tool fixtures. Use exactly these node names; every model/tool node runs through `stepJournal.run()`:

```js
export function createMainAgentGraph(deps) {
  const n = createGraphNodes(deps);
  return new StateGraph(AgentState)
    .addNode("receive_request", n.receiveRequest)
    .addNode("prepare_inputs", n.prepareInputs)
    .addNode("compact_context", n.compactContext)
    .addNode("resolve_intent", n.resolveIntent)
    .addNode("resolve_semantics", n.resolveSemantics)
    .addNode("request_clarification", n.requestClarification)
    .addNode("consume_clarification", n.consumeClarification)
    .addNode("create_plan", n.createPlan)
    .addNode("validate_and_compile_plan", n.validateAndCompilePlan)
    .addNode("execute_tool", n.executeTool)
    .addNode("normalize_evidence", n.normalizeEvidence)
    .addNode("derive_facts", n.deriveFacts)
    .addNode("draft_claims", n.draftClaims)
    .addNode("validate_claims", n.validateClaims)
    .addNode("render_answer", n.renderAnswer)
    .addNode("validate_rendered_answer", n.validateRenderedAnswer)
    .addNode("deterministic_limited_answer", n.deterministicLimitedAnswer)
    .addNode("publish_answer", n.publishAnswer)
    .addNode("persist_terminal_state", n.persistTerminalState)
    .addEdge(START, "receive_request")
    .addEdge("receive_request", "prepare_inputs")
    .addEdge("prepare_inputs", "compact_context")
    .addEdge("compact_context", "resolve_intent")
    .addEdge("resolve_intent", "resolve_semantics")
    .addConditionalEdges("resolve_semantics", n.routeAfterSemantics, {
      clarify: "request_clarification", plan: "create_plan", limited: "deterministic_limited_answer",
    })
    .addEdge("request_clarification", "consume_clarification")
    .addEdge("consume_clarification", "create_plan")
    .addEdge("create_plan", "validate_and_compile_plan")
    .addConditionalEdges("validate_and_compile_plan", n.routeAfterPlanValidation, {
      clarify: "request_clarification", execute: "execute_tool", derive: "derive_facts", limited: "deterministic_limited_answer",
    })
    .addEdge("execute_tool", "normalize_evidence")
    .addConditionalEdges("normalize_evidence", n.routeAfterEvidence, {
      execute: "execute_tool", derive: "derive_facts", limited: "deterministic_limited_answer",
    })
    .addEdge("derive_facts", "draft_claims")
    .addEdge("draft_claims", "validate_claims")
    .addConditionalEdges("validate_claims", n.routeAfterClaimValidation, {
      render: "render_answer", replan: "create_plan", clarify: "request_clarification", limited: "deterministic_limited_answer",
    })
    .addEdge("render_answer", "validate_rendered_answer")
    .addConditionalEdges("validate_rendered_answer", n.routeAfterRenderValidation, {
      publish: "publish_answer", repair: "render_answer", fallback: "deterministic_limited_answer",
    })
    .addEdge("deterministic_limited_answer", "publish_answer")
    .addEdge("publish_answer", "persist_terminal_state")
    .addEdge("persist_terminal_state", END)
    .compile({ checkpointer: deps.checkpointCoordinator.saver });
}
```

`requestClarification` creates the pending interaction and its outbox event through an idempotent journal entry, then calls `interrupt({ interactionId, question, responseSchemaRef, threadVersion, expiresAt })`. `consumeClarification` validates the value supplied through `new Command({ resume: value })`; it never reconstructs a reply from UI history. `publishAnswer` refreshes actor scope, verifies the current lease, persists the final `AnswerEnvelope`, then calls `events.appendAnswer()`; it never consumes model stream chunks.

`compactContext` runs only when the selected model's explicit context budget would be exceeded. It persists a `ConversationSummary` with source message IDs, summary/prompt versions, confirmed semantic refs and evidence refs; it retains recent raw turns and all negations, time filters, scope constraints and pending interaction fields. Historical numbers remain refs that must be re-queried. Every later model node rebuilds messages from authorized durable `modelTurns`/content refs, reserves 25% for tool/final output, and rechecks the model's certified purpose. Fallback selection is an explicit policy list of `planner_certified` models only and appends `model.fallback` with actual endpoint config version to audit.

All prompt builders serialize untrusted source text inside a typed JSON data section with stable IDs and an explicit “data, not instructions” boundary. Tool definitions and policy/system instructions come only from code. A fixture whose defect comment says “ignore flags and run SQL” must produce zero forbidden calls and a normal evidence limitation.

- [ ] **Step 6: Run graph and all lower-layer tests**

```bash
npm test -- \
  src/test/server/agentRuntime/legacyAdapter.test.ts \
  src/test/server/agentRuntime/graph.test.ts \
  src/test/server/agentRuntime/graphResume.test.ts \
  src/test/server/agentRuntime/policy.test.ts \
  src/test/server/agentRuntime/evidence.test.ts \
  src/test/server/agentRuntime/toolRegistry.test.ts
```

Expected: PASS. No Python Ontology/TestAgent process is started.

- [ ] **Step 7: Commit**

```bash
git add server/agentRuntime/legacyAdapter.mjs server/agentRuntime/graph.mjs src/test/server/agentRuntime/legacyAdapter.test.ts src/test/server/agentRuntime/graph.test.ts src/test/server/agentRuntime/graphResume.test.ts
git commit -m "feat: assemble provisional main agent graph"
```

### Task 14: Orchestrate run admission, execution, cancellation, recovery, and reaping

**Files:**
- Create: `server/agentRuntime/runtime.mjs`
- Create: `server/agentRuntime/audit.mjs`
- Create: `src/test/server/agentRuntime/runtime.test.ts`
- Create: `src/test/server/agentRuntime/recovery.test.ts`
- Create: `src/test/server/agentRuntime/runtimeLimits.test.ts`
- Create: `src/test/server/agentRuntime/audit.test.ts`
- Create: `src/test/server/agentRuntime/runtimeFixture.ts`
- Modify: `server/agentRuntime/policy.mjs`
- Test: `src/test/server/agentRuntime/policy.test.ts`

- [ ] **Step 1: Write failing admission and idempotency tests**

Create a real migrated temporary DB and fake graph worker. Use an injected database clock and ID source. The tests call the public Runtime API, not private SQL:

```ts
const runtime = await createTestRuntime({ graphBehavior: "complete" });
const request = {
  schemaVersion: "1.0", messageId: "msg-1", threadVersion: 0,
  message: { role: "user", text: "六月有多少缺陷？", artifactRefs: [] },
  selectedModel: "deepseek-v4-flash", useDefectContext: false, useAnalyticsContext: true,
  eventProtocolVersion: "1.0",
};
const first = await runtime.startRun({ actor: alice, request });
const retry = await runtime.startRun({ actor: alice, request });
expect(retry).toMatchObject({ runId: first.runId, threadId: first.threadId, idempotentReplay: true });
await expect(runtime.startRun({ actor: alice, request: { ...request, message: { ...request.message, text: "不同问题" } } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
```

Add concrete assertions for: one active run per thread; maximum two active runs per actor; maximum twenty active runs for the local instance; token-bucket admission of 30 starts/minute with burst 5; `Retry-After` on `429`; and new-thread IDs generated by the server when `request.threadId` is absent.

`runtimeFixture.ts` exports `createTestRuntime({ graphBehavior, injectedFaults, clock })`. It composes the real migrated DB, contracts, thread/event/journal/checkpoint/audit/policy stores and deterministic IDs with fake model/tool/graph boundaries; it returns the Runtime plus actor fixtures, spies and `cleanup()`. Tests never mock persistence/fencing SQL.

- [ ] **Step 2: Write failing cancel, resume, deadline, and recovery tests**

The deterministic fixtures cover these transitions:

```text
running + cancel       -> persist cancel request -> increment leaseEpoch -> abort local worker -> run.cancelled
waiting + cancel       -> consume pending interaction -> increment leaseEpoch -> run.cancelled
waiting + resume       -> refresh actor -> catch up canonical checkpoint -> consume once -> Command({resume})
interaction TTL        -> interaction.expired -> run.failed(INTERACTION_EXPIRED)
active budget/hard TTL -> fence worker -> run.failed(RUN_DEADLINE_EXCEEDED)
expired worker lease   -> new leaseEpoch -> catch up -> resume exact canonical checkpoint
```

Assert that each path has exactly one terminal status and one terminal event. A network/SSE disconnect must leave the run active. A late fake model/tool result after cancel must fail its lease fence and add no state, evidence, answer, or event. A v2 worker trying to claim a `main-agent-v1` run must return `GRAPH_VERSION_MISMATCH`.

For journal-ahead recovery, commit a completed fake tool transition and outbox event but omit the LangGraph candidate checkpoint. `recoverRun()` must call `ensureCheckpointCaughtUp()`, replay the committed journal delta without invoking the tool a second time, write and CAS-promote a candidate checkpoint, then continue. Assert that an orphan Saver-latest checkpoint is never selected.

- [ ] **Step 3: Run the tests and verify RED**

```bash
npm test -- \
  src/test/server/agentRuntime/runtime.test.ts \
  src/test/server/agentRuntime/recovery.test.ts \
  src/test/server/agentRuntime/runtimeLimits.test.ts
```

Expected: FAIL because `runtime.mjs` does not exist and policy has no run-admission methods.

- [ ] **Step 4: Add deterministic run admission to policy**

Extend `createRuntimePolicy()` with `authorizeRunStart({ actor, counts, rateState })`. It returns an updated token-bucket state or throws a typed error:

```js
if (counts.threadActive >= 1) deny("THREAD_BUSY", 409);
if (counts.actorActive >= 2) deny("ACTOR_ACTIVE_RUN_LIMIT", 429, { retryAfterSeconds: 1 });
if (counts.globalActive >= 20) deny("INSTANCE_ACTIVE_RUN_LIMIT", 429, { retryAfterSeconds: 1 });
const elapsedMinutes = Math.max(0, (rateState.nowMs - rateState.updatedAtMs) / 60000);
const available = Math.min(5, rateState.tokens + elapsedMinutes * 30);
if (available < 1) deny("RUN_RATE_LIMITED", 429, { retryAfterSeconds: Math.ceil((1 - available) * 2) });
return { tokens: available - 1, updatedAtMs: rateState.nowMs };
```

Change the local `deny()` helper to accept `statusCode` and metadata while preserving existing tool-policy error codes. Persist rate state per actor in `agent_actor_rate_limits`; do not use an in-memory counter that resets on process restart.

- [ ] **Step 5: Implement the Runtime public interface**

Export `createAgentRuntime(deps)` with this exact surface:

```js
{
  startRun({ actor, request }),
  resumeRun({ actor, runId, interactionId, threadVersion, value }),
  cancelRun({ actor, runId, threadVersion, reasonCode }),
  recoverRun({ runId, workerId }),
  recoverExpiredRuns(),
  reapExpiredWork(),
  startBackgroundLoops(),
  stopBackgroundLoops(),
  getActiveWorkerCount(),
}
```

`startRun()` follows this order:

1. Validate the new-run contract and refresh `ActorContext`.
2. In one DB transaction, enforce rate/concurrency, create or authorize the thread, enforce `(actorId,messageId)` semantic idempotency, append the user message, create the run, increment `threadVersion`, and append `run.started`.
3. For an existing thread, call `ensureCheckpointCaughtUp()` on its previous canonical run before accepting a new message. For regenerate, require the supplied parent checkpoint to equal the authorized parent run's canonical checkpoint and catch up that run. A lagging projection returns typed `503 THREAD_RECOVERING` with `retryable=true` until the recovery queue finishes.
4. Claim the new run lease. For a brand-new thread, write and CAS-promote the deterministic state-version-0 root checkpoint synchronously; for an existing thread, carry forward the exact caught-up canonical ID. Then schedule `executeClaimedRun()` and return `{ threadId, runId, threadVersion, firstEventId, idempotentReplay }`.

`executeClaimedRun()` owns one `AbortController` in a process-local `Map<runId, controller>` only while active. It renews the lease every 10 seconds, polls durable cancellation every second and before each external boundary, and iterates the graph with the exact canonical config:

```js
const config = checkpointCoordinator.canonicalConfigForRun(run);
await checkpointExecutionContext.run({ runId: run.runId, threadId: run.threadId, leaseEpoch: lease.leaseEpoch, graphDefinitionVersion: run.graphDefinitionVersion }, async () => {
  for await (const _update of graph.stream(inputOrCommand, config, { streamMode: "updates" })) {
    threadStore.assertLease({ runId: run.runId, leaseEpoch: lease.leaseEpoch });
  }
});
```

The candidate-tracking checkpointer from Task 9 observes each exact Saver `put()` and promotes it with the current app `stateVersion/leaseEpoch`; the worker loop never calls `getState()` without a canonical checkpoint ID.

Do not call Saver “latest” when no canonical ID exists. A brand-new run with `stateVersion=0` starts from an explicit root config; all other progress requires an exact canonical checkpoint ID.

- [ ] **Step 6: Implement resume, cancel, and reaper CAS rules**

- `resumeRun()` refreshes identity, authorizes the thread/run and referenced artifacts, checks graph version, calls real checkpoint catch-up, atomically consumes the pending interaction using the supplied `threadVersion`, increments the version, emits `run.resumed`, claims a new lease, then schedules `new Command({ resume: value })`. A duplicate identical resume returns the stored resume result; a conflicting value returns `409 INTERACTION_ALREADY_CONSUMED`.
- `cancelRun()` persists cancellation and increments `leaseEpoch` before aborting the local controller. Waiting runs atomically cancel the interaction and terminalize immediately. Active read-only runs terminalize immediately after fencing; any late result fails the new epoch.
- `reapExpiredWork()` uses database time. It atomically handles interaction expiry, 120-second accumulated active budget, 24-hour hard deadline, and expired leases. Every terminal transition and its outbox event occur in the same application transaction.
- The maintenance pass applies configurable defaults: events 30 days (insert cursor tombstones before deletion), unreferenced artifacts 7 days, and deleted/unarchived thread/checkpoint data 90 days. It never deletes an event needed by an active run or an artifact referenced by a retained thread/audit record. Audit retention is handled only by the offline Task 19 cleanup command.
- `recoverExpiredRuns()` claims only leases whose stored `lease_expires_at` is in the past. There is no `forceExpired` or administrator bypass in the Runtime API.
- Every resume, model/tool boundary, publish, event replay, and recovery takeover invokes `refreshActor()`. If `scopeHash` changes, invalidate the compiled plan, evidence, journal eligibility, artifact visibility and approval state; filter durable messages/model turns before recompilation, or fail `SCOPE_REVOKED`.

`createAuditStore({ db, now, randomUUID })` exposes only `append(record)` and scoped reads for administrators; it has no update/delete method, and a migration trigger rejects updates. Retention deletion is available only to Task 19's offline cleanup command. Runtime writes actor/thread/run, requested/actual model and config version, graph/prompt version, semantic/revision refs, node/latency/usage, tool args hash/latency/retry, evidence IDs, claim validation ref, cancellation/recovery/security decisions and terminal status. It stores diagnostic refs, never credentials, cookies, raw sensitive fields or chain-of-thought. `audit.test.ts` proves immutability and redaction.

- [ ] **Step 7: Run lifecycle and lower-level fencing tests**

```bash
npm test -- \
  src/test/server/agentRuntime/runtime.test.ts \
  src/test/server/agentRuntime/recovery.test.ts \
  src/test/server/agentRuntime/runtimeLimits.test.ts \
  src/test/server/agentRuntime/audit.test.ts \
  src/test/server/agentRuntime/runLifecycle.test.ts \
  src/test/server/agentRuntime/stepJournal.test.ts \
  src/test/server/agentRuntime/checkpoint.test.ts
```

Expected: PASS and all fake external calls occur at most once.

- [ ] **Step 8: Commit**

```bash
git add server/agentRuntime/runtime.mjs server/agentRuntime/audit.mjs server/agentRuntime/policy.mjs src/test/server/agentRuntime/runtime.test.ts src/test/server/agentRuntime/recovery.test.ts src/test/server/agentRuntime/runtimeLimits.test.ts src/test/server/agentRuntime/audit.test.ts src/test/server/agentRuntime/runtimeFixture.ts src/test/server/agentRuntime/policy.test.ts
git commit -m "feat: orchestrate recoverable agent runs"
```

### Task 15: Add the env-first application, Runtime modes, and versioned HTTP API

**Files:**
- Create: `server/app.mjs`
- Create: `server/agentRuntime/httpRoutes.mjs`
- Create: `src/test/server/agentRuntime/api.test.ts`
- Create: `src/test/server/agentRuntime/runtimeModes.test.ts`
- Create: `src/test/server/agentRuntime/httpFixture.ts`
- Modify: `server/index.mjs`
- Modify: `scripts/dev.mjs`
- Test: `src/test/server/companyChat.test.ts`
- Test: `src/test/server/mainAgentToolLoop.test.ts`

- [ ] **Step 1: Write failing import-safety and model-discovery tests**

```ts
// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createAgentApp } from "../../../../server/app.mjs";

describe("Agent HTTP application", () => {
  it("can be imported without opening a listening socket", async () => {
    expect(typeof createAgentApp).toBe("function");
  });

  it("returns only the public server model registry", async () => {
    const fixture = await startTestAgentServer();
    const response = await fetch(`${fixture.baseUrl}/api/ai/models`, { headers: fixture.identityHeaders });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", capabilities: expect.any(Object), configVersion: "test-v1" }],
      defaultModelId: "deepseek-v4-flash",
    });
    expect(JSON.stringify(body)).not.toMatch(/secret|credential|access.?code/i);
  });
});
```

`startTestAgentServer()` is a shared test helper created in `src/test/server/agentRuntime/httpFixture.ts`; it calls `http.createServer(createAgentApp(deps)).listen(0, "127.0.0.1")`, returns an actor-scoped header set, and closes the server plus Runtime DB in `afterEach`.

- [ ] **Step 2: Write failing route, protocol, authorization, and mode tests**

Test every route with an ephemeral server and two actors:

| Request | Success | Required failure assertions |
|---|---:|---|
| `POST /api/agent/runs` | `202` with run/thread/version and three `X-Agent-*` headers | missing explicit flags `400`; stale version `409`; unsupported event version `406` |
| `GET /api/agent/runs/:runId/events` | `200 text/event-stream` in exactly one requested profile | other actor `404`; forged/expired cursor `410` with thread snapshot link; missing/invalid profile `406` |
| `POST /api/agent/runs/:runId/resume` | `202` | wrong interaction/version `409`; expired `410` |
| `POST /api/agent/runs/:runId/cancel` | `202` idempotent | other actor `404`; stale version `409` |
| `GET /api/agent/threads/:threadId` | `200` snapshot/final answer | other actor `404` |
| `POST /api/agent/threads/import` | `201` first time, `200` identical retry | changed history for same client conversation `409` |
| `POST /api/agent/threads/:threadId/fork` | `201` with parent provenance | non-canonical checkpoint `409`; other actor `404` |
| `PATCH /api/agent/threads/:threadId` | `200` for title/pinned/archived/deleted | unknown field `400`; stale version `409` |
| `POST /api/agent/artifacts` | `201` metadata/ref only; raw binary body with MIME and encoded display-name headers | MIME/size/quota failures `400/413/429` |
| `GET /api/agent/artifacts/:artifactId` | `200` authorized bytes | other actor/expired `404` |

Explicitly assert that `POST /api/agent/approvals/:approvalId/decide` returns `404`; Phase 1 must not register it.

Preserve `/health` as liveness and add readiness fields `{ service:"agent-api", ready, runtimeMode, graphDefinitionVersion, applicationSchemaVersion, saverReady, analyticsReady }`; credentials and endpoint URLs are excluded. A schema/Saver/model configuration failure prevents listen rather than returning a false-ready process.

For modes, assert:

- no config means `legacy` and the current handler/SSE remains byte-compatible, including `/api/chat`;
- `shadow` returns only the legacy answer, runs the graph only for eligible read-only traffic, and its graph registry never calls Duplicate Search;
- `langgraph` serves the new graph only for the Phase 1 allowlist and routes unsupported intents to legacy or a typed `LEGACY_EQUIVALENCE_NOT_ALLOWLISTED` decision according to config;
- one connection never contains both an AgentEvent envelope and a legacy `choices[].delta` payload;
- omitting the two old `/api/ai/chat` booleans normalizes both to `false`.

- [ ] **Step 3: Run the tests and verify RED**

```bash
npm test -- \
  src/test/server/agentRuntime/api.test.ts \
  src/test/server/agentRuntime/runtimeModes.test.ts
```

Expected: FAIL because the injectable app and routes do not exist.

- [ ] **Step 4: Split startup from the injectable application**

Move the current route/application logic from `server/index.mjs` into `server/app.mjs` while preserving all existing routes. `server/app.mjs` exports:

```js
export function createAgentApp(deps) {
  return async function agentRequestListener(request, response) {
    // common identity, origin, body limit and error boundary; then legacy and versioned routers
  };
}

export function createAgentServer(deps) {
  return http.createServer(createAgentApp(deps));
}
```

`server/index.mjs` becomes the composition root and contains no static import of a module that reads model/tool environment values:

```js
import { loadLocalEnv } from "./loadLocalEnv.mjs";

loadLocalEnv();
const { buildProductionDependencies, createAgentServer } = await import("./app.mjs");
const deps = await buildProductionDependencies({ env: process.env });
const server = createAgentServer(deps);
server.listen(deps.config.port, deps.config.host, () => deps.logger.info(`Agent API listening on ${deps.config.host}:${deps.config.port}`));

const shutdown = async () => {
  await deps.runtime.stopBackgroundLoops();
  await new Promise((resolve) => server.close(resolve));
  await deps.close();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
```

Production dependency construction checks the application migration version, Saver schema readiness, singleton instance guard, model registry completeness, safe host/identity/origin combination, and read-only Analytics health before listening. It never auto-migrates or downloads a plugin/model.

- [ ] **Step 5: Implement the exact versioned router**

`createAgentHttpRoutes({ runtime, threadStore, artifactStore, eventStore, modelRegistry, identityResolver, config })` returns `route(request, response, url) -> Promise<boolean>`. Parse fixed route regexes; never treat user path fragments as filesystem paths. Every route resolves/refreshes identity from the trusted transport and calls the corresponding store/Runtime method.

Ordinary JSON routes use the 1 MiB bounded reader. The one-time legacy-import route is the sole exception: it permits at most 28 MiB encoded JSON, then separately enforces <=1 MiB text/metadata and decoded attachment limits of 5 items, 8 MiB each and 20 MiB total before atomically converting data URLs to refs. Artifact upload streams a raw body through `readBinaryBody(maxBytes=8*1024*1024)`, requires an allowlisted `Content-Type`, an RFC 5987/percent-encoded display name in `X-Artifact-File-Name`, and optional server-authorized `X-Agent-Thread-ID`; it stops reading immediately at the limit. No multipart parser, filename-derived path or query credential is used.

Successful new-run response:

```json
{
  "schemaVersion": "1.0",
  "threadId": "thread-server-id",
  "runId": "run-server-id",
  "threadVersion": 1,
  "eventsUrl": "/api/agent/runs/run-server-id/events"
}
```

Set these headers on both `POST /api/agent/runs` and `/api/ai/chat` agent-v1 responses:

```text
X-Agent-Protocol: 1.0
X-Agent-Run-ID: <runId>
X-Agent-Thread-ID: <threadId>
```

`GET events` accepts only `Accept: text/event-stream; profile="agent-v1"` or `profile="legacy-chat"`, authorizes current actor/scope, and passes `Last-Event-ID` to replay. A retained-history miss returns:

```json
{
  "code": "EVENT_HISTORY_EXPIRED",
  "snapshotUrl": "/api/agent/threads/<threadId>"
}
```

Use bearer/trusted-proxy identity for the initial multi-user path. Credentials are accepted only in headers, never query parameters; scrub them from logs. If a cookie identity mode is later enabled, the same task must require a double-submit CSRF header for run/resume/cancel/artifact/metadata requests before allowing LAN bind.

- [ ] **Step 6: Implement `/api/ai/chat` as a facade, not a second loop**

Keep the current legacy handler for `MAIN_AGENT_RUNTIME_MODE=legacy`. In `langgraph`, normalize the old body, import/bind legacy history if needed, call `runtime.startRun()`, and stream the same run with `legacy-chat` unless `eventProtocolVersion="1.0"` was explicit. In `shadow`, invoke the legacy handler for the user response and enqueue a graph comparison with `useDefectContext=false`; the shadow result is audit-only and never publishes to that response.

Preserve `POST /api/chat` as an exact alias and preserve current `writeSseEvent`/`writeSseResponse` legacy semantics. The new router selects one protocol before writing headers; it cannot switch after bytes have been sent.

- [ ] **Step 7: Load env before ports in the development orchestrator**

Update `scripts/dev.mjs` to call the existing local-env loader before reading ports and to start `server/index.mjs`. Preserve the user's already-staged `--experimental-sqlite` flags. Keep Python on loopback; keep the Vite `/api` proxy unchanged. Default Vite, Node, and Python hosts to `127.0.0.1`; LAN exposure requires trusted-proxy identity, TLS termination, and an explicit origin allowlist.

- [ ] **Step 8: Run all HTTP and legacy compatibility tests**

```bash
npm test -- \
  src/test/server/agentRuntime/api.test.ts \
  src/test/server/agentRuntime/runtimeModes.test.ts \
  src/test/server/companyChat.test.ts \
  src/test/server/mainAgentToolLoop.test.ts \
  src/test/server/mainAgentTools.test.ts
```

Expected: PASS. Importing `server/app.mjs` opens no port and starts no warmup.

- [ ] **Step 9: Commit**

```bash
git add server/index.mjs server/app.mjs server/agentRuntime/httpRoutes.mjs scripts/dev.mjs src/test/server/agentRuntime/api.test.ts src/test/server/agentRuntime/runtimeModes.test.ts src/test/server/agentRuntime/httpFixture.ts
git commit -m "feat: expose versioned main agent runtime api"
```

### Task 16: Build a strict browser event decoder and API client

**Files:**
- Create: `src/lib/agentEventStream.ts`
- Create: `src/lib/agentApi.ts`
- Create: `src/test/ai-chat/agentEventStream.test.ts`
- Create: `src/test/ai-chat/agentApi.test.ts`

- [ ] **Step 1: Write failing incremental SSE tests**

```ts
import { describe, expect, it } from "vitest";
import { AgentEventProtocolError, createAgentEventDecoder } from "../../lib/agentEventStream";

const event = (overrides = {}) => ({
  schemaVersion: "1.0", eventId: "evt-1", runId: "run-1", threadId: "thread-1",
  stateVersion: 1, sequence: 1, timestamp: "2026-07-14T00:00:00.000Z", type: "run.started",
  payload: { threadVersion: 1, runtimeMode: "langgraph", requestedModelId: "deepseek-v4-flash", actualModelId: "deepseek-v4-flash" },
  ...overrides,
});

describe("agent-v1 SSE decoder", () => {
  it("decodes UTF-8, CRLF, comments and multiline data across arbitrary byte chunks", () => {
    const decoder = createAgentEventDecoder({ profile: "agent-v1" });
    const json = JSON.stringify(event());
    const splitAt = json.indexOf(',"payload"');
    const bytes = new TextEncoder().encode(`: heartbeat\r\nid: evt-1\r\ndata: ${json.slice(0, splitAt + 1)}\r\ndata: ${json.slice(splitAt + 1)}\r\n\r\n`);
    const outputs = [...decoder.push(bytes.subarray(0, 17)), ...decoder.push(bytes.subarray(17, 61)), ...decoder.push(bytes.subarray(61)), ...decoder.finish()];
    expect(outputs).toEqual([event()]);
  });

  it("deduplicates an exact replay and rejects a conflicting sequence", () => {
    const decoder = createAgentEventDecoder({ profile: "agent-v1" });
    expect(decoder.accept(event())).toEqual(event());
    expect(decoder.accept(event())).toBeNull();
    expect(() => decoder.accept(event({ eventId: "evt-2" }))).toThrow(AgentEventProtocolError);
  });

  it("validates UTF-8 answer offsets, answer id and hash", () => {
    const decoder = createAgentEventDecoder({ profile: "agent-v1" });
    decoder.accept(event({ eventId: "evt-a", sequence: 1, type: "answer.delta", payload: { answerId: "a1", contentHash: "hash-1", offset: 0, text: "中文" } }));
    expect(decoder.accept(event({ eventId: "evt-b", sequence: 2, type: "answer.delta", payload: { answerId: "a1", contentHash: "hash-1", offset: 6, text: "A" } }))).not.toBeNull();
    expect(() => decoder.accept(event({ eventId: "evt-c", sequence: 3, type: "answer.delta", payload: { answerId: "a1", contentHash: "hash-1", offset: 8, text: "B" } }))).toThrow(/ANSWER_OFFSET_MISMATCH/);
  });
});
```

Add explicit tests for `\n\n`, `\r\n\r\n`, `data:` and `data: `, blank/multiline data, JSON split inside a multibyte Chinese character, a trailing incomplete frame on `finish()`, heartbeat comments producing no event/sequence, missing fields, unknown event type, wrong schema version, event-ID mismatch between SSE `id:` and envelope, terminal event followed by more events, and legacy `[DONE]` accepted only in `legacy-chat` profile.

- [ ] **Step 2: Write failing API-client tests**

Mock `fetch` by URL and assert exact methods, paths, headers, and bodies for:

```ts
fetchAgentModels();
importLegacyConversation({ clientConversationId, messages });
startAgentRun({ messageId, threadId, threadVersion, branch, message, selectedModel, useDefectContext, useAnalyticsContext });
openAgentEvents({ runId, profile: "agent-v1", lastEventId, signal });
resumeAgentRun({ runId, interactionId, threadVersion, value });
cancelAgentRun({ runId, threadVersion, reasonCode: "user_stop" });
uploadAgentArtifact({ threadId, file, signal }); // raw file body; Content-Type + encoded X-Artifact-File-Name
fetchAgentThread({ threadId });
forkAgentThread({ threadId, parentRunId, parentCheckpointId, supersedesMessageId, threadVersion });
patchAgentThread({ threadId, threadVersion, title, pinned, archived, deleted });
```

Assert that the client sends no `actorId`, user ID, credential, base64 content in run bodies, or identity value in an SSE query string. It must cross-check `X-Agent-Run-ID`/`X-Agent-Thread-ID` against the JSON body/events and map `406`, `409`, `410`, `413`, and `429` to typed `AgentApiError` objects. A `410` includes `snapshotUrl`; no helper reconstructs an answer from a partial cursor.

- [ ] **Step 3: Run both files and verify RED**

```bash
npm test -- src/test/ai-chat/agentEventStream.test.ts src/test/ai-chat/agentApi.test.ts
```

Expected: FAIL because both client modules are missing.

- [ ] **Step 4: Implement the incremental decoder and cursor**

Use one streaming `TextDecoder("utf-8", { fatal: true })`, retain the incomplete final line/frame between calls, concatenate multiple `data:` lines with `\n`, and ignore comment lines. Do not split decoded JS strings before the streaming decoder has completed a byte sequence.

Expose:

```ts
export class AgentEventProtocolError extends Error {
  constructor(public code: string, message: string, public retryable = false) { super(message); }
}

export type AgentEventDecoder = {
  push(chunk: Uint8Array): AgentStreamItem[];
  finish(): AgentStreamItem[];
  accept(item: unknown): AgentStreamItem | null;
  snapshot(): { lastEventId?: string; lastSequence: number; answerId?: string; answerHash?: string; answerOffset: number; terminal: boolean };
};
```

Validate every event envelope and its concrete payload before `accept()` returns it. Maintain `eventId -> canonical JSON` and `sequence -> eventId`; exact repeats return `null`, while any mismatch raises a non-retryable protocol error. Calculate next answer offset with `new TextEncoder().encode(text).byteLength`. `legacy-chat` uses a separate parser for existing status/tool/choices payloads and `[DONE]`; profile selection is immutable for a decoder instance.

- [ ] **Step 5: Implement the API facade with header correlation**

Use relative `/api` URLs only. `startAgentRun()` always sends `eventProtocolVersion: "1.0"` and explicit booleans. `openAgentEvents()` sets:

```ts
headers: {
  Accept: `text/event-stream; profile="${profile}"`,
  ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
}
```

It returns `{ response, decoder, headers: { protocol, runId, threadId } }` and never auto-POSTs the user message on reconnect. A helper `readAgentEventStream()` yields decoded items until terminal/abort; it treats ordinary network EOF as reconnectable and protocol corruption as a profile-fallback decision for the caller.

- [ ] **Step 6: Run tests**

```bash
npm test -- src/test/ai-chat/agentEventStream.test.ts src/test/ai-chat/agentApi.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/agentEventStream.ts src/lib/agentApi.ts src/test/ai-chat/agentEventStream.test.ts src/test/ai-chat/agentApi.test.ts
git commit -m "feat: add strict main agent event client"
```

### Task 17: Migrate AI Chat model discovery, stable history binding, and artifact refs

**Files:**
- Modify: `src/components/dashboard/pages/AIChat.tsx`
- Modify: `src/components/dashboard/chat/companyModels.ts`
- Modify: `src/test/ai-chat/AIChat.test.tsx`
- Test: `src/test/ai-chat/DuplicateSearchResults.test.tsx`

- [ ] **Step 1: Add URL-aware fetch fixtures without changing existing assertions**

Refactor the AIChat test fetch mock to dispatch by `new URL(String(input), "http://localhost").pathname`. Give `/api/ai/models` a default response and leave all current Duplicate Search/warmup/feedback fixtures unchanged. Run the existing file before changing production code:

```bash
npm test -- src/test/ai-chat/AIChat.test.tsx src/test/ai-chat/DuplicateSearchResults.test.tsx
```

Expected before the new assertions: 27 existing AIChat/Duplicate tests pass with only the known React `act(...)` warnings.

- [ ] **Step 2: Write failing server-model discovery tests**

Assert that:

- model order and default come only from `GET /api/ai/models`;
- Bacon appears only when returned by the server;
- a `chat_only` or `planner_candidate` model is labelled as not certified for tool-planning and cannot be selected for a request that requires analytics/defect tools;
- registry failure shows an actionable unavailable state and does not silently use the hard-coded first model;
- changing main-Agent model discovery does not alter the model option/body used by `runDuplicateSearch()`.

Keep `companyModels.ts` as the dedicated Duplicate Search legacy model source. Remove its import only from the main-chat selection branch; do not rename its env variables or change `normalizeCompanyModel()` for Duplicate Search.

- [ ] **Step 3: Write failing stable-ID and one-time import tests**

Seed `dtsv.chat.v2` with a conversation and messages that lack IDs. On first render, assert that UUIDs are generated and immediately written back. Reload and retry a failed import; every ID must be identical. The import body has this exact shape:

```json
{
  "schemaVersion": "1.0",
  "clientConversationId": "stable-client-conversation-id",
  "messages": [
    { "clientMessageId": "stable-message-id", "role": "user", "text": "hello", "artifactRefs": [], "createdAt": "2026-07-14T00:00:00.000Z" }
  ]
}
```

Add a mixed-history fixture containing `mode="duplicate-search"`, `duplicateResult`, candidates and feedback. None may appear in the main Runtime import. After a successful binding, persist `serverThreadId`, `serverThreadVersion`, and `legacyImportContentHash` on the conversation; the next request sends only the new user message plus those server identifiers, not full history.

- [ ] **Step 4: Write failing artifact migration tests**

For a new PDF/image attachment, assert this sequence:

```text
POST /api/agent/artifacts (raw binary body with MIME/display-name headers)
POST /api/agent/runs      (artifactRefs only)
GET  /api/agent/runs/:runId/events
```

The run body must not contain `data:`, `file_data`, base64, a local path, or raw bytes. An old localStorage data URL is allowed only in the one-time legacy import and must be replaced locally by the returned artifact ref. A sixth file, a file above 8 MiB, and aggregate files above 20 MiB are rejected before a run starts. Duplicate Search mode must neither upload an artifact nor add its local messages to the Runtime thread.

- [ ] **Step 5: Run the new tests and verify RED**

```bash
npm test -- src/test/ai-chat/AIChat.test.tsx
```

Expected: FAIL because AIChat still uses a build-time model list, resends full history/base64, and has no server thread binding.

- [ ] **Step 6: Extend the local conversation record with stable Runtime metadata**

Keep the existing `dtsv.chat.v2` key and migrate in place. Extend the local types without storing server-owned actor data:

```ts
type RuntimeBinding = {
  serverThreadId: string;
  serverThreadVersion: number;
  legacyImportContentHash: string;
};

type Conversation = ExistingConversationFields & {
  id: string;
  runtimeBinding?: RuntimeBinding;
};

type Msg = ExistingMessageFields & {
  id: string;
  serverMessageId?: string;
  artifactRefs?: string[];
  supersedesMessageId?: string;
};
```

`normalizeStoredConversations()` generates missing IDs once, returns `{ conversations, changed }`, and the load effect writes the normalized value immediately when `changed=true`. IDs are never generated inside an import retry loop. `selectLegacyImportMessages()` includes only normal `chat` user/assistant messages and excludes tool markup, runtime events, Duplicate Search content and candidate objects.

- [ ] **Step 7: Fetch models and bind/import history before the first new run**

On main-chat mount, call `fetchAgentModels()`. Preserve the server's order and `defaultModelId`. Before sending the first message for an unbound local conversation, call `importLegacyConversation()` with normalized stable IDs and persist the binding response. Bound conversations call `startAgentRun()` directly with `threadId/threadVersion`.

If import or model discovery fails, keep the draft and attachments intact and show a retryable error; never switch to an external model or silently create a second local conversation.

- [ ] **Step 8: Upload artifacts and submit refs**

Retain existing preview UX, but upload accepted files through `uploadAgentArtifact()` before `startAgentRun()`. Store only returned refs in the submitted message and Runtime-bound local record. Clean temporary browser object URLs after preview; never place a server storage path in state. Legacy inline PDF/image construction remains available only to the unchanged `legacy` compatibility branch during rollback, not the new `agent-v1` run path.

- [ ] **Step 9: Run focused AI Chat and Duplicate Search regressions**

```bash
npm test -- \
  src/test/ai-chat/AIChat.test.tsx \
  src/test/ai-chat/DuplicateSearchResults.test.tsx \
  src/test/ai-chat/agentApi.test.ts
```

Expected: PASS. Existing Duplicate Search warmup, results, feedback and Octane-link assertions remain unchanged.

- [ ] **Step 10: Commit**

```bash
git add src/components/dashboard/pages/AIChat.tsx src/components/dashboard/chat/companyModels.ts src/test/ai-chat/AIChat.test.tsx
git commit -m "feat: bind ai chat to runtime threads"
```

### Task 18: Render auditable events, reconnect safely, and preserve branch semantics

**Files:**
- Create: `src/components/dashboard/chat/AgentRunTimeline.tsx`
- Create: `src/test/ai-chat/AgentRunTimeline.test.tsx`
- Modify: `src/components/dashboard/pages/AIChat.tsx`
- Modify: `src/components/dashboard/chat/MessageRenderer.tsx`
- Modify: `src/test/ai-chat/AIChat.test.tsx`
- Create: `src/test/ai-chat/mainAgentRuntime.e2e.ts`
- Modify: `playwright.config.ts`

- [ ] **Step 1: Write failing timeline and private-reasoning tests**

Feed the component this fixed sequence:

```text
run.started
ontology.resolved(mode=legacy_provisional)
plan.validated
tool.started(redactedCanonicalArgs)
tool.completed
evidence.added(groundingStatus=legacy_equivalence)
claims.validated
answer.delta
run.completed
```

Assert that lifecycle rows show runtime mode, provisional semantics, tool name, redacted arguments, evidence status, limitations, and safe failure actions. `answer.delta` is not rendered by the timeline. The component never renders a `reasoning`, `chainOfThought`, credential-like field, raw attachment payload, `<think>` text, or a `grounded` badge. Unknown event types fail closed into a protocol-error status rather than rendering arbitrary payload JSON.

Add `MessageRenderer` tests proving `<think>private</think>` and any legacy reasoning segment are removed from visible output while ordinary Markdown remains unchanged.

- [ ] **Step 2: Write failing run-stream, reconnect, and cancel tests**

Drive AIChat with a controlled `ReadableStream` and assert:

- lifecycle events update `Msg.agentEvents`/timeline only; they never become `<step>` markup or answer content;
- validated `answer.delta` text alone enters the existing `createStreamTextAnimator()`;
- run/thread/version headers and terminal events update the Runtime binding;
- a network EOF reconnects the same `runId` using the last event ID and does not call cancel;
- an agent-v1 protocol error opens the same run using `profile="legacy-chat"`, never re-POSTing the message;
- a `410` fetches the authoritative thread snapshot/final `AnswerEnvelope` and replaces the partial answer;
- clicking Stop first calls `POST /api/agent/runs/:runId/cancel`, then aborts the local reader; merely unmounting or losing the network does not cancel;
- a late `finally` from an old request cannot clear a newer request's streaming state.

- [ ] **Step 3: Write failing edit, regenerate, clarification, and metadata tests**

- Regenerate calls `startAgentRun()` on the same thread with `branch:{ parentRunId, parentCheckpointId }` from the selected completed checkpoint and a new message ID; it never reuses the original request ID or overwrites the prior run.
- Editing a historical user message creates a new thread branch with `parentThreadId`, `parentCheckpointId` and `supersedesMessageId`, then creates a new message ID. It does not mutate the old message/checkpoint in place.
- A `clarification.required` form submits through `resumeAgentRun()` with the exact `interactionId/threadVersion`; a normal chat send is not treated as resume.
- Rename/pin/archive/delete stay optimistic in the UI but call `PATCH /api/agent/threads/:threadId` when bound and roll back on version conflict.
- No approval-decision UI or endpoint is added in Phase 1.

- [ ] **Step 4: Run the tests and verify RED**

```bash
npm test -- \
  src/test/ai-chat/AgentRunTimeline.test.tsx \
  src/test/ai-chat/AIChat.test.tsx
```

Expected: FAIL because structured events, reconnect, durable cancel and server branching are not wired.

- [ ] **Step 5: Implement a serializable per-run UI reducer**

Store this state beside each assistant message, never inside its answer text:

```ts
type AgentRunEventState = {
  runId: string;
  threadId: string;
  protocol: "1.0" | "legacy-chat";
  lastEventId?: string;
  lastSequence: number;
  events: AgentEvent[];
  phase: "starting" | "planning" | "executing" | "validating" | "answering" | "waiting" | "completed" | "failed" | "cancelled";
  provisional: true;
  groundingStatus: "legacy_equivalence" | "insufficient_evidence";
  reconnectCount: number;
  error?: { code: string; safeMessage: string; retryable: boolean };
};
```

The reducer deduplicates by event ID/sequence, derives phase from public event types, caps retained progress events per tool attempt, and preserves terminal state. It never persists model reasoning or unvalidated candidate text.

- [ ] **Step 6: Refactor `runStream()` into request and event-consumption phases**

Keep the current composer, conversation list, voice input, slash menu, previews, text animator and independent `runDuplicateSearch()` function. Replace only the main-chat inline SSE parser:

```ts
const started = await startAgentRun(request);
let profile: "agent-v1" | "legacy-chat" = "agent-v1";
let cursor = conversation.runtimeCursor?.[started.runId];
for (;;) {
  try {
    const stream = await openAgentEvents({ runId: started.runId, profile, lastEventId: cursor?.lastEventId, signal });
    for await (const item of readAgentEventStream(stream)) {
      cursor = reduceAgentStreamItem(cursor, item);
      if (isAgentEvent(item) && item.type === "answer.delta") animator.push(item.payload.text);
      else dispatchTimelineItem(item);
      if (isTerminalItem(item)) break;
    }
    break;
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof AgentEventProtocolError && profile === "agent-v1") { profile = "legacy-chat"; continue; }
    if (error instanceof AgentApiError && error.code === "EVENT_HISTORY_EXPIRED") { await loadAuthoritativeSnapshot(error.snapshotUrl); break; }
    await waitForReconnectBackoff(cursor?.reconnectCount || 0, signal);
  }
}
```

Bound reconnect attempts to a configurable backoff and show a retry action after exhaustion; never create a second run. Preserve the existing `activeRequestRef` generation check around state writes.

- [ ] **Step 7: Implement the safe timeline and branch actions**

`AgentRunTimeline` maps known event types to fixed labels and selected allowlisted fields. It renders `legacy-provisional` and `legacy_equivalence` literally. `tool.failed` offers retry only when `retryable=true`; clarification renders a structured form. Final citations/limitations come from the stored thread snapshot/answer envelope.

Regenerate starts an explicit same-thread run branch from the authorized canonical checkpoint; edit calls the thread-fork API before sending. For edit, update the local conversation only after the server returns the child thread/version and keep the parent conversation intact/selectable. Both paths call checkpoint catch-up before accepting the branch.

- [ ] **Step 8: Add one browser-level recovery regression**

Configure the Playwright test with a controlled local fixture server. The test creates a run, receives two lifecycle events, forcibly closes the SSE connection, reconnects with `Last-Event-ID`, receives a duplicate plus the remaining events, and asserts one final answer with no duplicate characters. In the same test, switch to Duplicate Search mode and assert its request still goes only to `/api/duplicate-search`.

```bash
npx --no-install playwright test src/test/ai-chat/mainAgentRuntime.e2e.ts
```

- [ ] **Step 9: Run the complete front-end regression**

```bash
npm test -- \
  src/test/ai-chat/agentEventStream.test.ts \
  src/test/ai-chat/agentApi.test.ts \
  src/test/ai-chat/AgentRunTimeline.test.tsx \
  src/test/ai-chat/AIChat.test.tsx \
  src/test/ai-chat/DuplicateSearchResults.test.tsx \
  src/test/ai-chat/streamTextAnimator.test.ts
npx --no-install playwright test src/test/ai-chat/mainAgentRuntime.e2e.ts
```

Expected: PASS. Duplicate Search candidates, stagger animation, feedback, links, warmup, model selection and message-history behavior remain intact.

- [ ] **Step 10: Commit**

```bash
git add src/components/dashboard/chat/AgentRunTimeline.tsx src/components/dashboard/chat/MessageRenderer.tsx src/components/dashboard/pages/AIChat.tsx src/test/ai-chat/AgentRunTimeline.test.tsx src/test/ai-chat/AIChat.test.tsx src/test/ai-chat/mainAgentRuntime.e2e.ts playwright.config.ts
git commit -m "feat: render recoverable main agent runs"
```

### Task 19: Qualify Phase 1, document operations, and prove rollback

**Files:**
- Create: `evals/main-agent/schema/eval-case.schema.json`
- Create: `evals/main-agent/pr-smoke/phase1-runtime.jsonl`
- Create: `scripts/evaluateAgentRuntime.mjs`
- Create: `scripts/loadAgentRuntime.mjs`
- Create: `scripts/cleanupAgentRuntime.mjs`
- Create: `src/test/server/agentRuntime/qualification.test.ts`
- Create: `docs/main-agent-runtime/dependency-review.md`
- Create: `docs/main-agent-runtime/operations.md`
- Create: `.env.example`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `.gitignore`

- [ ] **Step 1: Write failing qualification-metadata tests**

```ts
// @vitest-environment node
import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("Phase 1 qualification assets", () => {
  const cases = fs.readFileSync("evals/main-agent/pr-smoke/phase1-runtime.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));
  it("contains exactly 60 versioned, unique smoke cases", () => {
    expect(cases).toHaveLength(60);
    expect(new Set(cases.map((item) => item.case_id)).size).toBe(60);
    expect(cases.every((item) => item.eval_schema_version === "1.0" && item.fixture_version && item.evaluator_version)).toBe(true);
  });
  it("does not claim Phase 2, Phase 3, or Action-gate certification", () => {
    expect(cases.every((item) => !["ontology_grounded", "test_case_draft", "octane_write"].includes(item.capability))).toBe(true);
  });
});
```

- [ ] **Step 2: Create the frozen 60-case PR smoke suite**

Define JSON Schema fields for case/version, language, request, actor scopes, model fixture, tool fixtures, injected fault, expected events, expected terminal, expected claims/tokens, forbidden tools and hard-gate assertions. Create exactly these deterministic groups:

| Case IDs | Count | Coverage |
|---|---:|---|
| `phase1-fact-001..020` | 20 | supported analytics questions, zero/missing/unknown, number/date/ID evidence |
| `phase1-policy-001..010` | 10 | both flag matrices, unknown tool/args, prompt injection, shadow Duplicate denial |
| `phase1-lifecycle-001..010` | 10 | clarification/resume/cancel/TTL/budget/idempotent message |
| `phase1-recovery-001..010` | 10 | journal-ahead, orphan checkpoint, stale lease, graph version, SSE replay |
| `phase1-isolation-001..010` | 10 | actor/thread/event/artifact/scope rotation |

Use Chinese for 42 cases, English for 12 and mixed Chinese/English for 6. All facts come from committed fake tool payloads; no real company credential or Octane production row is placed in the fixture.

- [ ] **Step 3: Implement the deterministic evaluator and release report**

`scripts/evaluateAgentRuntime.mjs` accepts:

```text
--suite <jsonl>
--mode legacy|shadow|langgraph
--model <registry-id|fake-certified>
--repeat <positive integer>
--fallback on|off
--qualification restart-resume|model-transcript|checkpoint-fencing|graph-version|scope-rotation|waiting-cancel-deadline|long-context|actor-isolation
--iterations <positive integer>
--scenarios <positive integer>
--concurrency <positive integer>
--output <json path>
```

It boots an isolated migrated Runtime DB, runs each case, consumes outbox events, and calculates hard gates separately from latency summaries. The report includes actual model ID/endpoint config version, graph/prompt/evaluator/fixture versions, Node/OS/CPU/memory, DB mode, cold/warm state and every failed case ID. It exits non-zero on any hard-gate failure.

Add package scripts:

```json
{
  "test:agent-runtime": "vitest run src/test/server/agentRuntime src/test/ai-chat/agentEventStream.test.ts src/test/ai-chat/agentApi.test.ts src/test/ai-chat/AgentRunTimeline.test.tsx",
  "eval:agent:smoke": "node scripts/evaluateAgentRuntime.mjs --suite evals/main-agent/pr-smoke/phase1-runtime.jsonl",
  "load:agent-runtime": "node scripts/loadAgentRuntime.mjs",
  "agent:runtime:cleanup": "node scripts/cleanupAgentRuntime.mjs"
}
```

- [ ] **Step 4: Encode deterministic Runtime qualification gates**

Run with fake certified models/tools so Runtime failures cannot be blamed on model variance. The scripts must support these exact minimum sample counts:

```bash
npm run eval:agent:smoke -- --mode langgraph --model fake-certified --repeat 3 --fallback off --output artifacts/qualification/pr-smoke.json
npm run test:agent-runtime
node scripts/evaluateAgentRuntime.mjs --suite evals/main-agent/pr-smoke/phase1-runtime.jsonl --qualification restart-resume --iterations 200 --output artifacts/qualification/restart-resume.json
node scripts/evaluateAgentRuntime.mjs --suite evals/main-agent/pr-smoke/phase1-runtime.jsonl --qualification model-transcript --iterations 200 --output artifacts/qualification/model-transcript.json
node scripts/evaluateAgentRuntime.mjs --suite evals/main-agent/pr-smoke/phase1-runtime.jsonl --qualification checkpoint-fencing --iterations 200 --output artifacts/qualification/checkpoint-fencing.json
node scripts/evaluateAgentRuntime.mjs --suite evals/main-agent/pr-smoke/phase1-runtime.jsonl --qualification graph-version --iterations 100 --output artifacts/qualification/graph-version.json
node scripts/evaluateAgentRuntime.mjs --suite evals/main-agent/pr-smoke/phase1-runtime.jsonl --qualification scope-rotation --iterations 100 --output artifacts/qualification/scope-rotation.json
node scripts/evaluateAgentRuntime.mjs --suite evals/main-agent/pr-smoke/phase1-runtime.jsonl --qualification waiting-cancel-deadline --iterations 200 --output artifacts/qualification/waiting-cancel-deadline.json
node scripts/evaluateAgentRuntime.mjs --suite evals/main-agent/pr-smoke/phase1-runtime.jsonl --qualification long-context --iterations 100 --output artifacts/qualification/long-context.json
node scripts/evaluateAgentRuntime.mjs --suite evals/main-agent/pr-smoke/phase1-runtime.jsonl --qualification actor-isolation --scenarios 100 --concurrency 20 --output artifacts/qualification/actor-isolation.json
```

Hard pass conditions are: tool-schema validity 100%; unsupported SQL/tools 0; deterministic number/date/ID accuracy 100%; zero/missing/unknown misclassification 0; evidence coverage at least 98%; unsupported important conclusions 0; answer bytes before final validation 0; cross-actor/thread leakage 0; one run per identical message ID; tool-call/result association errors 0; stale-lease/orphan/latest/wrong-graph recovery 0; old-scope plan/journal/evidence/event reuse 0; waiting cancel/TTL/deadline terminal misses 0; terminal event coverage 100%; restart recovery at least 99%.

- [ ] **Step 5: Build the measured 20-session load gate**

`scripts/loadAgentRuntime.mjs` starts with a five-minute warmup, then executes at least 500 iterations for each configured key path. It records lifecycle-event latency, model first-token latency per outbound call, tool latency, end-to-end latency, SQLite busy time, error rate and isolation violations. Run:

```bash
npm run load:agent-runtime -- \
  --base-url http://127.0.0.1:3004 \
  --concurrency 20 \
  --warmup-ms 300000 \
  --iterations-per-path 500 \
  --fixture evals/main-agent/pr-smoke/phase1-runtime.jsonl \
  --output artifacts/qualification/load.json
```

Pass thresholds: first lifecycle event P95 <=300 ms; one model invocation first token P95 <=5 s; one-tool completion P95 <=12 s; multi-tool completion P95 <=30 s; server errors <1%; zero actor/thread leakage; terminal event 100%. If SQLite locking prevents the gate, stop Phase 1 rollout and plan PostgreSQL; do not raise retries to hide it.

- [ ] **Step 6: Certify each enabled company model separately**

Against the same frozen suite, with fallback disabled, run each registry-enabled Bacon/DeepSeek/Qwen/GLM model three times:

```bash
npm run eval:agent:smoke -- --mode langgraph --model bacon --repeat 3 --fallback off --output artifacts/qualification/model-bacon.json
npm run eval:agent:smoke -- --mode langgraph --model deepseek-v4-flash --repeat 3 --fallback off --output artifacts/qualification/model-deepseek-v4-flash.json
npm run eval:agent:smoke -- --mode langgraph --model qwen3.5-397b-a17b --repeat 3 --fallback off --output artifacts/qualification/model-qwen.json
npm run eval:agent:smoke -- --mode langgraph --model glm-5 --repeat 3 --fallback off --output artifacts/qualification/model-glm.json
```

Skip and mark `not_configured`, rather than pass, any model absent from the server registry. Only a model that independently clears schema, safety, factual and tool-transcript hard gates may receive `planner_certified` or become a production fallback. Phase 1 reports neither Ontology grounding nor test-case-generation quality.

- [ ] **Step 7: Generate dependency, SBOM, vulnerability, and license evidence**

`docs/main-agent-runtime/dependency-review.md` records every new direct/transitive package, exact version, license, native-addon/build behavior, data-egress behavior and company approval status. It explicitly records MIT licenses for the pinned LangGraph/Ajv/better-sqlite3 packages, the LangSmith client transitively present through `@langchain/core`, external tracing disabled by default, and Node 24/Linux native-addon verification.

Run on the company network and retain outputs outside Git when they contain internal registry metadata:

```bash
npm ci
npm ls --all > artifacts/qualification/npm-tree.txt
npm sbom --sbom-format cyclonedx > artifacts/qualification/sbom.cdx.json
npm audit --omit=dev --json > artifacts/qualification/npm-audit.json
```

The release checklist requires internal open-source approval and vulnerability scan sign-off; `npm audit` alone is not treated as company approval. Production startup is tested with outbound public internet blocked.

- [ ] **Step 8: Document safe local operations and rollback**

Create `.env.example` with names and safe defaults only: Runtime mode, loopback hosts, trusted identity mode/proxy headers, origin allowlist, model records, DB/artifact paths, budgets/retention and log level. Put no token, access code, cookie or real endpoint secret in it.

`docs/main-agent-runtime/operations.md` and README document:

- Node 24.14.0 and npm as the authoritative package manager;
- offline migration/check commands, backup/restore verification, Runtime DB/artifact permissions and one-Node-instance SQLite restriction;
- the three-process local topology, liveness/readiness, graceful shutdown and log fields;
- loopback-only DEV identity; trusted reverse proxy + TLS + origin allowlist before LAN access;
- `MAIN_AGENT_RUNTIME_MODE=legacy` rollback and confirmation that Duplicate Search remains independent;
- event/artifact/thread retention cleanup and audit fields;
- no PostgreSQL, systemd/container manifest, Octane write, approval endpoint, Python Ontology or TestAgent delivery in Phase 1.

`scripts/cleanupAgentRuntime.mjs` is an offline-only command with `--db-path`, `--dry-run`, `--as-of` and `--manifest` arguments. It refuses a live singleton guard, uses database time, applies configured retention, deletes audit rows only after 365 days, and writes pre/post counts plus hashes to the manifest before vacuuming. The normal Runtime/audit API exposes no record mutation or deletion method.

Add `.env.local`, `artifacts/qualification/` and Runtime SQLite WAL/SHM/artifact contents to `.gitignore`, while preserving only `database/runtime/.gitkeep`. Keep the currently tracked `.env` free of secrets; Runtime/model credentials live only in ignored local env or the deployment secret manager.

- [ ] **Step 9: Run the final automated regression in Node 24**

```bash
node scripts/ensureNodeVersion.mjs
npm ci
npm ls --depth=0
npm test
npx --no-install playwright test src/test/ai-chat/mainAgentRuntime.e2e.ts
python -m pytest backend/tests -q
npm run build
npx eslint \
  server/agentRuntime \
  server/app.mjs \
  server/index.mjs \
  scripts/evaluateAgentRuntime.mjs \
  scripts/loadAgentRuntime.mjs \
  scripts/cleanupAgentRuntime.mjs \
  src/lib/agentEventStream.ts \
  src/lib/agentApi.ts \
  src/components/dashboard/chat/AgentRunTimeline.tsx \
  src/components/dashboard/chat/MessageRenderer.tsx \
  src/components/dashboard/pages/AIChat.tsx
```

Expected: every command exits 0. If full `npm run lint` still reports unrelated pre-existing dashboard errors, record their exact unchanged baseline separately; no changed Runtime/AIChat file may add an ESLint error. Run the focused six-file 46-test baseline and the Duplicate Search regression once more before rollout.

- [ ] **Step 10: Perform the manual rollback drill**

1. Start in `langgraph`, create one analytics run, disconnect/reconnect SSE, and verify one answer/terminal event.
2. Restart Node mid-tool, verify the same run recovers without a second tool call.
3. Set `MAIN_AGENT_RUNTIME_MODE=legacy`, restart Node, and verify `/api/ai/chat` plus `/api/chat` return the current legacy SSE.
4. Use the independent Duplicate Search mode and verify warmup/search/feedback still work.
5. Re-enable `langgraph` only after Runtime/model/load reports meet their separate gates.

- [ ] **Step 11: Commit**

```bash
git add evals/main-agent/schema/eval-case.schema.json evals/main-agent/pr-smoke/phase1-runtime.jsonl scripts/evaluateAgentRuntime.mjs scripts/loadAgentRuntime.mjs scripts/cleanupAgentRuntime.mjs src/test/server/agentRuntime/qualification.test.ts docs/main-agent-runtime/dependency-review.md docs/main-agent-runtime/operations.md .env.example README.md .gitignore package.json package-lock.json
git commit -m "test: qualify main agent runtime phase one"
```

## Phase 1 specification traceability

| Approved requirement | Implementation task | Primary proof |
|---|---:|---|
| Exact Node 24/LangGraph/SQLite/Ajv versions, npm reproducibility | 1 | dependency contract, `npm ci`, build |
| JSON Schema 2020-12 contracts and protocol envelopes | 2 | run/route/model/evidence/event schema tests |
| Single server registry; Bacon/DeepSeek/Qwen/GLM explicit capabilities; no secret/public fallback | 3 | registry and legacy-boundary tests |
| Tool-call transcript fidelity, cancellation, timeout, structured output, reasoning stripping | 4 | adapter byte-stream/retry/dialect tests |
| Loopback DEV identity or trusted TLS proxy, full ActorContext, CORS/body limits | 5, 15 | config/identity/HTTP/API tests |
| Separate Runtime DB, WAL/FK/5s timeout, offline app+Saver migration, one instance | 6 | migration/check/singleton tests |
| Server IDs, request idempotency, thread/state versions, lease, interaction TTL and branch provenance | 7, 14 | lifecycle/runtime/reaper tests |
| Transactional, fenced, replayable event outbox; terminal uniqueness; legacy/new profile exclusivity | 8 | event transaction/replay/SSE tests |
| External-boundary journal, durable model turns, canonical candidate CAS, recovery catch-up | 9, 14 | journal/checkpoint/recovery chaos tests |
| Content-addressed artifacts, ACL, MIME, 8/20/200 MiB and 5-item limits, safe extraction | 10, 17 | artifact/quota/worker/AIChat tests |
| Independent request flags and exact Duplicate adapter; no SQL/write/shell/network tools | 11 | policy matrix, tool registry and existing bridge regression |
| `legacy-v0`, zero/missing/unknown, similarity-only Duplicate evidence, claim/render gate | 12 | evidence/claim/answer tests |
| Explicit StateGraph/reducers/interrupt/compaction; no ReAct or Python Ontology bypass | 13 | graph/resume/serialization tests |
| Run admission, cancel, reconnect-not-cancel, recovery, budgets and scope refresh | 14 | runtime limits/cancel/recovery/audit tests |
| Default legacy, shadow isolation, allowlisted langgraph, complete route set and rollback facade | 15 | runtime-mode/API/legacy regression tests |
| Strict browser SSE decoder, cursor/offset validation, typed API facade | 16 | pure decoder/client tests |
| One-time stable local history import, server model discovery and artifact refs | 17 | AIChat import/model/attachment tests |
| Timeline without CoT, same-run reconnect/profile fallback, durable stop and edit/fork semantics | 18 | component/integration/Playwright tests |
| Runtime/model/load gates, observability, audit, SBOM/license/vulnerability/operations evidence | 19 | 60-case smoke, qualification/load reports and rollback drill |
| Phase 2 Ontology, Phase 3 test drafts and Phase 4 write/deploy work remain unclaimed | all | fixture capability exclusion, no approval route/write tool/Python changes |

## Final acceptance checklist

- [ ] Every Phase 1 route, Runtime mode and event profile has a passing authorization/contract test.
- [ ] Every model/tool boundary refreshes actor scope, carries cancellation and is protected by journal + stateVersion + leaseEpoch fencing.
- [ ] Canonical checkpoint catch-up is proven at new-message, resume, fork and recovery boundaries; Saver latest/orphans are never authoritative.
- [ ] Phase 1 events and UI say `legacy-provisional` / `legacy_equivalence`; no code path emits `grounded`.
- [ ] All digits, dates and IDs in the final answer are supported by accepted claims and same-run evidence; zero/missing/unknown remain distinct.
- [ ] No answer bytes are emitted before render validation and final-answer persistence.
- [ ] Duplicate Search internals and dedicated UI flow are unchanged, and `useDefectContext=false` makes its Runtime call count zero.
- [ ] Same message retry creates one run; every run has exactly one terminal event; cancelled/expired/stale workers cannot commit late results.
- [ ] AI Chat reconnects the same run, imports local history once, sends artifact refs, and branches edit/regenerate without mutating old checkpoints.
- [ ] Runtime, model, isolation, recovery, load, dependency/license/SBOM and rollback evidence are recorded separately; Phase 2/3/4 capabilities are not claimed.
