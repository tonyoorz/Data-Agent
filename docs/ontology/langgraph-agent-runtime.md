# LangGraph Agent Runtime

Vizion Lab uses the LangGraph runtime as the default internal AI Chat path. The legacy tool loop is still available as an explicit fallback, but new agent orchestration should be added through the LangGraph graph boundary.

## Runtime Mode

```powershell
npm run dev:server
```

Supported values:

- `langgraph`: default; uses `server/agentRuntime/langGraphChatRuntime.mjs` to orchestrate context resolution, tool routing, tool planning, and final streaming inputs.
- `legacy`: explicit fallback; uses the existing `mainAgentToolLoop` directly from `server/index.mjs`.

Unknown or empty values fall back to `langgraph`.

To force the legacy path during rollback testing:

```powershell
$env:VIZION_AGENT_RUNTIME = "legacy"
npm run dev:server
```

## Architecture

```text
AI Chat request
  -> Node chat gateway
  -> LangGraph runtime shell
  -> initialize node
  -> analytics / defect context node
  -> tool routing node
  -> tool-call planning node
  -> tool-call execution node
  -> conditional continue/finalize routing
  -> existing streaming chat completion
```

The runtime intentionally reuses the existing tool/data layer:

- `server/mainAgentTools.mjs` remains the tool registry and executor.
- `server/mainAgentToolPlanning.mjs` owns shared tool selection, planning prompt context, policy-gated execution helpers, and empty-result diagnosis helpers used by LangGraph and the compatibility adapter.
- `server/mainAgentToolLoop.mjs` remains only as the legacy compatibility bounded tool-planning loop used by the explicit `VIZION_AGENT_RUNTIME=legacy` fallback.
- `server/mainAgentIntentRouter.mjs` and `server/mainAgentToolsets.mjs` define compact intent profiles and allowed toolsets used by the LangGraph routing node.
- `/api/semantic/query` remains the ontology-governed semantic data plane.
- `/api/ontology/context` remains the testcase-context path.

## Migration Scope

The current migration makes the graph boundary the default runtime and keeps the existing data/tool layer as the execution substrate:

- LangGraph `StateGraph` for orchestration.
- Explicit graph nodes: `initialize`, `resolve_context`, `route_tools`, `plan_tool_calls`, `execute_tool_calls`, `finalize`.
- Conditional graph edges skip tool planning when routing says tools are not needed, stop when the model produces no tool calls, continue after tool execution, and finalize on `max_steps`, policy blocks, or clarification requests.
- In-process `MemorySaver` checkpointing.
- Explicit `threadId` support from `body.threadId`, `body.conversationId`, or `body.sessionId`; AI Chat sends its persisted conversation ID so semantic continuations remain in one graph thread.
- Explicit `runId` support from `body.runId`, with generated IDs when omitted.
- Server-owned internal `actorScope` persistence; browser-supplied actor fields are not trusted by the gateway.
- Runtime SSE events emitted as `agent-runtime-event`.
- Tool routing state emitted as `tool-routing-completed` and included in runtime metrics.
- Empty `query_analytics` aggregate results automatically invoke `diagnose_analytics_empty` when the selected toolset allows it.
- File-backed runtime audit store under `logs/agent-runtime` by default.
- JSON thread snapshots in `threads/<thread>.json`; these are audit/resume hints, not LangGraph-compatible durable checkpoints.
- JSONL run event audit in `run-events.jsonl`.
- JSONL tool-call audit in `tool-calls.jsonl`.
- Explicit feature-flag fallback to the legacy compatibility runtime.

The store location can be overridden:

```powershell
$env:VIZION_AGENT_RUNTIME_STORE_DIR = "D:\vizion-agent-runtime"
```

## Internal Deployment Principal

The current LAN deployment uses one server-owned principal rather than a user/RBAC subsystem. Agent-only defect routes require this principal to carry at least one team, project, or workspace row scope. `npm run dev` supplies `DTSV_China` plus the read-only `agent.operations.read` policy only for its trusted local bootstrap; shared deployments must configure both scopes explicitly. Environment variables define that principal:

```powershell
$env:VIZION_INTERNAL_ACTOR_ID = "vizion-internal"
$env:VIZION_INTERNAL_WORKSPACE_IDS = "workspace-a,workspace-b"
$env:VIZION_INTERNAL_PROJECT_IDS = "project-a"
$env:VIZION_INTERNAL_TEAM_IDS = "DTSV_China"
$env:VIZION_INTERNAL_ALLOWED_OBJECT_TYPES = "quality.defect,testing.test_case,testing.test_run,requirements.aida_node"
$env:VIZION_INTERNAL_ALLOWED_PROPERTY_IDS = ""
$env:VIZION_INTERNAL_ROW_POLICY_IDS = "agent.operations.read"
$env:VIZION_INTERNAL_SENSITIVE_FIELD_POLICY_IDS = ""
```

The gateway derives `scopeHash` from this server configuration. A later authenticated multi-user deployment can replace this principal at the same actor-scope boundary without changing the Semantic Kernel or tool contracts.

## Production Follow-Up

For multi-user intranet production, the next hardening step is to replace the in-process checkpointer and file-backed audit store with database-backed persistence:

- durable LangGraph checkpoint backend instead of in-process `MemorySaver`
- indexed thread/run/tool audit tables
- evidence references
- actor scope from authenticated user identity instead of the shared internal principal
- cancel/retry state
- retention and cleanup policy for audit records

Keep the ontology layer as the business semantic contract; LangGraph should orchestrate tools, not redefine metrics or policies.
