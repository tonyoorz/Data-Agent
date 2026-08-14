import { extractLatestUserQuery } from "./aiContext.mjs";
import { classifyDirectMainAgentIntent } from "./mainAgentDirectIntent.mjs";
import { routeMainAgentIntent } from "./mainAgentIntentRouter.mjs";
import { MAIN_AGENT_PRIMITIVE_TOOLS } from "./mainAgentPrimitives.mjs";
import { MAIN_AGENT_TOOLSET_NAMES } from "./mainAgentToolsets.mjs";

const PLANNING_QUERY_RE = /\b(DTSV|QGate|Octane|ticket|work_item|dashboard|ontology|capability|available|partial|unavailable|bug|defect|issue|top\s*issue|octane_defects|solution_cluster|assigned_ecu|business_module|opened|created|raised|submitted|resolved|coverage|test|summary|count|metric|trend|growth|rising|increase|delta|duplicate|similar|write|update|delete|edit|risk|health|overview|assessment|empty\s*result|no\s*data|zero\s*rows)\b|entityType=work_item|id=\d+|本体|能力|缺陷|测试|测试小组|执行效率|缺陷发现率|覆盖率|多少|几个|统计|趋势|风险|健康度|当前情况|怎么看|怎么样|创建|提交|新建|解决|关闭|更新|修改|删除|写入|重复|查重|相似|模块|问题模块|上升|增长|环比|同比|根因|提票|报票|提了|数据.*(?:为空|没数据|没有数据|查不到)|为什么.*(?:为空|没数据|没有数据|查不到)|空结果/i;

function toolsByName(allTools) {
  return new Map((Array.isArray(allTools) ? allTools : []).map((tool) => [tool.function?.name, tool]));
}

function toolName(toolCall) {
  return String(toolCall?.function?.name || "unknown_tool");
}

export function createMainAgentToolRegistry(allTools = MAIN_AGENT_PRIMITIVE_TOOLS) {
  const toolMap = toolsByName(allTools);

  function toolNamesForIntent(intent) {
    return MAIN_AGENT_TOOLSET_NAMES[intent] || [];
  }

  function toolsForIntent(intent) {
    return toolNamesForIntent(intent).map((name) => toolMap.get(name)).filter(Boolean);
  }

  function routeIntent(messages) {
    return routeMainAgentIntent(messages);
  }

  function selectToolset(messages) {
    const routed = routeIntent(messages);
    const tools = toolsForIntent(routed.intent);
    return { ...routed, toolNames: tools.map((tool) => tool.function.name), tools };
  }

  function shouldPlanTools(messages) {
    const queryText = extractLatestUserQuery(messages);
    if (classifyDirectMainAgentIntent(queryText)) return false;
    return routeIntent(messages).intent !== "general" || PLANNING_QUERY_RE.test(queryText);
  }

  function isToolAllowed(name, selectedToolset) {
    return Array.isArray(selectedToolset?.toolNames) && selectedToolset.toolNames.includes(name);
  }

  function validateToolCall(toolCall, selectedToolset) {
    const name = toolName(toolCall);
    if (isToolAllowed(name, selectedToolset)) return { allowed: true, toolName: name };
    return {
      allowed: false,
      toolName: name,
      reason: `Tool ${name} is not allowed for intent ${selectedToolset?.intent || "unknown"}`,
    };
  }

  return {
    routeIntent,
    selectToolset,
    shouldPlanTools,
    toolNamesForIntent,
    toolsForIntent,
    isToolAllowed,
    validateToolCall,
  };
}

export function routeMainAgentIntentWithTools(messages) {
  return createMainAgentToolRegistry().routeIntent(messages);
}

export function selectMainAgentToolset(messages, allTools = MAIN_AGENT_PRIMITIVE_TOOLS) {
  return createMainAgentToolRegistry(allTools).selectToolset(messages);
}

export function shouldPlanMainAgentTools(messages) {
  return createMainAgentToolRegistry().shouldPlanTools(messages);
}

export function toolNamesForIntent(intent, allTools = MAIN_AGENT_PRIMITIVE_TOOLS) {
  return createMainAgentToolRegistry(allTools).toolNamesForIntent(intent);
}

export function toolsForIntent(intent, allTools = MAIN_AGENT_PRIMITIVE_TOOLS) {
  return createMainAgentToolRegistry(allTools).toolsForIntent(intent);
}

export function isToolAllowed(name, selectedToolset) {
  return createMainAgentToolRegistry().isToolAllowed(name, selectedToolset);
}

export function validateToolCallAllowed(toolCall, selectedToolset) {
  return createMainAgentToolRegistry().validateToolCall(toolCall, selectedToolset);
}

export function buildBlockedToolResult(toolCall, selectedToolset, reason) {
  const name = toolName(toolCall);
  const content = JSON.stringify({ ok: false, tool: name, error: reason, intent: selectedToolset?.intent || "unknown" });
  return {
    toolMessage: { role: "tool", tool_call_id: toolCall?.id || "", name, content },
    contextText: `# Main agent tool result\nTool: ${name}\nResult: blocked by runtime policy: ${reason}`,
  };
}
