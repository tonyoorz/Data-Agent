# LangGraph Agent Runtime

Vizion Lab now has an optional LangGraph runtime shell for the internal AI Chat path. The default runtime remains the existing legacy tool loop unless explicitly enabled.

## Runtime Mode

```powershell
$env:VIZION_AGENT_RUNTIME = "langgraph"
npm run dev:server
```

Supported values:

- `legacy`: default; uses the existing `mainAgentToolLoop` directly from `server/index.mjs`.
- `langgraph`: uses `server/agentRuntime/langGraphChatRuntime.mjs` to orchestrate context resolution, tool planning, and final streaming inputs.

Unknown values fall back to `legacy`.

## Architecture

```text
AI Chat request
  -> Node chat gateway
  -> LangGraph runtime shell
  -> analytics / defect context nodes
  -> existing main-agent tool loop node
  -> existing streaming chat completion
```

The runtime intentionally reuses the existing tool/data layer:

- `server/mainAgentTools.mjs` remains the tool registry and executor.
- `server/mainAgentToolLoop.mjs` remains the bounded tool-planning loop.
- `/api/semantic/query` remains the ontology-governed semantic data plane.
- `/api/ontology/context` remains the testcase-context path.

## First-Cut Scope

The first cut adds a standard graph boundary without changing business answers:

- LangGraph `StateGraph` for orchestration.
- In-process `MemorySaver` checkpointing.
- Explicit `threadId` support from `body.threadId`, `body.conversationId`, or `body.sessionId`.
- Explicit `runId` support from `body.runId`, with generated IDs when omitted.
- `actorScope` persistence from `body.actor` or `body.actorScope`.
- Runtime SSE events emitted as `agent-runtime-event`.
- File-backed durable runtime store under `logs/agent-runtime` by default.
- Durable JSON thread checkpoints in `threads/<thread>.json`.
- JSONL run event audit in `run-events.jsonl`.
- JSONL tool-call audit in `tool-calls.jsonl`.
- Feature-flag fallback to legacy runtime.

The store location can be overridden:

```powershell
$env:VIZION_AGENT_RUNTIME_STORE_DIR = "D:\vizion-agent-runtime"
```

## Production Follow-Up

For multi-user intranet production, the next hardening step is to replace the file-backed store with database tables or a LangGraph-compatible durable checkpointer:

- durable LangGraph checkpoint backend instead of in-process `MemorySaver`
- indexed thread/run/tool audit tables
- evidence references
- actor scope from authenticated user identity rather than client-supplied payload only
- cancel/retry state
- retention and cleanup policy for audit records

Keep the ontology layer as the business semantic contract; LangGraph should orchestrate tools, not redefine metrics or policies.