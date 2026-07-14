import { extractLatestUserQuery } from "./aiContext.mjs";
import { requestCompanyChatCompletion } from "./companyChat.mjs";
import { executeMainAgentToolCall, MAIN_AGENT_TOOLS } from "./mainAgentTools.mjs";

const TOOL_PLANNING_CONTEXT = `# Main agent tool policy
You have access to typed dashboard and duplicate-search tools. Use them only when the user asks for factual QGate dashboard metrics, counts, filtered summaries, defect/test coverage data, or duplicate/similar defect analysis.
If the supplied context already contains the exact factual result needed, answer normally without calling tools.
Use get_data_catalog first when the user asks a broad analytics question and you need to discover available datasets, filters, metrics, or modules.
Use resolve_business_terms when Chinese/English business wording needs normalization before choosing filters or metrics.
If a tool is needed, call at most one dashboard tool with precise filters. Do not invent fields, filters, or metrics.
Use ask_clarification when required filters, scope, timeframe, or business meaning are ambiguous. Ask one focused question instead of guessing.
Use query_defect_high_frequency_analysis for Defect High Frequency / 缺陷高频分析 questions about newly created defects concentrated by ECU/module.
For 最近一周 / recent week / last 7 days high-frequency questions, call query_defect_high_frequency_analysis with filters.recent_days: 7 instead of asking the user to switch views.
Use query_full_picture_module as the fallback for factual Full Picture dashboard questions when no more specific tool fits. Choose only one allowlisted module: dashboard_summary, dashboard_tickets, top_issue_analysis, long_runner_analysis, or defect_high_frequency_analysis.`;

const TOOL_PLANNING_QUERY_RE = /\b(DTSV|QGate|dashboard|bug|defect|opened|created|raised|submitted|resolved|coverage|test|summary|count|metric|trend|duplicate|similar)\b|缺陷|测试|覆盖率|多少|几个|统计|趋势|创建|提交|新建|解决|关闭|重复|查重|相似/i;

export function shouldPlanMainAgentTools(messages) {
  const queryText = extractLatestUserQuery(messages);
  return TOOL_PLANNING_QUERY_RE.test(queryText);
}

function mergeContext(...parts) {
  return parts.filter(Boolean).join("\n\n");
}

function parseToolInput(toolCall) {
  const rawArguments = toolCall?.function?.arguments;
  if (!rawArguments) {
    return {};
  }
  if (typeof rawArguments === "object") {
    return rawArguments;
  }
  try {
    return JSON.parse(String(rawArguments));
  } catch {
    return { raw: String(rawArguments) };
  }
}

export async function resolveMainAgentToolContext({
  messages,
  model,
  context,
  requestChatCompletion = requestCompanyChatCompletion,
  executeToolCall = executeMainAgentToolCall,
  toolDependencies = {},
  maxSteps = 4,
} = {}) {
  const allToolCalls = [];
  const results = [];
  const toolConversationMessages = [];
  const toolEvents = [];
  const stepLimit = Math.max(1, Math.min(10, Number(maxSteps || 4)));
  let stoppedReason = "no_tool_calls";

  for (let stepIndex = 0; stepIndex < stepLimit; stepIndex += 1) {
    const planningResult = await requestChatCompletion({
      messages: [
        ...(Array.isArray(messages) ? messages : []),
        ...toolConversationMessages,
      ],
      model,
      context: mergeContext(context, TOOL_PLANNING_CONTEXT),
      tools: MAIN_AGENT_TOOLS,
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
      const toolName = toolCall?.function?.name || "unknown_tool";
      toolEvents.push({
        type: "tool-input-available",
        toolCallId: toolCall?.id || "",
        toolName,
        input: parseToolInput(toolCall),
      });
      const result = await executeToolCall(toolCall, toolDependencies);
      results.push(result);
      toolConversationMessages.push(result.toolMessage);
      toolEvents.push({
        type: "tool-output-available",
        toolCallId: toolCall?.id || "",
        toolName,
        outputSummary: result.contextText,
      });
      if (result.requiresUserInput) {
        stoppedReason = "clarification_requested";
        break;
      }
    }

    if (stoppedReason === "clarification_requested") {
      break;
    }

    if (stepIndex === stepLimit - 1) {
      stoppedReason = "max_steps";
    }
  }

  return {
    contextText: results.map((result) => result.contextText).filter(Boolean).join("\n\n"),
    toolCalls: allToolCalls,
    toolMessages: results.map((result) => result.toolMessage),
    toolConversationMessages,
    toolEvents,
    stoppedReason,
  };
}