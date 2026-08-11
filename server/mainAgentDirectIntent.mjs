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
  if (/^(?:测试(?:情况)?|test(?:ing)?)(?:\s*(?:怎么样|咋样|如何|呢))?[?？!！。]*$/i.test(query)) {
    const profile = DIRECT_MAIN_AGENT_INTENT_PROFILES.clarification;
    return { intent: "clarification", content: profile.responseTemplate, ...profile };
  }
  if (/写一首诗|讲个笑话|天气|股票|菜谱|旅游攻略|写代码|python|javascript/i.test(query)) {
    const profile = DIRECT_MAIN_AGENT_INTENT_PROFILES.out_of_scope;
    return { intent: "out_of_scope", content: profile.responseTemplate, ...profile };
  }
  return null;
}