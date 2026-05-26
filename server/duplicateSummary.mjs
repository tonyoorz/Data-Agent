import { buildChatCompletionRequest, resolveChatModelConfig } from "./chatModelConfig.mjs";

function buildFallbackSummary(result) {
  const head = [
    `检索完成：返回 ${result.candidates.length} 条候选`,
    `模型阶段：${result.modelPhase}`,
    `反馈样本：${result.feedbackCount}`,
  ];

  if (!result.candidates.length) {
    return `${head.join(" · ")}\n\n未找到足够相似的问题，请补充项目、PU、现象关键词后重试。`;
  }

  const top = result.candidates.slice(0, 3).map((item, idx) => {
    const title = item.name || "Untitled";
    const ticket = item.ticketId || "N/A";
    const score = item.score1to10;
    return `${idx + 1}. [${ticket}] ${title} (评分 ${score}/10)`;
  });

  return `${head.join(" · ")}\n\n${top.join("\n")}`;
}

function buildUserPrompt(query, result) {
  const candidates = result.candidates
    .slice(0, 5)
    .map((candidate, index) => {
      const meta = [candidate.project, candidate.pu, candidate.statusPhase]
        .filter(Boolean)
        .join(" / ") || "-";
      return [
        `${index + 1}. Ticket: ${candidate.ticketId || "N/A"}`,
        `标题: ${candidate.name || "Untitled"}`,
        `评分: ${candidate.score1to10}/10`,
        `元信息: ${meta}`,
        `摘要: ${candidate.snippet || "无"}`,
      ].join("\n");
    })
    .join("\n\n");

  return [
    `用户问题：${query}`,
    `检索阶段：${result.modelPhase}`,
    `反馈样本：${result.feedbackCount}`,
    "",
    "候选结果：",
    candidates || "无候选结果",
  ].join("\n");
}

export async function summarizeDuplicateResults(query, result, selectedModel) {
  const fallbackSummary = buildFallbackSummary(result);
  const config = resolveChatModelConfig(selectedModel || "", process.env);

  if (!config.credential) {
    return {
      summaryText: fallbackSummary,
      answerModel: "Duplicate Search Agent",
      summarySource: "fallback",
    };
  }

  const requestConfig = buildChatCompletionRequest({
    selectedModel: config.model,
    messages: [
      {
        role: "system",
        content:
          "你是缺陷重复检索助手。请基于候选结果给出简洁中文总结，说明最可能的重复票、判断依据、以及下一步建议。若候选不足，请明确指出证据不足。控制在6行内。",
      },
      {
        role: "user",
        content: buildUserPrompt(query, result),
      },
    ],
    env: process.env,
  });

  try {
    const response = await fetch(requestConfig.url, {
      method: "POST",
      headers: requestConfig.headers,
      body: JSON.stringify(requestConfig.body),
    });

    if (!response.ok) {
      throw new Error(`summary request failed with ${response.status}`);
    }

    const payload = await response.json();
    const content = String(payload?.choices?.[0]?.message?.content || "").trim();
    if (!content) {
      throw new Error("summary model returned empty content");
    }

    return {
      summaryText: content,
      answerModel: config.model,
      summarySource: "llm",
    };
  } catch {
    return {
      summaryText: fallbackSummary,
      answerModel: "Duplicate Search Agent",
      summarySource: "fallback",
    };
  }
}
