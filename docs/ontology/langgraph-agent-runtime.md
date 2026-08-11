# LangGraph Agent Runtime

Vizion Lab uses one LangGraph runtime for the internal AI Chat path. New agent orchestration must be added through this graph boundary so actor scope, evidence validation, and terminal audit share one production contract.

## Runtime Mode

```powershell
npm run dev:server
```

Supported value:

- `langgraph`: default; uses `server/agentRuntime/langGraphChatRuntime.mjs` to orchestrate context resolution, tool routing, tool planning, and final streaming inputs.
`legacy`, unknown, and empty values normalize to `langgraph`. `server/index.mjs` contains no alternate legacy chat branch; rollback changes must preserve the same governed runtime boundary.

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
- `server/mainAgentToolLoop.mjs` remains a direct test/development harness adapter and is not a server-entry runtime.
- `server/mainAgentIntentRouter.mjs` and `server/mainAgentToolsets.mjs` define compact intent profiles and allowed toolsets used by the LangGraph routing node.
- `/api/semantic/query` remains the ontology-governed semantic data plane.
- `/api/ontology/context` remains the testcase-context path.

## Migration Scope

The current migration makes the graph boundary the default runtime and keeps the existing data/tool layer as the execution substrate:

- LangGraph `StateGraph` for orchestration.
- Explicit graph nodes: `initialize`, `resolve_context`, `route_tools`, `plan_tool_calls`, `execute_tool_calls`, `finalize`.
- Conditional graph edges skip tool planning when routing says tools are not needed, stop when the model produces no tool calls, continue after tool execution, and finalize on `max_steps`, policy blocks, or clarification requests.
- In-process `MemorySaver` checkpointing with an actor/scope-bound internal thread key.
- Explicit client conversation identifiers from `body.threadId`, `body.conversationId`, or `body.sessionId`; raw values are not used as cross-actor checkpoint keys or persisted audit identifiers.
- Explicit `runId` support from `body.runId`, with generated IDs when omitted; the audit store persists only a scope-bound opaque run reference.
- Server-resolved actor scope from the internal local principal or verified OIDC identity; browser-supplied actor fields are removed by the gateway.
- Runtime SSE events emitted as `agent-runtime-event`.
- Tool routing state emitted as `tool-routing-completed` and included in runtime metrics.
- Empty `query_analytics` aggregate results automatically invoke `diagnose_analytics_empty` when the selected toolset allows it.
- File-backed runtime audit store under `logs/agent-runtime` by default.
- JSON thread snapshots in `threads/<thread>.json`; these are audit/resume hints, not LangGraph-compatible durable checkpoints.
- JSONL run event audit in `run-events.jsonl`.
- JSONL tool-call audit in `tool-calls.jsonl`.
- One server-entry runtime; unsupported or historical runtime flags normalize to LangGraph.

The store location can be overridden:

```powershell
$env:VIZION_AGENT_RUNTIME_STORE_DIR = "D:\vizion-agent-runtime"
```

## Authentication and Actor Scope

`internal` mode is limited to local development or a trusted single-user machine. Agent-only defect routes require this principal to carry at least one team, project, or workspace row scope. `npm run dev` supplies `DTSV_China` plus the read-only `agent.operations.read` policy for this local bootstrap. Environment variables can override that local principal:

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

Shared and production deployments use `VIZION_AGENT_AUTH_MODE=oidc`. Node requires `sub` and `exp`, then verifies issuer, audience, signature, and temporal validity through the configured HTTPS JWKS endpoint before mapping `sub` and `groups[]` to one unambiguous server-owned scope grant. It strips all client-supplied actor fields, signs a short-lived actor capability for Agent-only FastAPI calls, and derives actor-scoped thread/run references. Missing identity, ambiguous grants, cross-scope continuation, missing capability, and internal-only tools fail closed.

See [README.md](../../README.md#governed-agent-deployment) for the contract and the [pre-production release runbook](../deployment/preproduction-agent-release.md) for gateway routing, identity validation, and rollout gates.

## Production Follow-Up

Remaining production engineering and operational work must preserve OIDC actor scope rather than return to a shared principal:

- durable LangGraph checkpoint backend instead of in-process `MemorySaver`
- indexed thread/run/tool audit tables
- encrypted centralized evidence/audit retention with the existing scope-bound identifiers
- deployment-specific sign-in/session bootstrap and IdP lifecycle validation
- OpenTelemetry/SLO integration and live production-snapshot evaluation
- durable cancel/retry state and compatibility-tested migrations

Keep the ontology layer as the business semantic contract; LangGraph should orchestrate tools, not redefine metrics or policies.
