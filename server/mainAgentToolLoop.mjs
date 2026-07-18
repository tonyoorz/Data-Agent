import { extractLatestUserQuery } from "./aiContext.mjs";

// This expression is only a compatibility routing hint. Business semantics,
// metric selection, policy, planning, and tool execution belong to the V2 Runtime.
const ANALYTICS_QUERY_RE = /\b(DTSV|QGate|dashboard|bug|defect|opened|created|raised|submitted|resolved|coverage|test|summary|count|metric|trend|duplicate|similar)\b|缺陷|测试|覆盖率|多少|几个|统计|趋势|创建|提交|新建|解决|关闭|重复|查重|相似/i;

export function shouldPlanMainAgentTools(messages) {
  return ANALYTICS_QUERY_RE.test(extractLatestUserQuery(messages));
}

function compatibilityEvents(events = []) {
  const toolNames = new Map(events.filter((event) => event.type === "tool.started").map((event) => [event.payload.attemptId, event.payload.toolName]));
  return events.flatMap((event) => {
    if (event.type === "tool.started") {
      return [{ type: "tool-input-available", toolCallId: event.payload.attemptId, toolName: event.payload.toolName, input: event.payload.redactedCanonicalArgs }];
    }
    if (event.type === "tool.completed") {
      return [{ type: "tool-output-available", toolCallId: event.payload.attemptId, toolName: toolNames.get(event.payload.attemptId), outputSummary: `${event.payload.status}: ${event.payload.evidenceIds.join(",")}` }];
    }
    if (["intent.resolved", "ontology.resolved", "plan.validated", "claims.validated"].includes(event.type)) {
      return [{ type: "status", message: event.type }];
    }
    return [];
  });
}

export async function resolveMainAgentToolContext({ messages, model, runAgent } = {}) {
  if (typeof runAgent !== "function") {
    throw Object.assign(new Error("MAIN_AGENT_RUNTIME_ADAPTER_REQUIRED"), { code: "MAIN_AGENT_RUNTIME_ADAPTER_REQUIRED" });
  }
  const queryText = extractLatestUserQuery(messages);
  const result = await runAgent({ queryText, selectedModel: model });
  if (!result?.answer?.text) {
    throw Object.assign(new Error("MAIN_AGENT_RUNTIME_ANSWER_REQUIRED"), { code: "MAIN_AGENT_RUNTIME_ANSWER_REQUIRED" });
  }
  const toolEvents = compatibilityEvents(result.events);
  const toolCalls = (result.events || []).filter((event) => event.type === "tool.started").map((event) => ({
    id: event.payload.attemptId,
    type: "function",
    function: { name: event.payload.toolName, arguments: JSON.stringify(event.payload.redactedCanonicalArgs || {}) },
  }));
  return {
    contextText: "",
    toolCalls,
    toolMessages: [],
    toolConversationMessages: [],
    toolEvents,
    stoppedReason: result.interaction ? "clarification_requested" : "runtime_completed",
    answer: result.answer,
    runId: result.runId,
    interaction: result.interaction || null,
  };
}
