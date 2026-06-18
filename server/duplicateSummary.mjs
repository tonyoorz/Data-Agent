import { buildChatCompletionRequest, resolveChatModelConfig } from "./chatModelConfig.mjs";

function normalizeEvidenceSnippet(value, maxLength = 180) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeShortSummary(value, maxLength = 140) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function buildConfidenceLevel(score) {
  const numeric = Number(score || 0);
  if (numeric >= 8) {
    return "高置信";
  }
  if (numeric >= 6) {
    return "中等置信";
  }
  if (numeric >= 4) {
    return "低置信";
  }
  return "弱相关";
}

function collectEvidenceSnippets(candidate, maxItems = 2, maxLength = 180) {
  if (!Array.isArray(candidate.evidenceSnippets)) {
    return [];
  }

  return candidate.evidenceSnippets
    .map((item) => normalizeEvidenceSnippet(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function buildEvidenceLines(candidate) {
  const evidence = collectEvidenceSnippets(candidate, 2, 180);

  return evidence.map((item, index) => `证据${index + 1}: ${item}`);
}

function buildReasonLines(candidate) {
  const lines = [];
  const snippet = normalizeShortSummary(candidate?.snippet, 140);
  const evidence = collectEvidenceSnippets(candidate, 2, 120);

  if (snippet) {
    lines.push(`现象匹配: ${snippet}`);
  }
  if (evidence.length) {
    lines.push(`评论分析: ${evidence.join("；")}`);
  }

  return lines;
}

function buildFallbackSummary(result) {
  const head = [
    `检索完成：返回 ${result.candidates.length} 条候选`,
    `模型阶段：${result.modelPhase}`,
    `反馈样本：${result.feedbackCount}`,
  ];

  if (!result.candidates.length) {
    return `${head.join(" · ")}\n\n未找到足够相似的问题，请补充项目、PU、现象关键词后重试。`;
  }

  const topCandidate = result.candidates[0];
  const topEvidence = collectEvidenceSnippets(topCandidate, 2, 90);
  const top = result.candidates.slice(0, 3).map((item, idx) => {
    const title = item.name || "Untitled";
    const ticket = item.ticketId || "N/A";
    const confidenceLevel = buildConfidenceLevel(item.score1to10);
    return `${idx + 1}. [${ticket}] ${title} (${confidenceLevel})`;
  });

  const topTitle = topCandidate.name || "Untitled";
  const topTicket = topCandidate.ticketId || "N/A";
  const topScore = Number(topCandidate.score1to10 || 0);
  const topConfidenceLevel = buildConfidenceLevel(topScore);
  const topReasonLines = buildReasonLines(topCandidate);

  const fallbackEvidence = topEvidence.length
    ? `评论分析: ${topEvidence.join("；")}`
    : "评论分析: 当前候选缺少足够 comments 证据，需补充现象关键词或日志上下文。";

  const confidenceLine = topScore >= 8
    ? "判断: 当前候选置信度较高，优先核对关键现象、日志和 comments 中的分析过程。"
    : topScore >= 6
      ? "判断: 当前候选有一定把握，但仍需结合 comments 分析和上下文差异继续复核。"
      : topScore >= 4
        ? "判断: 当前候选相关性有限，应重点核对差异项，不宜直接判定重复。"
        : "判断: 当前更像弱相关候选，仅适合作为复核起点。";

  return [
    head.join(" · "),
    "",
    `最可能重复票: ${topTicket}。标题“${topTitle}”，置信度: ${topConfidenceLevel}。`,
    ...topReasonLines,
    fallbackEvidence,
    confidenceLine,
    `候选概览: ${top.join("；")}`,
    "建议: 优先核对 ticket 描述、comments 分析过程以及关键日志是否一致。",
  ].join("\n");
}

function buildAnchoredTopLine(result) {
  const topCandidate = Array.isArray(result?.candidates) ? result.candidates[0] : null;
  if (!topCandidate) {
    return "";
  }

  const topTicket = topCandidate.ticketId || "N/A";
  const topTitle = normalizeShortSummary(topCandidate.name || "Untitled", 160);
  const topScore = Number(topCandidate.score1to10 || 0);
  const topConfidenceLevel = buildConfidenceLevel(topScore);

  if (topScore >= 8) {
    return `最可能重复票: ${topTicket}。标题“${topTitle}”，置信度: ${topConfidenceLevel}。`;
  }
  if (topScore >= 6) {
    return `当前排序第一候选: ${topTicket}。标题“${topTitle}”，置信度: ${topConfidenceLevel}，建议继续复核。`;
  }
  if (topScore >= 4) {
    return `当前排序第一候选: ${topTicket}。标题“${topTitle}”，置信度: ${topConfidenceLevel}，需要重点复核差异。`;
  }
  return `当前排序第一候选: ${topTicket}。标题“${topTitle}”，置信度: ${topConfidenceLevel}，仅作复核起点。`;
}

function anchorSummaryToTopCandidate(summaryText, result) {
  const anchoredTopLine = buildAnchoredTopLine(result);
  if (!anchoredTopLine) {
    return String(summaryText || "").trim();
  }

  const normalizedLines = String(summaryText || "")
    .split(/\r?\n/)
    .map((line) => String(line || "").trim())
    .filter(Boolean);

  if (!normalizedLines.length) {
    return anchoredTopLine;
  }

  return [anchoredTopLine, ...normalizedLines.slice(1)].join("\n");
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
        `置信度等级: ${buildConfidenceLevel(candidate.score1to10)}`,
        `元信息: ${meta}`,
        `摘要: ${candidate.snippet || "无"}`,
        ...buildEvidenceLines(candidate),
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
          "你是缺陷重复检索助手。请基于候选结果输出 4 到 6 行中文结论。必须以候选结果第 1 名作为首行锚点，不得改写成其他票号，也不得改写该候选的置信度等级。若置信度不高，可以明确说明只是当前排序第一候选、仍需复核。第 2 到第 3 行总结与用户问题最相关的相似点，优先使用 comments/evidence 中的分析过程、日志现象或根因信息，不要只复述标题；再说明最关键的不确定点或差异；最后 1 行给出复核建议。若证据不足，要明确指出 comments 证据不足。语气专业、具体、可执行。",
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

    const anchoredSummary = anchorSummaryToTopCandidate(content, result);

    return {
      summaryText: anchoredSummary,
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
