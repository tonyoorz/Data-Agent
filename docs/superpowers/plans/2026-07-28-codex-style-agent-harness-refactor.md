# Codex-Style Agent Harness Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace scattered main-agent tool routing and legacy runtime fallback with a Codex-inspired harness boundary: registry, orchestrator, turn events, and one LangGraph runtime path.

**Architecture:** `mainAgentToolRegistry` becomes the source of truth for tool metadata, intent profiles, planning triggers, and policy hints. `mainAgentToolOrchestrator` owns model-planned tool execution, allow-policy validation, evidence capture, empty-result diagnosis, and standard turn events. `langGraphChatRuntime` and the direct harness entry both call the same orchestrator, while the server entry removes the legacy runtime branch.

**Tech Stack:** Node ESM modules, Vitest, LangGraph, existing `MAIN_AGENT_TOOLS` OpenAI-style function specs.

---

### Task 1: Registry As Source Of Truth

**Files:**
- Create: `server/mainAgentToolRegistry.mjs`
- Modify: `server/mainAgentIntentRouter.mjs`
- Modify: `server/mainAgentToolsets.mjs`
- Test: `src/test/server/mainAgentToolRegistry.test.ts`

- [x] **Step 1: Write failing registry tests**

```ts
import { describe, expect, it } from "vitest";
import { MAIN_AGENT_TOOLS } from "../../../server/mainAgentTools.mjs";
import {
  createMainAgentToolRegistry,
  selectMainAgentToolset,
  shouldPlanMainAgentTools,
} from "../../../server/mainAgentToolRegistry.mjs";

describe("main agent tool registry", () => {
  it("derives compact toolsets from tool metadata", () => {
    const registry = createMainAgentToolRegistry(MAIN_AGENT_TOOLS);
    const selected = registry.selectToolset([{ role: "user", content: "Octane defect 字段能不能更新？能不能删除缺陷单？" }]);

    expect(selected.intent).toBe("action_capability");
    expect(selected.toolNames).toEqual(["get_ontology_catalog", "search_octane_fields", "ask_clarification"]);
    expect(selected.tools.map((tool) => tool.function.name)).toEqual(selected.toolNames);
    expect(registry.validateToolCall({ function: { name: "query_analytics" } }, selected)).toEqual(
      expect.objectContaining({ allowed: false, reason: expect.stringContaining("not allowed") }),
    );
  });

  it("uses one routing source for planning trigger and selected intent", () => {
    const messages = [{ role: "user", content: "DTSV 当前风险怎么看？" }];

    expect(shouldPlanMainAgentTools(messages)).toBe(true);
    expect(selectMainAgentToolset(messages).intent).toBe("general");
  });
});
```

- [x] **Step 2: Run registry tests and confirm red**

Run: `npx vitest run src/test/server/mainAgentToolRegistry.test.ts`
Expected: FAIL because `server/mainAgentToolRegistry.mjs` does not exist.

- [x] **Step 3: Implement registry**

Create `server/mainAgentToolRegistry.mjs` with exported `MAIN_AGENT_INTENT_PROFILES`, `MAIN_AGENT_TOOL_POLICIES`, `createMainAgentToolRegistry`, `selectMainAgentToolset`, `shouldPlanMainAgentTools`, `buildSelectedToolsetContext`, `validateToolCallAllowed`, and `buildBlockedToolResult`. Move intent tool names out of `mainAgentToolsets.mjs` and intent regex out of `mainAgentIntentRouter.mjs` into registry-owned metadata.

- [x] **Step 4: Preserve compatibility exports without owning behavior**

Update `server/mainAgentIntentRouter.mjs` and `server/mainAgentToolsets.mjs` to delegate to the registry exports only. They must not contain independent intent/toolset rules.

- [x] **Step 5: Run registry and existing loop tests**

Run: `npx vitest run src/test/server/mainAgentToolRegistry.test.ts src/test/server/mainAgentToolLoop.test.ts`
Expected: PASS.

### Task 2: Central Tool Orchestrator

**Files:**
- Create: `server/mainAgentToolOrchestrator.mjs`
- Modify: `server/mainAgentToolPlanning.mjs`
- Modify: `server/mainAgentToolLoop.mjs`
- Test: `src/test/server/mainAgentToolOrchestrator.test.ts`

- [x] **Step 1: Write failing orchestrator tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { runMainAgentToolTurn } from "../../../server/mainAgentToolOrchestrator.mjs";

