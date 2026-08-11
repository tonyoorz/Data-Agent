# Trusted Closure P0.0 Local Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fail closed when the local service lacks a server-owned tenant scope, and restrict the local Node API to loopback HTTP requests with explicit Host, Origin, and JSON content-type validation.

**Architecture:** Keep the Node API loopback-only. A small pure `localHttpBoundary` module decides listen host, request admission, and CORS headers so it can be tested without importing the long-running server. `internalActorScope` stops manufacturing object permissions; LangGraph detects the missing tenant scope before resolving analytics context or exposing data tools, then returns a deterministic unavailable response for data questions.

**Tech Stack:** Node.js ESM, LangGraph, Vitest, existing Vite proxy.

---

## Task 1: Lock Down the Pure Boundary Contract

**Files:**

- Create: `src/test/server/localHttpBoundary.test.ts`
- Modify: `src/test/server/internalActorScope.test.ts`
- Modify: `src/test/server/agentRuntime/langGraphChatRuntime.test.ts`

- [x] **Step 1: Write the failing HTTP boundary tests**

```ts
import { createLocalHttpBoundary, resolveLocalListenHost } from "../../../server/localHttpBoundary.mjs";

it("binds to loopback and admits an allowlisted local JSON request", () => {
  const boundary = createLocalHttpBoundary({});
  expect(resolveLocalListenHost({})).toBe("127.0.0.1");
  expect(boundary.evaluate({
    method: "POST",
    headers: {
      host: "127.0.0.1:3004",
      origin: "http://localhost:8080",
      "content-type": "application/json; charset=utf-8",
    },
  })).toEqual(expect.objectContaining({ allowed: true, corsOrigin: "http://localhost:8080" }));
});

it("rejects non-loopback bind hosts, untrusted hosts and origins, and non-JSON POSTs", () => {
  expect(() => resolveLocalListenHost({ VIZION_API_HOST: "0.0.0.0" })).toThrow("VIZION_LISTEN_HOST_NOT_LOOPBACK");
  const boundary = createLocalHttpBoundary({});
  expect(boundary.evaluate({ method: "GET", headers: { host: "evil.example" } })).toMatchObject({ allowed: false, statusCode: 421, code: "HTTP_HOST_NOT_ALLOWED" });
  expect(boundary.evaluate({ method: "GET", headers: { host: "localhost:3004", origin: "https://evil.example" } })).toMatchObject({ allowed: false, statusCode: 403, code: "HTTP_ORIGIN_NOT_ALLOWED" });
  expect(boundary.evaluate({ method: "POST", headers: { host: "localhost:3004", "content-type": "text/plain" } })).toMatchObject({ allowed: false, statusCode: 415, code: "HTTP_JSON_CONTENT_TYPE_REQUIRED" });
});
```

- [x] **Step 2: Write the failing actor-scope test**

```ts
import { isAnalyticsActorScopeConfigured, withInternalActorScope } from "../../../server/internalActorScope.mjs";

it("does not grant analytics access when deployment scope is absent", () => {
  const body = withInternalActorScope({ messages: [] }, {});
  expect(body.actor.scopes).toEqual({});
  expect(isAnalyticsActorScopeConfigured(body.actor)).toBe(false);
});
```

- [x] **Step 3: Write the failing LangGraph admission test**

```ts
it("does not resolve data context or plan tools without a tenant-scoped actor", async () => {
  const resolveAnalyticsContext = vi.fn();
  const requestToolCompletion = vi.fn();
  const runtime = createLangGraphChatRuntime({ resolveAnalyticsContext, requestToolCompletion, shouldPlanTools: vi.fn().mockReturnValue(true) });

  const result = await runtime.invoke({
    body: { useAnalyticsContext: true, actor: { actorId: "internal", scopeHash: "scope" }, messages: [{ role: "user", content: "DTSV 有多少缺陷？" }] },
  });

  expect(result.directResponse).toEqual(expect.objectContaining({ intent: "data_access_unavailable" }));
  expect(resolveAnalyticsContext).not.toHaveBeenCalled();
  expect(requestToolCompletion).not.toHaveBeenCalled();
});
```

- [x] **Step 4: Run the focused tests and confirm RED**

Run:

```powershell
npm test -- --run src/test/server/localHttpBoundary.test.ts src/test/server/internalActorScope.test.ts src/test/server/agentRuntime/langGraphChatRuntime.test.ts
```

Expected: imports fail for `localHttpBoundary` and `isAnalyticsActorScopeConfigured`, and the LangGraph admission expectation fails because the runtime currently plans tools without a tenant scope.

## Task 2: Implement Local HTTP Admission

**Files:**

- Create: `server/localHttpBoundary.mjs`
- Modify: `server/index.mjs`
- Test: `src/test/server/localHttpBoundary.test.ts`

- [x] **Step 1: Add the pure loopback boundary module**

```js
export function resolveLocalListenHost(env = process.env) {
  const host = String(env?.VIZION_API_HOST || "127.0.0.1").trim();
  if (!isLoopbackHost(host)) throw new Error("VIZION_LISTEN_HOST_NOT_LOOPBACK");
  return host;
}

export function createLocalHttpBoundary(env = process.env) {
  return Object.freeze({
    listenHost: resolveLocalListenHost(env),
    evaluate({ method, headers = {} } = {}) {
      // Return { allowed, statusCode, code, corsOrigin } without writing a response.
    },
  });
}
```

