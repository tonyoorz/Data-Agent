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

// Tools whose calls are independent read-only analytics and may be executed
// concurrently when the model returns several in a single step. Write paths,
// ask_clarification (which interrupts the turn), and anything not on this
// allowlist fall back to the serial path so the self-heal sequence is unchanged.
const PARALLEL_SAFE_READ_ONLY_TOOLS = new Set([
  "get_data_catalog",
  "get_ontology_catalog",
  "search_octane_fields",
  "search_analytics_filter_values",
  "resolve_business_terms",
  "query_dashboard_summary",
  "query_testing_coverage_project_status",
  "query_testing_coverage_aida_status",
  "query_testing_team_fv_analysis",
  "get_test_case_context",
  "query_defect_high_frequency_analysis",
  "query_defect_aggregate",
  "query_defect_records",
  "query_full_picture_module",
  "search_duplicates",
]);

function isParallelSafeToolCall(toolCall) {
  return PARALLEL_SAFE_READ_ONLY_TOOLS.has(toolCall?.function?.name);
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
    const allParallelReadOnly = stepToolCalls.length >= 2
      && stepToolCalls.every((tc) => isParallelSafeToolCall(tc));
    if (allParallelReadOnly) {
      // Fan out independent read-only analytics calls in the same step. Execution
      // is concurrent; per-call recovery (empty-result diagnosis + catalog alias
      // retry) still runs serially afterward, so self-heal semantics are unchanged.
      const parallelSettled = await Promise.allSettled(
        stepToolCalls.map(async (toolCall) => {
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
            parallel: true,
          }));
          const executed = await executeAndRecordToolCall(toolCall);
          return { toolCall, result: executed.result, blocked: executed.blocked };
        }),
      );
      for (const entry of parallelSettled) {
        if (entry.status !== "fulfilled") continue;
        const { toolCall, result } = entry.value;
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
    }
    if (!allParallelReadOnly) {
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
    }  // end if (!allParallelReadOnly)

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