describe("main agent tool orchestrator", () => {
  it("emits standard turn and tool lifecycle events", async () => {
    const toolCall = { id: "call-1", type: "function", function: { name: "query_analytics", arguments: "{}" } };
    const requestToolCompletion = vi.fn()
      .mockResolvedValueOnce({ content: "", toolCalls: [toolCall] })
      .mockResolvedValueOnce({ content: "done", toolCalls: [] });
    const executeToolCall = vi.fn().mockResolvedValue({
      toolMessage: { role: "tool", tool_call_id: "call-1", name: "query_analytics", content: "{}" },
      contextText: "# Main agent tool result\nTool: query_analytics\nResult: 1",
    });

    const result = await runMainAgentToolTurn({
      messages: [{ role: "user", content: "DTSV 6月份提了多少bug？" }],
      requestToolCompletion,
      executeToolCall,
      runId: "run-1",
      threadId: "thread-1",
    });

    expect(result.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "agent.turn.started",
      "agent.tool.planned",
      "agent.tool.started",
      "agent.tool.completed",
      "agent.turn.completed",
    ]));
    expect(result.uiToolEvents.map((event) => event.type)).toEqual(["tool-input-available", "tool-output-available"]);
    expect(result.contextText).toContain("Result: 1");
  });
});
```

- [x] **Step 2: Run orchestrator test and confirm red**

Run: `npx vitest run src/test/server/mainAgentToolOrchestrator.test.ts`
Expected: FAIL because `server/mainAgentToolOrchestrator.mjs` does not exist.

- [x] **Step 3: Implement orchestrator**

Create `runMainAgentToolTurn` to own planning loop, selected toolset context, policy validation, tool execution, empty `query_analytics` diagnosis, evidence collection, standard lifecycle events, and UI-compatible tool event projection.

- [x] **Step 4: Slim planning and loop modules**

Keep `server/mainAgentToolPlanning.mjs` focused on planning prompt, date formatting, parse helpers, empty-result helpers, and delegating selected toolset APIs to registry. Convert `server/mainAgentToolLoop.mjs` into a thin direct harness entry that calls `runMainAgentToolTurn`; it must not reimplement the loop.

- [x] **Step 5: Run orchestrator and loop tests**

Run: `npx vitest run src/test/server/mainAgentToolOrchestrator.test.ts src/test/server/mainAgentToolLoop.test.ts`
Expected: PASS.

### Task 3: LangGraph Uses Orchestrator

**Files:**
- Modify: `server/agentRuntime/langGraphChatRuntime.mjs`
- Test: `src/test/server/agentRuntime/langGraphChatRuntime.test.ts`

- [x] **Step 1: Write failing runtime integration assertion**

Extend the LangGraph runtime test to assert `runtimeResult.events` includes `agent.tool.started` and `agent.tool.completed`, and that `prefaceEvents` remains UI-compatible.

- [x] **Step 2: Run runtime test and confirm red**

Run: `npx vitest run src/test/server/agentRuntime/langGraphChatRuntime.test.ts`
Expected: FAIL because LangGraph currently builds only legacy tool events.

- [x] **Step 3: Refactor LangGraph execution node**

Replace local `executeToolCalls` implementation with `runMainAgentToolTurnStep`/orchestrator helper so direct and graph paths share the same policy, event, and evidence behavior.

- [x] **Step 4: Run runtime tests**

Run: `npx vitest run src/test/server/agentRuntime/langGraphChatRuntime.test.ts src/test/server/mainAgentToolOrchestrator.test.ts`
Expected: PASS.

### Task 4: Remove Legacy Runtime Branch

**Files:**
- Modify: `server/index.mjs`
- Modify: `server/agentRuntime/langGraphChatRuntime.mjs`
- Delete: `server/aiChatRuntimeRouting.mjs`
- Delete: `src/test/server/aiChatRuntimeRouting.test.ts`
- Test: `src/test/server/agentRuntime/langGraphChatRuntime.test.ts`

- [x] **Step 1: Write failing no-legacy assertions**

Update runtime mode tests so `resolveAgentRuntimeMode({ VIZION_AGENT_RUNTIME: "legacy" })` returns `"langgraph"` and index no longer imports `resolveMainAgentToolContext` or `shouldResolveGatewayAnalyticsContext`.

- [x] **Step 2: Run focused tests and confirm red**

Run: `npx vitest run src/test/server/agentRuntime/langGraphChatRuntime.test.ts`
Expected: FAIL because legacy mode is still supported.

- [x] **Step 3: Remove server fallback path**

Make `/api/ai/chat` always stream through `streamLangGraphChatResponse`. Delete the legacy analytics pre-resolve/tool-loop branch and unused imports. Keep `resolveMainAgentToolContext` only as a direct test/dev harness adapter around the orchestrator.

- [x] **Step 4: Run server tests**

Run: `npx vitest run src/test/server/agentRuntime/langGraphChatHandler.test.ts src/test/server/agentRuntime/langGraphChatRuntime.test.ts src/test/server/mainAgentToolLoop.test.ts`
Expected: PASS.

### Task 5: Final Verification

**Files:**
- All files touched above.

- [x] **Step 1: Run focused Node tests**

Run: `npx vitest run src/test/server/mainAgentToolRegistry.test.ts src/test/server/mainAgentToolOrchestrator.test.ts src/test/server/mainAgentToolLoop.test.ts src/test/server/mainAgentTools.test.ts src/test/server/agentRuntime/langGraphChatRuntime.test.ts src/test/server/agentRuntime/langGraphChatHandler.test.ts src/test/server/companyChat.test.ts`
Expected: PASS.

- [x] **Step 2: Run syntax checks**

Run: `node --check server/mainAgentToolRegistry.mjs; node --check server/mainAgentToolOrchestrator.mjs; node --check server/mainAgentToolPlanning.mjs; node --check server/mainAgentToolLoop.mjs; node --check server/agentRuntime/langGraphChatRuntime.mjs; node --check server/index.mjs`
Expected: all commands exit 0.

- [x] **Step 3: Run diff hygiene**

Run: `git diff --check`
Expected: no whitespace errors.

- [x] **Step 4: Update repository memory**

Record the new harness convention: registry owns tool metadata, orchestrator owns tool execution/events, LangGraph is the only production runtime.