The implementation accepts loopback `Host` headers and same-loopback origins by default, accepts explicitly configured trusted hosts/origins, accepts `application/json` with optional parameters on every POST, and never emits wildcard CORS.

- [x] **Step 2: Wire the boundary before routing in `server/index.mjs`**

```js
const localHttpBoundary = createLocalHttpBoundary(process.env);

const server = http.createServer(async (request, response) => {
  const admission = localHttpBoundary.evaluate({ method: request.method, headers: request.headers });
  if (!admission.allowed) {
    sendJson(response, admission.statusCode, { success: false, error: admission.code });
    return;
  }
  if (admission.corsOrigin) response.setHeader("Access-Control-Allow-Origin", admission.corsOrigin);
  // Keep endpoint routing below this admission check.
});

server.listen(port, localHttpBoundary.listenHost, () => {
  console.log(`Vizion local API listening on http://${localHttpBoundary.listenHost}:${port}`);
});
```

For an admitted OPTIONS preflight, return only the admitted origin, `content-type, authorization`, and `GET,POST,OPTIONS`.

- [x] **Step 3: Run the HTTP-focused tests and confirm GREEN**

Run:

```powershell
npm test -- --run src/test/server/localHttpBoundary.test.ts src/test/server/httpRequestUrl.test.ts
```

Expected: all tests pass.

## Task 3: Make Analytics Data Access Fail Closed

**Files:**

- Modify: `server/internalActorScope.mjs`
- Modify: `server/mainAgentDirectIntent.mjs`
- Modify: `server/agentRuntime/langGraphChatRuntime.mjs`
- Modify: `src/test/server/internalActorScope.test.ts`
- Modify: `src/test/server/agentRuntime/langGraphChatRuntime.test.ts`

- [x] **Step 1: Remove the implicit object allowlist and expose scope readiness**

```js
export function isAnalyticsActorScopeConfigured(actor) {
  const scopes = actor?.scopes || {};
  const hasObjects = Array.isArray(scopes.allowedObjectTypes) && scopes.allowedObjectTypes.length > 0;
  const hasTenant = ["workspaceIds", "teamIds", "projectIds"].some((key) => Array.isArray(scopes[key]) && scopes[key].length > 0);
  return Boolean(String(actor?.actorId || "").trim() && String(actor?.scopeHash || "").trim() && hasObjects && hasTenant);
}
```

`resolveInternalActorScope({})` must retain a stable server-owned actor ID and hash but return empty scopes; it must not manufacture `allowedObjectTypes`.

- [x] **Step 2: Add an explicit data-access-unavailable direct response**

```js
export function buildDataAccessUnavailableResponse() {
  const profile = DIRECT_MAIN_AGENT_INTENT_PROFILES.data_access_unavailable;
  return { intent: "data_access_unavailable", content: profile.responseTemplate, ...profile };
}
```

The response must explain that a server-owned workspace/team/project scope is required and must not claim that data is empty.

- [x] **Step 3: Stop analytics context and tool planning before any data access**

```js
const actorScopeConfigured = isAnalyticsActorScopeConfigured(state.actorScope);
if (body?.useAnalyticsContext === true && !actorScopeConfigured) {
  return { analyticsContext: { contextText: "# Governed data access\nStatus: BLOCKED", skipDefectContext: true }, ... };
}
```

In `routeTools`, return `buildDataAccessUnavailableResponse()` for a tool-eligible analytics request whose actor scope is not configured. Existing analytics runtime tests must supply `allowedObjectTypes` and one tenant scope.

- [x] **Step 4: Run the admission and runtime tests and confirm GREEN**

Run:

```powershell
npm test -- --run src/test/server/localHttpBoundary.test.ts src/test/server/internalActorScope.test.ts src/test/server/agentRuntime/langGraphChatRuntime.test.ts
```

Expected: missing deployment scope cannot resolve analytics context or invoke a data tool; configured tenant scope retains the existing tool flow.

## Task 4: Verify the P0.0 Slice

**Files:**

- Test: `src/test/server/localHttpBoundary.test.ts`
- Test: `src/test/server/internalActorScope.test.ts`
- Test: `src/test/server/agentRuntime/langGraphChatRuntime.test.ts`

- [x] **Step 1: Run the semantic and agent regression slice**

Run:

```powershell
npm test -- --run src/test/server/localHttpBoundary.test.ts src/test/server/httpRequestUrl.test.ts src/test/server/internalActorScope.test.ts src/test/server/agentRuntime/langGraphChatRuntime.test.ts src/test/server/mainAgentTools.test.ts src/test/server/semanticAnalysisClosure.e2e.test.ts
```

Expected: all focused Node tests pass.

- [x] **Step 2: Run source diagnostics and inspect the worktree diff**

Run:

```powershell
npm run lint -- --quiet
git diff --check
git status --short
```

Expected: no lint errors in changed source files, no whitespace errors, and only the P0.0 source, test, and plan files are modified.

### Scope Boundaries

- Do not permit remote listening; a remote deployment must place an authenticated gateway in front of this loopback service.
- Do not treat `rowPolicyIds` as enforced until a backend row-policy consumer applies it to rows.
- Do not change model prompts, tool catalogs, SemanticFrame compilation, pagination, or Claim publication in this slice.
- Do not repair the unrelated duplicate bridge timeout test; its isolated run passes and it remains a timing-sensitive baseline risk.
