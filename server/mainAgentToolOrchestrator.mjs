import { requestCompanyChatCompletion } from "./companyChat.mjs";
import { executeMainAgentToolCall } from "./mainAgentTools.mjs";
import { isToolAllowed } from "./mainAgentToolRegistry.mjs";
import {
  buildCatalogBackedAnalyticsRetry,
  completeCatalogBackedAnalyticsRetry,
} from "./mainAgentToolRecovery.mjs";
import {
  buildEmptyDiagnosisToolCall,
  buildSelectedToolsetContext,
  buildToolPlanningContext,
  executeMainAgentPlannedToolCall,
  hasEmptyAnalyticsResult,
  hasPlannedDiagnosis,
  mergeToolContext,
  selectMainAgentToolset,
} from "./mainAgentToolPlanning.mjs";

function standardEvent(base, event) {
  return {
    runId: base.runId || "",
    threadId: base.threadId || "",
    ...event,
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

  async function executeAndRecordToolCall(toolCall, { catalogRecovery = null } = {}) {
    const toolName = toolCall?.function?.name || "unknown_tool";
    events.push(standardEvent(eventBase, {
      type: "agent.tool.started",
      toolCallId: toolCall?.id || "",
      toolName,
      intent: selectedToolset.intent,
    }));
    const executed = await executeMainAgentPlannedToolCall({
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
    if (catalogRecovery) {
      const recovery = completeCatalogBackedAnalyticsRetry({
        recovery: catalogRecovery,
        result: executed.result,
        stoppedReason: executed.stoppedReason,
      });
      uiToolEvents.push({
        type: "tool-recovery",
        toolCallId: toolCall?.id || "",
        toolName,
        recovery,
      });
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

    stoppedReason = "";
    for (const toolCall of stepToolCalls) {
      allToolCalls.push(toolCall);
      toolConversationMessages.push({
        role: "assistant",
        content: "",
        tool_calls: [toolCall],
      });
      events.push(standardEvent(eventBase, {
        type: "agent.tool.planned",
        toolCallId: toolCall?.id || "",
        toolName: toolCall?.function?.name || "unknown_tool",
        intent: selectedToolset.intent,
      }));
      const { result } = await executeAndRecordToolCall(toolCall);
      if (stoppedReason) {
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
        const diagnosis = await executeAndRecordToolCall(diagnosisToolCall);
        if (stoppedReason) {
          break;
        }
        const correction = buildCatalogBackedAnalyticsRetry({
          originalToolCall: toolCall,
          diagnosisToolCall,
          diagnosisResult: diagnosis.result,
        });
        if (correction && isToolAllowed(correction.toolCall.function.name, selectedToolset)) {
          allToolCalls.push(correction.toolCall);
          toolConversationMessages.push({
            role: "assistant",
            content: "",
            tool_calls: [correction.toolCall],
          });
          events.push(standardEvent(eventBase, {
            type: "agent.tool.planned",
            toolCallId: correction.toolCall.id,
            toolName: correction.toolCall.function.name,
            intent: selectedToolset.intent,
            reason: "catalog_backed_alias_retry",
          }));
          await executeAndRecordToolCall(correction.toolCall, { catalogRecovery: correction.recovery });
          if (!stoppedReason) {
            stoppedReason = "catalog_retry_completed";
          }
          break;
        }
      }
    }

    if (stoppedReason) {
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