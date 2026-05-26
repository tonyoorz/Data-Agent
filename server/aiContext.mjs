const AI_DEFECT_CONTEXT_CACHE_TTL_MS = Number(process.env.AI_DEFECT_CONTEXT_CACHE_TTL_MS || 5 * 60 * 1000);
const aiDefectContextCache = new Map();

function nowMs() {
  return performance.now();
}

function roundMs(value) {
  return Number(value.toFixed(1));
}

function normalizeSnippet(snippet) {
  return String(snippet || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(title) {
  return String(title || "").replace(/\s+/g, " ").trim();
}

function buildAiDefectContextCacheKey(queryText, topK) {
  return `${topK}:${String(queryText || "").trim().toLowerCase()}`;
}

function getCachedAiDefectContext(cacheKey) {
  const cached = aiDefectContextCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    aiDefectContextCache.delete(cacheKey);
    return null;
  }

  return cached.value;
}

function setCachedAiDefectContext(cacheKey, value) {
  aiDefectContextCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + AI_DEFECT_CONTEXT_CACHE_TTL_MS,
  });
}

export function clearAiDefectContextCache() {
  aiDefectContextCache.clear();
}

export function extractLatestUserQuery(messages) {
  if (!Array.isArray(messages)) {
    return "";
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") {
      continue;
    }

    const content = message?.content;
    if (typeof content === "string" && content.trim()) {
      return content.trim();
    }

    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part === "string") {
            return part;
          }

          if (part && typeof part === "object" && typeof part.text === "string") {
            return part.text;
          }

          return "";
        })
        .join("\n")
        .trim();

      if (text) {
        return text;
      }
    }
  }

  return "";
}

export function formatAiDefectContext(queryText, duplicateSearchResult) {
  if (!duplicateSearchResult?.candidates?.length) {
    return "";
  }

  const candidates = duplicateSearchResult.candidates.slice(0, 5).map((candidate, index) => {
    const meta = [candidate.project, candidate.pu, candidate.statusPhase]
      .filter(Boolean)
      .join(" / ") || "-";

    return [
      `${index + 1}. Ticket ${candidate.ticketId || "N/A"}`,
      `标题: ${normalizeTitle(candidate.name) || "Untitled"}`,
      `评分: ${candidate.score1to10}/10`,
      `元信息: ${meta}`,
      `摘要: ${normalizeSnippet(candidate.snippet) || "无"}`,
    ].join("\n");
  });

  return [
    `# Defect context from qgate`,
    `用户问题: ${queryText}`,
    `候选缺陷数: ${duplicateSearchResult.candidates.length}`,
    `模型阶段: ${duplicateSearchResult.modelPhase}`,
    `反馈样本: ${duplicateSearchResult.feedbackCount}`,
    `数据集规模: ${duplicateSearchResult.dataset_size ?? "unknown"}`,
    "",
    "最相关候选:",
    ...candidates,
  ].join("\n");
}

export async function resolveAiDefectContext({ runDuplicateBridge, messages, topK = 5 }) {
  const startedAt = nowMs();
  const queryText = extractLatestUserQuery(messages);
  if (!queryText) {
    return {
      queryText: "",
      contextText: "",
      duplicateSearchResult: null,
      timings: {
        cacheHit: false,
        bridgeMs: 0,
        bridgeTimings: null,
        totalMs: roundMs(nowMs() - startedAt),
        skippedReason: "empty_query",
      },
    };
  }

  const cacheKey = buildAiDefectContextCacheKey(queryText, topK);
  const cached = getCachedAiDefectContext(cacheKey);
  if (cached) {
    return {
      ...cached,
      timings: {
        cacheHit: true,
        bridgeMs: 0,
        bridgeTimings: cached.duplicateSearchResult?.timings || null,
        totalMs: roundMs(nowMs() - startedAt),
      },
    };
  }

  const bridgeStartedAt = nowMs();
  const result = await runDuplicateBridge({
    action: "search",
    query: queryText,
    top_k: topK,
  });
  const bridgeMs = roundMs(nowMs() - bridgeStartedAt);
  const bridgeTimings = result?.result?.timings || null;

  if (!result?.success || !result?.result) {
    return {
      queryText,
      contextText: "",
      duplicateSearchResult: null,
      timings: {
        cacheHit: false,
        bridgeMs,
        bridgeTimings,
        totalMs: roundMs(nowMs() - startedAt),
      },
    };
  }

  const resolvedValue = {
    queryText,
    contextText: formatAiDefectContext(queryText, result.result),
    duplicateSearchResult: result.result,
  };

  setCachedAiDefectContext(cacheKey, resolvedValue);

  return {
    ...resolvedValue,
    timings: {
      cacheHit: false,
      bridgeMs,
      bridgeTimings,
      totalMs: roundMs(nowMs() - startedAt),
    },
  };
}
