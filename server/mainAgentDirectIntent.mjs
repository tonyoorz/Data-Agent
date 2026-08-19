export const DIRECT_MAIN_AGENT_INTENT_PROFILES = Object.freeze({
  chitchat: {
    confidence: 0.98,
    reason: "greeting-only message matched",
    requiredSlots: [],
    policyHints: ["direct_response", "no_tools"],
    responseTemplate: "你好，我可以帮你看汽车测试质量、缺陷、覆盖率和 Q-Gate 数据。你可以直接问一个项目、时间窗或指标。",
  },
  out_of_scope: {
    confidence: 0.95,
    reason: "request is outside automotive testing analytics scope",
    requiredSlots: [],
    policyHints: ["direct_response", "no_tools", "guide_back_to_domain"],
    responseTemplate: "这个问题不在当前汽车测试质量数据助手的范围内。我可以帮你分析缺陷、覆盖率、Q-Gate 风险、Octane 字段和测试追溯数据。",
  },
  clarification: {
    confidence: 0.4,
    reason: "testing topic lacks a metric, scope, and time window",
    requiredSlots: ["metric_or_scope"],
    policyHints: ["direct_response", "no_tools", "clarification_required"],
    responseTemplate: "你想了解哪类测试情况：覆盖率、通过率/执行率、缺陷发现率，还是某个项目或时间窗的整体风险？",
  },
  data_access_unavailable: {
    confidence: 1,
    reason: "server-owned tenant scope is not configured",
    requiredSlots: [],
    policyHints: ["direct_response", "no_tools", "data_access_blocked"],
    responseTemplate: "当前服务尚未配置受治理的数据访问范围，因此不能查询缺陷、覆盖率或记录数据。请由服务管理员配置 workspace、team 或 project 范围，以及允许的数据对象后重试。",
  },
});

function normalizeQuery(queryText) {
  return String(queryText || "").replace(/\s+/g, " ").trim();
}

export function classifyDirectMainAgentIntent(queryText) {
  const query = normalizeQuery(queryText);
  if (!query) return null;
  if (/^(你好|您好|hello|hi|hey|嗨|早上好|下午好|晚上好)[!！。\s]*$/i.test(query)) {
    const profile = DIRECT_MAIN_AGENT_INTENT_PROFILES.chitchat;
    return { intent: "chitchat", content: profile.responseTemplate, ...profile };
  }
  if (/^(?:测试(?:情况)?|test(?:ing)?)(?:\s*(?:怎么样|咋样|如何|呢))?[?？!！。]*$/i.test(query)
    || /^(?:缺陷|当前风险)(?:\s*(?:怎么样|咋样|如何|呢))?[?？!！。]*$/i.test(query)
    || /^缺陷[?？!！。]*$/.test(query)
    || /^当前风险[?？!！。]*$/.test(query)
    || /^上次的那个问题[?？!！。]*$/.test(query)
    || /^帮(?:我)?看看\s*[A-Za-z0-9_\-]{1,12}[?？!！。]*$/.test(query)) {
    const profile = DIRECT_MAIN_AGENT_INTENT_PROFILES.clarification;
    return { intent: "clarification", content: profile.responseTemplate, ...profile };
  }
  if (/写一首诗|讲个笑话|天气|股票|菜谱|旅游攻略|写代码|python|javascript/i.test(query)
    || /^直接执行\b|drop\s+table|delete\s+from|insert\s+into|update\s+\w+\s+set/i.test(query)
    || /发一封邮件|发邮件|帮我发邮件|绕过权限|用\s*sql\s*(?:帮我)?(?:查|执行|跑)/i.test(query)) {
    const profile = DIRECT_MAIN_AGENT_INTENT_PROFILES.out_of_scope;
    return { intent: "out_of_scope", content: profile.responseTemplate, ...profile };
  }
  return null;
}

export function buildDataAccessUnavailableResponse() {
  const profile = DIRECT_MAIN_AGENT_INTENT_PROFILES.data_access_unavailable;
  return { intent: "data_access_unavailable", content: profile.responseTemplate, ...profile };
}