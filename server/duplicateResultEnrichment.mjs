import { summarizeDuplicateResults as defaultSummarizeDuplicateResults } from "./duplicateSummary.mjs";

function normalizeText(value) {
  return String(value || "").trim();
}

export async function attachDuplicateSummary({
  query,
  selectedModel,
  result,
  language,
  summarizeDuplicateResults = defaultSummarizeDuplicateResults,
}) {
  if (!result || typeof result !== "object") {
    return result;
  }

  const summary = await summarizeDuplicateResults(query, result, selectedModel, { language });
  const analysisByTicket = new Map(
    (Array.isArray(summary?.candidateAnalyses) ? summary.candidateAnalyses : [])
      .map((item) => [
        normalizeText(item?.ticketId),
        {
          reviewFocus: normalizeText(item?.reviewFocus),
          verdict: item?.verdict || null,
          verdictReason: normalizeText(item?.verdictReason),
        },
      ])
      .filter(([ticketId, analysis]) => ticketId && (analysis.reviewFocus || analysis.verdict)),
  );

  return {
    ...result,
    candidates: Array.isArray(result.candidates)
      ? result.candidates.map((candidate) => {
          const analysis = analysisByTicket.get(normalizeText(candidate?.ticketId));
          if (!analysis) {
            return candidate;
          }
          return {
            ...candidate,
            reviewFocus: analysis.reviewFocus || candidate.reviewFocus,
            ...(analysis.verdict
              ? {
                  llmVerdict: analysis.verdict,
                  llmVerdictReason: analysis.verdictReason || candidate.llmVerdictReason,
                }
              : {}),
          };
        })
      : result.candidates,
    summaryText: summary.summaryText,
    answerModel: summary.answerModel,
    summarySource: summary.summarySource,
  };
}
