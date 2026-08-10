import { buildChatCompletionRequest, resolveChatModelConfig } from "./chatModelConfig.mjs";

function resolveSummaryTimeoutMs(env = process.env) {
  const raw = Number(env.DUPLICATE_SUMMARY_TIMEOUT_MS || 2500);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 2500;
  }
  return Math.max(250, Math.floor(raw));
}

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

function normalizeSummaryText(value, maxLength = 900) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => normalizeEvidenceSnippet(line, 260))
    .filter(Boolean);
  return lines.join("\n").slice(0, maxLength).trim();
}

function buildConfidenceLevel(score, language = "zh") {
  const numeric = Number(score || 0);
  const english = language === "en";
  if (numeric >= 8) {
    return english ? "high confidence" : "高置信";
  }
  if (numeric >= 6) {
    return english ? "medium confidence" : "中等置信";
  }
  if (numeric >= 4) {
    return english ? "low confidence" : "低置信";
  }
  return english ? "weak match" : "弱相关";
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

function candidateConfidenceScore(candidate) {
  return candidate?.confidenceScore1to10 ?? candidate?.score1to10;
}

function candidateSimilarityScore(candidate) {
  return candidate?.score1to10;
}

function compareByReviewPriority(left, right) {
  return (
    Number(candidateConfidenceScore(right) || 0) - Number(candidateConfidenceScore(left) || 0) ||
    Number(candidateSimilarityScore(right) || 0) - Number(candidateSimilarityScore(left) || 0) ||
    Number(right?.similarity || 0) - Number(left?.similarity || 0)
  );
}

function orderedCandidates(result) {
  return [...(Array.isArray(result?.candidates) ? result.candidates : [])].sort(compareByReviewPriority);
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

function buildCandidateReviewFocus(candidate, language = "zh") {
  const ticket = candidate?.ticketId || "N/A";
  const evidence = collectEvidenceSnippets(candidate, 1, 120);
  const snippet = normalizeEvidenceSnippet(candidate?.snippet || "", 120);
  const english = language === "en";

  if (evidence.length) {
    return english
      ? `D${ticket}: use the comment evidence to compare platform, trigger path, timestamp, and logs.`
      : `D${ticket}: 优先核对 comments/evidence 中的同类现象，再比对平台、触发路径、时间戳和日志。`;
  }
  if (snippet) {
    return english
      ? `D${ticket}: comment evidence is limited; compare symptom wording, platform, trigger path, timestamp, and logs.`
      : `D${ticket}: comments 证据有限，先核对现象描述相似性，再比对平台、触发路径、时间戳和日志。`;
  }
  return english
    ? `D${ticket}: evidence is limited; compare platform, trigger path, timestamp, and logs before linking.`
    : `D${ticket}: 证据有限，关联前先核对平台、触发路径、时间戳和日志。`;
}

function buildCandidateAnalyses(result, language = "zh") {
  return orderedCandidates(result).slice(0, 5).map((candidate) => ({
    ticketId: candidate.ticketId || "N/A",
    reviewFocus: buildCandidateReviewFocus(candidate, language),
  }));
}

function extractStructuredSummary(content) {
  const raw = String(content || "").trim();
  if (!raw) {
    return null;
  }
  const unwrapped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(unwrapped);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const summaryText = normalizeSummaryText(parsed.summaryText || parsed.summary || "", 900);
    const candidateAnalyses = Array.isArray(parsed.candidateAnalyses)
      ? parsed.candidateAnalyses
          .map((item) => ({
            ticketId: normalizeEvidenceSnippet(item?.ticketId || "", 40),
            reviewFocus: normalizeEvidenceSnippet(item?.reviewFocus || item?.analysis || "", 260),
          }))
          .filter((item) => item.ticketId && item.reviewFocus)
      : [];
    if (!summaryText && !candidateAnalyses.length) {
      return null;
    }
    return { summaryText, candidateAnalyses };
  } catch {
    return null;
  }
}

function buildFallbackSummary(result, language = "zh") {
  const english = language === "en";
  const head = [
    english ? `Search complete: ${result.candidates.length} candidates` : `检索完成：返回 ${result.candidates.length} 条候选`,
    english ? `Model stage: ${result.modelPhase}` : `模型阶段：${result.modelPhase}`,
    english ? `Feedback samples: ${result.feedbackCount}` : `反馈样本：${result.feedbackCount}`,
  ];

  const candidates = orderedCandidates(result);

  if (!candidates.length) {
    return english
      ? `${head.join(" · ")}\n\nNo strong duplicate candidate found. Add project, PU, symptom keywords, and logs, then rerun.`
      : `${head.join(" · ")}\n\n未找到足够相似的问题，请补充项目、PU、现象关键词后重试。`;
  }

  const topCandidate = candidates[0];
  const topEvidence = collectEvidenceSnippets(topCandidate, 2, 90);
  const topTitle = topCandidate.name || "Untitled";
  const topTicket = topCandidate.ticketId || "N/A";
  const topScore = Number(candidateConfidenceScore(topCandidate) || 0);
  const topSimilarityScore = Number(candidateSimilarityScore(topCandidate) || 0);
  const topConfidenceLevel = buildConfidenceLevel(topScore, language);
  const basis = topEvidence.length
    ? topEvidence.join(english ? "; " : "；")
    : normalizeShortSummary(topCandidate.snippet, 120) || (english ? "comment evidence is limited" : "当前候选缺少足够 comments 证据");

  if (english) {
    return [
      head.join(" · "),
      "",
      `Review first: D${topTicket} "${topTitle}". Confidence ${topConfidenceLevel} (${topScore}/10), similarity ${topSimilarityScore}/10.`,
      `Basis: ${basis}.`,
      "Next step: compare platform, trigger path, timestamp, and logs before linking.",
    ].join("\n");
  }

  return [
    head.join(" · "),
    "",
    `优先复核: D${topTicket}“${topTitle}”。复核置信度 ${topConfidenceLevel} (${topScore}/10)，相似度 ${topSimilarityScore}/10。`,
    `依据: ${basis}。`,
    "下一步: 核对平台、触发路径、时间戳和日志后再关联。",
  ].join("\n");
}

function buildAnchoredTopLine(result, language = "zh") {
  const topCandidate = orderedCandidates(result)[0] || null;
  if (!topCandidate) {
    return "";
  }

  const topTicket = topCandidate.ticketId || "N/A";
  const topTitle = normalizeShortSummary(topCandidate.name || "Untitled", 160);
  const topScore = Number(candidateConfidenceScore(topCandidate) || 0);
  const topConfidenceLevel = buildConfidenceLevel(topScore, language);

  if (language === "en") {
    if (topScore >= 8) {
      return `Most likely duplicate: ${topTicket}. Title "${topTitle}", confidence: ${topConfidenceLevel}.`;
    }
    if (topScore >= 6) {
      return `Current top candidate: ${topTicket}. Title "${topTitle}", confidence: ${topConfidenceLevel}; continue review before linking.`;
    }
    if (topScore >= 4) {
      return `Current top candidate: ${topTicket}. Title "${topTitle}", confidence: ${topConfidenceLevel}; focus on differences.`;
    }
    return `Current top candidate: ${topTicket}. Title "${topTitle}", confidence: ${topConfidenceLevel}; use only as a review starting point.`;
  }

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

function anchorSummaryToTopCandidate(summaryText, result, language = "zh") {
  const anchoredTopLine = buildAnchoredTopLine(result, language);
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

function buildUserPrompt(query, result, language = "zh") {
  const candidates = orderedCandidates(result)
    .slice(0, 5)
    .map((candidate, index) => {
      const meta = [candidate.project, candidate.pu, candidate.statusPhase]
        .filter(Boolean)
        .join(" / ") || "-";
      return [
        `${index + 1}. Ticket: ${candidate.ticketId || "N/A"}`,
        `标题: ${candidate.name || "Untitled"}`,
        language === "en"
          ? `Review confidence: ${buildConfidenceLevel(candidateConfidenceScore(candidate), language)} (${candidateConfidenceScore(candidate) || 0}/10)`
          : `复核置信度: ${buildConfidenceLevel(candidateConfidenceScore(candidate))} (${candidateConfidenceScore(candidate) || 0}/10)`,
        language === "en"
          ? `Similarity score: ${candidateSimilarityScore(candidate) || 0}/10`
          : `相似度分数: ${candidateSimilarityScore(candidate) || 0}/10`,
        `元信息: ${meta}`,
        `摘要: ${candidate.snippet || "无"}`,
        ...buildEvidenceLines(candidate),
      ].join("\n");
    })
    .join("\n\n");

  return [
    language === "en" ? `User query: ${query}` : `用户问题：${query}`,
    language === "en" ? `Retrieval stage: ${result.modelPhase}` : `检索阶段：${result.modelPhase}`,
    language === "en" ? `Feedback samples: ${result.feedbackCount}` : `反馈样本：${result.feedbackCount}`,
    "",
    language === "en" ? "Candidate results:" : "候选结果：",
    candidates || (language === "en" ? "No candidates" : "无候选结果"),
  ].join("\n");
}

function buildSummarySystemPrompt(language = "zh") {
  if (language === "en") {
    return "You are a defect duplicate-search assistant. Output in English. Output JSON only; do not output markdown. All JSON string values must be in English. Use this schema: {\"summaryText\":\"exactly 3 short lines: conclusion, basis, next step\",\"candidateAnalyses\":[{\"ticketId\":\"candidate ticket id\",\"reviewFocus\":\"one specific actionable review sentence\"}]}. summaryText must anchor line 1 to candidate rank 1 and must not change its ticket id or confidence level. Keep basis concise and avoid repeating the same evidence in multiple lines. candidateAnalyses must include one concrete review focus for each candidate, prioritizing comments/evidence, log symptoms, root-cause clues, and observed behavior. If evidence is insufficient, say which items to verify: platform, trigger path, timestamp, logs, lifecycle, or software version. Do not merely repeat titles.";
  }
  return "你是缺陷重复检索助手。请基于候选结果输出 JSON，不要输出 markdown。格式为 {\"summaryText\":\"严格 3 行短结论：结论、依据、下一步\",\"candidateAnalyses\":[{\"ticketId\":\"候选票号\",\"reviewFocus\":\"一句具体复核分析\"}]}。summaryText 必须以候选结果第 1 名作为首行锚点，不得改写成其他票号，也不得改写该候选的置信度等级。依据只保留最关键的一条，不要把同一段 evidence 在现象、评论、判断里重复。candidateAnalyses 要为每个候选给一句可执行的复核重点，优先使用 comments/evidence 中的分析过程、日志现象或根因信息；证据不足时明确写需要核对平台、触发路径、时间戳和日志。不要只复述标题。";
}

export async function summarizeDuplicateResults(query, result, selectedModel, options = {}) {
  const language = options.language === "en" || process.env.DUPLICATE_SUMMARY_LANGUAGE === "en" ? "en" : "zh";
  const fallbackSummary = buildFallbackSummary(result, language);
  const fallbackCandidateAnalyses = buildCandidateAnalyses(result, language);
  const config = resolveChatModelConfig(selectedModel || "", process.env);

  if (!config.credential) {
    return {
      summaryText: fallbackSummary,
      answerModel: "Duplicate Search Agent",
      summarySource: "fallback",
      candidateAnalyses: fallbackCandidateAnalyses,
    };
  }

  const requestConfig = buildChatCompletionRequest({
    selectedModel: config.model,
    messages: [
      {
        role: "system",
        content: buildSummarySystemPrompt(language),
      },
      {
        role: "user",
        content: buildUserPrompt(query, result, language),
      },
    ],
    env: process.env,
  });

  try {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), resolveSummaryTimeoutMs(process.env));
    let response;
    try {
      response = await fetch(requestConfig.url, {
        method: "POST",
        headers: requestConfig.headers,
        body: JSON.stringify(requestConfig.body),
        signal: abortController.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`summary request failed with ${response.status}`);
    }

    const payload = await response.json();
    const content = String(payload?.choices?.[0]?.message?.content || "").trim();
    if (!content) {
      throw new Error("summary model returned empty content");
    }

    const structured = extractStructuredSummary(content);
    const summaryText = structured?.summaryText || content;
    const anchoredSummary = anchorSummaryToTopCandidate(summaryText, result, language);
    const candidateAnalyses = structured?.candidateAnalyses?.length
      ? structured.candidateAnalyses
      : fallbackCandidateAnalyses;

    return {
      summaryText: anchoredSummary,
      answerModel: config.model,
      summarySource: "llm",
      candidateAnalyses,
    };
  } catch {
    return {
      summaryText: fallbackSummary,
      answerModel: "Duplicate Search Agent",
      summarySource: "fallback",
      candidateAnalyses: fallbackCandidateAnalyses,
    };
  }
}
