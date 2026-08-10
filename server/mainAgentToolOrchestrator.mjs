import { requestCompanyChatCompletion } from "./companyChat.mjs";
import { buildToolEvidence } from "./mainAgentEvidence.mjs";
import { executeMainAgentToolCall } from "./mainAgentTools.mjs";
import { buildBlockedToolResult, isToolAllowed, validateToolCallAllowed } from "./mainAgentToolRegistry.mjs";
import {
  buildEmptyDiagnosisToolCall,
  buildSelectedToolsetContext,
  buildToolPlanningContext,
  hasEmptyAnalyticsResult,
  hasPlannedDiagnosis,
  mergeToolContext,
  parseToolInput,
  selectMainAgentToolset,
} from "./mainAgentToolPlanning.mjs";

function standardEvent(base, event) {
  return {
    runId: base.runId || "",
    threadId: base.threadId || "",
    ...event,
  };
}

async function executePlannedToolCall({
  toolCall,
  selectedToolset,
  executeToolCall = executeMainAgentToolCall,
  toolDependencies = {},
} = {}) {
  const toolName = toolCall?.function?.name || "unknown_tool";
  const toolEvents = [{
    type: "tool-input-available",
    toolCallId: toolCall?.id || "",
    toolName,
    input: parseToolInput(toolCall),
  }];

  const gate = validateToolCallAllowed(toolCall, selectedToolset);
  if (!gate.allowed) {
    const blockedResult = buildBlockedToolResult(toolCall, selectedToolset, gate.reason);
    toolEvents.push({
      type: "tool-blocked",
      toolCallId: toolCall?.id || "",
      toolName,
      intent: selectedToolset?.intent,
      reason: gate.reason,
    });
    return {
      result: blockedResult,
      toolEvents,
      evidence: null,
      stoppedReason: "tool_not_allowed",
      blocked: true,
    };
  }

  const result = await executeToolCall(toolCall, toolDependencies);
  toolEvents.push({
    type: "tool-output-available",
    toolCallId: toolCall?.id || "",
    toolName,
    outputSummary: result.contextText,
  });
  return {
    result,
    toolEvents,
    evidence: buildToolEvidence({ toolCall, result, intent: selectedToolset?.intent }),
    stoppedReason: result.requiresUserInput ? "clarification_requested" : "",
    blocked: false,
  };
}

export async function runMainAgentToolTurn({
  messages,
  model,
  context,
  requestToolCompletion = requestCompanyChatCompletion,
  executeToolCall = executeMainAgentToolCall,
  toolDependencies = {},
  selectedToolset: providedToolset,
  maxSteps = 4,
  now = new Date(),
  runId = "",
  threadId = "",
} = {}) {
  const allToolCalls = [];
  const results = [];
  const toolConversationMessages = [];
  const uiToolEvents = [];
  const events = [];
  const evidence = [];
  const stepLimit = Math.max(1, Math.min(10, Number(maxSteps || 4)));
  const selectedToolset = providedToolset || selectMainAgentToolset(messages);
  let stoppedReason = "no_tool_calls";

  const eventBase = { runId, threadId };
  events.push(standardEvent(eventBase, {
    type: "agent.turn.started",
    intent: selectedToolset.intent,
    toolNames: selectedToolset.toolNames || [],
  }));

  async function executeAndRecordToolCall(toolCall) {
    const toolName = toolCall?.function?.name || "unknown_tool";
    events.push(standardEvent(eventBase, {
      type: "agent.tool.started",
      toolCallId: toolCall?.id || "",
      toolName,
      intent: selectedToolset.intent,
    }));
    const executed = await executePlannedToolCall({
      toolCall,
      selectedToolset,
      executeToolCall,
      toolDependencies,
    });
    results.push(executed.result);
    toolConversationMessages.push(executed.result.toolMessage);
    uiToolEvents.push(...executed.toolEvents);
    if (executed.evidence) {
      evidence.push(executed.evidence);
    }
    if (executed.stoppedReason) {
      stoppedReason = executed.stoppedReason;
    }
    events.push(standardEvent(eventBase, {
      type: executed.blocked ? "agent.tool.blocked" : "agent.tool.completed",
      toolCallId: toolCall?.id || "",
      toolName,
      intent: selectedToolset.intent,
      stoppedReason: executed.stoppedReason || "",
    }));
    return { result: executed.result, blocked: executed.blocked };
  }

  for (let stepIndex = 0; stepIndex < stepLimit; stepIndex += 1) {
    const planningResult = await requestToolCompletion({
      messages: [
        ...(Array.isArray(messages) ? messages : []),
        ...toolConversationMessages,
      ],
      model,
      context: mergeToolContext(
        context,
        buildToolPlanningContext(now),
        buildSelectedToolsetContext(selectedToolset),
      ),
      tools: selectedToolset.tools,
      toolChoice: "auto",
    });

    const stepToolCalls = Array.isArray(planningResult.toolCalls) ? planningResult.toolCalls.slice(0, 3) : [];
    if (stepToolCalls.length === 0) {
      stoppedReason = "no_tool_calls";
      break;
    }

    allToolCalls.push(...stepToolCalls);
    toolConversationMessages.push({
      role: "assistant",
      content: "",
      tool_calls: stepToolCalls,
    });
    for (const toolCall of stepToolCalls) {
      events.push(standardEvent(eventBase, {
        type: "agent.tool.planned",
        toolCallId: toolCall?.id || "",
        toolName: toolCall?.function?.name || "unknown_tool",
        intent: selectedToolset.intent,
      }));
    }

    for (const toolCall of stepToolCalls) {
      const { result } = await executeAndRecordToolCall(toolCall);
      if (stoppedReason === "tool_not_allowed" || stoppedReason === "clarification_requested") {
        break;
      }

      if (hasEmptyAnalyticsResult(toolCall, result) && !hasPlannedDiagnosis(allToolCalls) && isToolAllowed("diagnose_analytics_empty", selectedToolset)) {
        const diagnosisToolCall = buildEmptyDiagnosisToolCall(toolCall);
        allToolCalls.push(diagnosisToolCall);
        toolConversationMessages.push({
          role: "assistant",
          content: "",
          tool_calls: [diagnosisToolCall],
        });
        events.push(standardEvent(eventBase, {
          type: "agent.tool.planned",
          toolCallId: diagnosisToolCall.id || "",
          toolName: "diagnose_analytics_empty",
          intent: selectedToolset.intent,
          reason: "empty_analytics_result",
        }));
        await executeAndRecordToolCall(diagnosisToolCall);
        if (stoppedReason === "tool_not_allowed" || stoppedReason === "clarification_requested") {
          break;
        }
      }
    }

    if (stoppedReason === "clarification_requested" || stoppedReason === "tool_not_allowed") {
      break;
    }

    if (stepIndex === stepLimit - 1) {
      stoppedReason = "max_steps";
    }
  }

  events.push(standardEvent(eventBase, {
    type: "agent.turn.completed",
    intent: selectedToolset.intent,
    stoppedReason,
    toolCallCount: allToolCalls.length,
  }));

  return {
    contextText: results.map((result) => result.contextText).filter(Boolean).join("\n\n"),
    toolCalls: allToolCalls,
    toolMessages: results.map((result) => result.toolMessage),
    toolConversationMessages,
    toolEvents: uiToolEvents,
    uiToolEvents,
    events,
    evidence,
    selectedToolset,
    stoppedReason,
  };
}