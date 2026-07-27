import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";

import { resolveAiAnalyticsContext } from "../aiAnalyticsContext.mjs";
import { extractLatestUserQuery, resolveAiDefectContext } from "../aiContext.mjs";
import { resolveMainAgentToolContext, shouldPlanMainAgentTools } from "../mainAgentToolLoop.mjs";

const SUPPORTED_RUNTIME_MODES = new Set(["legacy", "langgraph"]);

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
  const raw = String(env?.VIZION_AGENT_RUNTIME || "legacy").trim().toLowerCase();
  return SUPPORTED_RUNTIME_MODES.has(raw) ? raw : "legacy";
}

export function createLangGraphChatRuntime({
  resolveAnalyticsContext = resolveAiAnalyticsContext,
  resolveDefectContext = resolveAiDefectContext,
  shouldPlanTools = shouldPlanMainAgentTools,
  resolveToolContext = resolveMainAgentToolContext,
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

  async function planTools(state, config) {
    const body = state.body || {};
    const shouldUseTools =
      body?.useAnalyticsContext === true &&
      !state.analyticsContext?.skipDefectContext &&
      shouldPlanTools(body?.messages);

    if (!shouldUseTools) {
      return { mainAgentToolContext: null };
    }

    const event = emit(config, { type: "tool-planning-started", threadId: state.threadId });
    const toolDependencies = { ...(state.toolDependencies || {}) };
    if (hasActorScope(state.actorScope)) {
      toolDependencies.actor = state.actorScope;
    }
    const mainAgentToolContext = await resolveToolContext({
      messages: body?.messages,
      model: body?.model,
      context: state.baseContext,
      toolDependencies,
    });
    return {
      mainAgentToolContext,
      runtimeEvents: [event],
    };
  }

  async function finalize(state, config) {
    const body = state.body || {};
    const mainAgentToolContext = state.mainAgentToolContext || null;
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
      aiContextTimings: state.defectContext?.timings || null,
    };
    const event = emit(config, { type: "agent-runtime-ready", runId: state.runId, threadId: state.threadId });
    return {
      context,
      finalMessages,
      prefaceEvents,
      metrics,
      runtimeEvents: [event],
    };
  }

  const graph = new StateGraph(ChatState)
    .addNode("initialize", initialize)
    .addNode("resolve_context", resolveContext)
    .addNode("plan_tools", planTools)
    .addNode("finalize", finalize)
    .addEdge(START, "initialize")
    .addEdge("initialize", "resolve_context")
    .addEdge("resolve_context", "plan_tools")
    .addEdge("plan_tools", "finalize")
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
        metrics: state.metrics || {},
        runtimeEvents: state.runtimeEvents || [],
      };
    },
  };
}