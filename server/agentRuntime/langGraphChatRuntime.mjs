import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";

import { resolveAiAnalyticsContext } from "../aiAnalyticsContext.mjs";
import { extractLatestUserQuery, resolveAiDefectContext } from "../aiContext.mjs";
import { requestCompanyChatCompletion } from "../companyChat.mjs";
import {
  selectMainAgentToolset,
  shouldPlanMainAgentTools,
} from "../mainAgentToolPlanning.mjs";
import { runMainAgentToolTurn } from "../mainAgentToolOrchestrator.mjs";

const SUPPORTED_RUNTIME_MODES = new Set(["langgraph"]);

const overwrite = (_left, right) => right;
const append = (left, right) => [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])];

const ChatState = Annotation.Root({
  body: Annotation({ reducer: overwrite, default: () => ({}) }),
  toolDependencies: Annotation({ reducer: overwrite, default: () => ({}) }),
  runId: Annotation({ reducer: overwrite, default: () => "" }),
  threadId: Annotation({ reducer: overwrite, default: () => "" }),
  actorScope: Annotation({ reducer: overwrite, default: () => ({}) }),
  queryText: Annotation({ reducer: overwrite, default: () => "" }),
  model: Annotation({ reducer: overwrite, default: () => "" }),
  analyticsContext: Annotation({ reducer: overwrite, default: () => null }),
  defectContext: Annotation({ reducer: overwrite, default: () => null }),
  toolRouting: Annotation({ reducer: overwrite, default: () => null }),
  plannedToolCalls: Annotation({ reducer: overwrite, default: () => [] }),
  toolStepIndex: Annotation({ reducer: overwrite, default: () => 0 }),
  stoppedReason: Annotation({ reducer: overwrite, default: () => "" }),
  toolCalls: Annotation({ reducer: append, default: () => [] }),
  toolMessages: Annotation({ reducer: append, default: () => [] }),
  toolConversationMessages: Annotation({ reducer: append, default: () => [] }),
  toolEvents: Annotation({ reducer: append, default: () => [] }),
  toolStandardEvents: Annotation({ reducer: append, default: () => [] }),
  toolEvidence: Annotation({ reducer: append, default: () => [] }),
  toolResultTexts: Annotation({ reducer: append, default: () => [] }),
  mainAgentToolContext: Annotation({ reducer: overwrite, default: () => null }),
  baseContext: Annotation({ reducer: overwrite, default: () => "" }),
  context: Annotation({ reducer: overwrite, default: () => "" }),
  finalMessages: Annotation({ reducer: overwrite, default: () => [] }),
  prefaceEvents: Annotation({ reducer: overwrite, default: () => [] }),
  metrics: Annotation({ reducer: overwrite, default: () => ({}) }),
  runtimeEvents: Annotation({ reducer: append, default: () => [] }),
});

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeThreadId(body, now) {
  const explicit = [body?.threadId, body?.conversationId, body?.sessionId].find(isNonEmptyString);
  if (explicit) {
    return String(explicit).trim();
  }
  return `chat-${now().getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRunId(body, now) {
  if (isNonEmptyString(body?.runId)) {
    return String(body.runId).trim();
  }
  return `run-${now().getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function stringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function normalizeActorScope(body) {
  const actor = body?.actor && typeof body.actor === "object" ? body.actor : body?.actorScope && typeof body.actorScope === "object" ? body.actorScope : {};
  const rawScopes = actor.scopes && typeof actor.scopes === "object" ? actor.scopes : {};
  const scopes = {};
  for (const key of ["workspaceIds", "projectIds", "teamIds", "allowedObjectTypes", "allowedPropertyIds", "rowPolicyIds", "sensitiveFieldPolicyIds"]) {
    const values = stringList(rawScopes[key]);
    if (values.length) {
      scopes[key] = values;
    }
  }
  return {
    actorId: String(actor.actorId || body?.userId || body?.user?.id || "").trim(),
    scopeHash: String(actor.scopeHash || "").trim(),
    ...(Object.keys(scopes).length ? { scopes } : {}),
  };
}

function hasActorScope(actorScope) {
  return Boolean(actorScope?.actorId || actorScope?.scopeHash || Object.keys(actorScope?.scopes || {}).length);
}

function emit(config, event) {
  config?.configurable?.onEvent?.(event);
  return event;
}

function createRunnableSignal() {
  if (typeof AbortController === "undefined") {
    return undefined;
  }
  const controller = new AbortController();
  if (typeof controller.signal.throwIfAborted !== "function") {
    Object.defineProperty(controller.signal, "throwIfAborted", {
      value() {
        if (this.aborted) {
          throw new Error("LangGraph run aborted");
        }
      },
    });
  }
  return controller.signal;
}

function ensureAbortSignalCompatibility() {
  const prototype = globalThis.AbortSignal?.prototype;
  if (!prototype || typeof prototype.throwIfAborted === "function") {
    return;
  }
  Object.defineProperty(prototype, "throwIfAborted", {
    value() {
      if (this.aborted) {
        throw new Error("LangGraph run aborted");
      }
    },
  });
}

function mergeContext(...parts) {
  return parts.filter(Boolean).join("\n\n");
}

function toolAuditsFromContext(mainAgentToolContext, { runId, threadId, actorScope }) {
  const byId = new Map();
  for (const event of mainAgentToolContext?.toolEvents || []) {
    const toolCallId = String(event?.toolCallId || "");
    if (!toolCallId) {
      continue;
    }
    const current = byId.get(toolCallId) || { runId, threadId, actorScope, toolCallId, toolName: String(event?.toolName || "") };
    if (event.type === "tool-input-available") {
      current.input = event.input;
    }
    if (event.type === "tool-output-available") {
      current.outputSummary = event.outputSummary;
    }
    if (event.toolName) {
      current.toolName = String(event.toolName);
    }
    byId.set(toolCallId, current);
  }
  return [...byId.values()];
}

async function persistRuntimeState(runtimeStore, state) {
  if (!runtimeStore) {
    return;
  }
  const runId = state.runId || "";
  const threadId = state.threadId || "";
  const actorScope = state.actorScope || {};
  for (const event of state.runtimeEvents || []) {
    await runtimeStore.appendRunEvent({ ...event, runId, threadId, actorScope });
  }
  for (const audit of toolAuditsFromContext(state.mainAgentToolContext, { runId, threadId, actorScope })) {
    await runtimeStore.appendToolAudit(audit);
  }
  await runtimeStore.writeThreadCheckpoint({
    runId,
    threadId,
    actorScope,
    checkpoint: {
      node: "finalize",
      queryText: state.queryText || "",
      metrics: state.metrics || {},
      runtimeEvents: state.runtimeEvents || [],
    },
  });
}

export function resolveAgentRuntimeMode(env = process.env) {
  const raw = String(env?.VIZION_AGENT_RUNTIME || "").trim().toLowerCase();
  if (!raw) return "langgraph";
  return SUPPORTED_RUNTIME_MODES.has(raw) ? raw : "langgraph";
}

function compactToolRouting(toolRouting) {
  const selectedToolset = toolRouting?.selectedToolset || {};
  return {
    shouldUseTools: Boolean(toolRouting?.shouldUseTools),
    intent: selectedToolset.intent || "general",
    confidence: selectedToolset.confidence || 0,
    reason: selectedToolset.reason || "unknown",
    requiredSlots: Array.isArray(selectedToolset.requiredSlots) ? selectedToolset.requiredSlots : [],
    policyHints: Array.isArray(selectedToolset.policyHints) ? selectedToolset.policyHints : [],
    toolNames: Array.isArray(selectedToolset.toolNames) ? selectedToolset.toolNames : [],
  };
}

function buildMainAgentToolContextFromState(state) {
  return {
    contextText: (state.toolResultTexts || []).filter(Boolean).join("\n\n"),
    toolCalls: state.toolCalls || [],
    toolMessages: state.toolMessages || [],
    toolConversationMessages: state.toolConversationMessages || [],
    toolEvents: state.toolEvents || [],
    events: state.toolStandardEvents || [],
    evidence: state.toolEvidence || [],
    selectedToolset: state.toolRouting?.selectedToolset,
    stoppedReason: state.stoppedReason || "no_tool_calls",
  };
}

export function createLangGraphChatRuntime({
  resolveAnalyticsContext = resolveAiAnalyticsContext,
  resolveDefectContext = resolveAiDefectContext,
  shouldPlanTools = shouldPlanMainAgentTools,
  requestToolCompletion = requestCompanyChatCompletion,
  executeToolCall,
  maxToolSteps = 4,
  checkpointer = new MemorySaver(),
  runtimeStore = null,
  now = () => new Date(),
} = {}) {
  ensureAbortSignalCompatibility();

  async function initialize(state, config) {
    const body = state.body && typeof state.body === "object" ? state.body : {};
    const runId = isNonEmptyString(state.runId) ? String(state.runId).trim() : normalizeRunId(body, now);
    const threadId = isNonEmptyString(state.threadId) ? String(state.threadId).trim() : normalizeThreadId(body, now);
    const actorScope = normalizeActorScope(body);
    const queryText = extractLatestUserQuery(body?.messages);
    const event = emit(config, {
      type: "agent-runtime-started",
      runtime: "langgraph",
      runId,
      threadId,
      queryPreview: queryText.slice(0, 120),
    });
    return {
      body,
      runId,
      threadId,
      actorScope,
      queryText,
      model: String(body?.model || ""),
      runtimeEvents: [event],
    };
  }

  async function resolveContext(state, config) {
    const body = state.body || {};
    let analyticsContext = null;
    let defectContext = null;
    const events = [];

    if (body?.useAnalyticsContext === true) {
      events.push(emit(config, { type: "analytics-context-started", threadId: state.threadId }));
      analyticsContext = await resolveAnalyticsContext({
        messages: body?.messages,
        ...(hasActorScope(state.actorScope) ? { actor: state.actorScope } : {}),
      });
    }

    if (body?.useDefectContext === true && !analyticsContext?.skipDefectContext) {
      events.push(emit(config, { type: "defect-context-started", threadId: state.threadId }));
      defectContext = await resolveDefectContext({
        messages: body?.messages,
        topK: 5,
        ...(state.toolDependencies || {}),
      });
    }

    const baseContext = mergeContext(body?.context, analyticsContext?.contextText, defectContext?.contextText);
    return {
      analyticsContext,
      defectContext,
      baseContext,
      runtimeEvents: events,
    };
  }

  async function routeTools(state, config) {
    const body = state.body || {};
    const selectedToolset = selectMainAgentToolset(body?.messages);
    const shouldUseTools =
      body?.useAnalyticsContext === true &&
      !state.analyticsContext?.skipDefectContext &&
      shouldPlanTools(body?.messages);
    const toolRouting = { shouldUseTools, selectedToolset };
    const compact = compactToolRouting(toolRouting);
    const event = emit(config, {
      type: "tool-routing-completed",
      threadId: state.threadId,
      shouldUseTools: compact.shouldUseTools,
      intent: compact.intent,
      toolNames: compact.toolNames,
    });
    return {
      toolRouting,
      runtimeEvents: [event],
    };
  }

  function buildToolDependencies(state) {
    const toolDependencies = { ...(state.toolDependencies || {}) };
    if (hasActorScope(state.actorScope)) {
      toolDependencies.actor = state.actorScope;
    }
    return toolDependencies;
  }

  async function executeToolTurn(state, config) {
    const body = state.body || {};
    const selectedToolset = state.toolRouting?.selectedToolset || selectMainAgentToolset(body?.messages);
    const event = emit(config, { type: "tool-planning-started", threadId: state.threadId });
    const toolTurn = await runMainAgentToolTurn({
      messages: body?.messages,
      model: body?.model,
      context: state.baseContext,
      requestToolCompletion,
      executeToolCall,
      toolDependencies: buildToolDependencies(state),
      selectedToolset,
      maxSteps: maxToolSteps,
      now: now(),
      runId: state.runId,
      threadId: state.threadId,
    });
    return {
      plannedToolCalls: [],
      stoppedReason: toolTurn.stoppedReason,
      toolCalls: toolTurn.toolCalls,
      toolMessages: toolTurn.toolMessages,
      toolConversationMessages: toolTurn.toolConversationMessages,
      toolEvents: toolTurn.toolEvents,
      toolStandardEvents: toolTurn.events,
      toolEvidence: toolTurn.evidence,
      toolResultTexts: toolTurn.contextText ? [toolTurn.contextText] : [],
      runtimeEvents: [event],
    };
  }

  async function finalize(state, config) {
    const body = state.body || {};
    const mainAgentToolContext = state.toolRouting?.shouldUseTools ? buildMainAgentToolContextFromState(state) : null;
    const context = mergeContext(state.baseContext, mainAgentToolContext?.contextText);
    const finalMessages = [
      ...(Array.isArray(body?.messages) ? body.messages : []),
      ...(mainAgentToolContext?.toolConversationMessages || []),
    ];
    const prefaceEvents = [
      ...(mainAgentToolContext?.toolEvents || []),
      ...(state.defectContext?.duplicateSearchResult
        ? [
            {
              type: "context",
              context: state.defectContext.contextText,
              result: state.defectContext.duplicateSearchResult,
              timings: state.defectContext.timings,
            },
          ]
        : []),
    ];
    const metrics = {
      runtime: "langgraph",
      runId: state.runId,
      threadId: state.threadId,
      actorId: state.actorScope?.actorId || "",
      queryText: state.queryText,
      aiContextEnabled: body?.useDefectContext === true,
      analyticsContextEnabled: body?.useAnalyticsContext === true,
      mainAgentToolCallCount: mainAgentToolContext?.toolCalls?.length || 0,
      toolRouting: compactToolRouting(state.toolRouting),
      aiContextTimings: state.defectContext?.timings || null,
    };
    const event = emit(config, { type: "agent-runtime-ready", runId: state.runId, threadId: state.threadId });
    return {
      context,
      finalMessages,
      prefaceEvents,
      mainAgentToolContext,
      metrics,
      runtimeEvents: [event],
    };
  }

  function routeAfterToolRouting(state) {
    return state.toolRouting?.shouldUseTools === true ? "execute_tool_turn" : "finalize";
  }

  const graph = new StateGraph(ChatState)
    .addNode("initialize", initialize)
    .addNode("resolve_context", resolveContext)
    .addNode("route_tools", routeTools)
    .addNode("execute_tool_turn", executeToolTurn)
    .addNode("finalize", finalize)
    .addEdge(START, "initialize")
    .addEdge("initialize", "resolve_context")
    .addEdge("resolve_context", "route_tools")
    .addConditionalEdges("route_tools", routeAfterToolRouting)
    .addEdge("execute_tool_turn", "finalize")
    .addEdge("finalize", END)
    .compile({ checkpointer });

  return {
    kind: "langgraph",
    graph,
    async invoke({ body = {}, toolDependencies = {} } = {}, { onEvent } = {}) {
      const runId = normalizeRunId(body, now);
      const threadId = normalizeThreadId(body, now);
      const state = await graph.invoke(
        { body, runId, threadId, toolDependencies },
        {
          signal: createRunnableSignal(),
          configurable: {
            thread_id: threadId,
            onEvent,
          },
        },
      );
      await persistRuntimeState(runtimeStore, state);
      return {
        runtime: "langgraph",
        runId: state.runId || runId,
        threadId: state.threadId || threadId,
        actorScope: state.actorScope || {},
        body: state.body || body,
        queryText: state.queryText || "",
        analyticsContext: state.analyticsContext || null,
        aiContext: state.defectContext || null,
        mainAgentToolContext: state.mainAgentToolContext || null,
        context: state.context || "",
        finalMessages: state.finalMessages || [],
        prefaceEvents: state.prefaceEvents || [],
        events: state.mainAgentToolContext?.events || state.toolStandardEvents || [],
        metrics: state.metrics || {},
        runtimeEvents: state.runtimeEvents || [],
      };
    },
  };
}