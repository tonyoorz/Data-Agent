import { extractLatestUserQuery } from "./aiContext.mjs";
import { requestCompanyChatCompletion } from "./companyChat.mjs";
import { executeMainAgentToolCall, MAIN_AGENT_TOOLS } from "./mainAgentTools.mjs";

const TOOL_PLANNING_CONTEXT = `# Main agent tool policy
You have access to typed dashboard and duplicate-search tools. Use them only when the user asks for factual QGate dashboard metrics, counts, filtered summaries, defect/test coverage data, or duplicate/similar defect analysis.
If the supplied context already contains the exact factual result needed, answer normally without calling tools.
Use get_data_catalog first when the user asks a broad analytics question and you need to discover available datasets, filters, metrics, or modules.
Use get_ontology_catalog when the user asks what the ontology can answer, which entities/relationships/tools/actions exist, or which capability states are available/partial/unavailable/dry_run_only/disabled/blocked.
Use Action Ontology capability states for Octane write/update/delete intents. Never execute write/update/delete directly from field candidates; disabled or blocked actions must not be executed, and dry_run_only actions require explicit approval before any external write path.
Use search_octane_fields when the user asks which Octane/API/database field backs a business concept, asks about editable/filterable/sortable fields, or explores CRUD/action schema. Retrieve only top-k field candidates.
Do not load the full Octane field catalog into the prompt; use search_octane_fields as local schema retrieval, then validate facts through governed ontology or analytics tools.
Use resolve_business_terms when Chinese/English business wording needs normalization before choosing filters or metrics.
Routing priority: use governed Ontology semantic tools first when the question fits approved ontology metrics, dimensions, filters, time windows, top-N ranking, records, or lineage.
Use query_semantic_metrics first for aggregate, trend, compare, rank, count, and top-N questions over ontology-governed metrics and dimensions.
Use query_semantic_records for governed Ontology list or drilldown requests.
Use query_traceability for governed Ontology requirement, testcase, test-run, and defect lineage questions when the user asks for lineage rather than testcase drafting.
Never redefine metrics after a semantic tool result; use the returned ontologyVersion, schemaFingerprint, sourceRevision, quality, and metrics as factual evidence.
Use query_defect_aggregate only as a legacy analytics fallback for page-parity Top Issue data, raw octane_defects field requests, legacy business_module grouping, or derived_metrics such as delta and growth_pct that are not available from semantic tools yet.
For query_defect_aggregate fallback, use allowlisted metrics/dimensions/filters/time. Use query_defect_records only after query_defect_aggregate returns a drilldown_ref, and only for example tickets.
For legacy growth/rising fallback questions, call query_defect_aggregate with time.current and time.comparison windows, derived_metrics ["delta", "growth_pct"], and order_by delta desc unless the user asks for another ranking.
For legacy module wording, prefer dimensions ["business_module"] unless the user explicitly asks for assigned_ecu or solution_cluster. Convert relative dates to absolute creation_time dates in Asia/Shanghai before calling query_defect_aggregate.
If a legacy dashboard tool is needed, call at most one dashboard tool with precise filters. Do not invent fields, filters, or metrics.
Use ask_clarification when required filters, scope, timeframe, or business meaning are ambiguous. Ask one focused question instead of guessing.
Use query_defect_high_frequency_analysis for Defect High Frequency / 缺陷高频分析 questions about newly created defects concentrated by ECU/module.
For 最近一周 / recent week / last 7 days high-frequency questions, call query_defect_high_frequency_analysis with filters.recent_days: 7 instead of asking the user to switch views.
Use get_test_case_context before drafting or extending a testcase when the user provides a test_id, defect_id, or asks to create a regression/coverage testcase from known QGate context. For defect-to-testcase workflows, call get_test_case_context first; use query_traceability only if the user explicitly asks for lineage beyond testcase drafting context.
For an Octane ticket URL such as entityType=work_item&id=2774806, extract id=2774806 as anchor.type defect_id and call get_test_case_context; do not stop at external-link access limitations.
Use query_full_picture_module as the fallback for factual Full Picture dashboard questions when no more specific tool fits. Choose only one allowlisted module: dashboard_summary, dashboard_tickets, top_issue_analysis, long_runner_analysis, or defect_high_frequency_analysis.`;

const TOOL_PLANNING_QUERY_RE = /\b(DTSV|QGate|Octane|ticket|work_item|dashboard|ontology|capability|available|partial|unavailable|bug|defect|issue|top\s*issue|octane_defects|solution_cluster|assigned_ecu|business_module|opened|created|raised|submitted|resolved|coverage|test|summary|count|metric|trend|growth|rising|increase|delta|duplicate|similar|write|update|delete|edit)\b|entityType=work_item|id=\d+|本体|能力|缺陷|测试|覆盖率|多少|几个|统计|趋势|创建|提交|新建|解决|关闭|更新|修改|删除|写入|重复|查重|相似|模块|问题模块|上升|增长|环比|同比|根因/i;

function formatPlanningDate(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

function buildToolPlanningContext(now) {
  return [
    TOOL_PLANNING_CONTEXT,
    `# Runtime date\nCurrent date for relative analytics windows: ${formatPlanningDate(now)}. Timezone: Asia/Shanghai.`,
  ].join("\n\n");
}

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
  now = new Date(),
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
      context: mergeContext(context, buildToolPlanningContext(now)),
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