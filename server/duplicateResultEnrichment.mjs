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
  const reviewFocusByTicket = new Map(
    (Array.isArray(summary?.candidateAnalyses) ? summary.candidateAnalyses : [])
      .map((item) => [normalizeText(item?.ticketId), normalizeText(item?.reviewFocus)])
      .filter(([ticketId, reviewFocus]) => ticketId && reviewFocus),
  );

  return {
    ...result,
    candidates: Array.isArray(result.candidates)
      ? result.candidates.map((candidate) => ({
          ...candidate,
          reviewFocus: reviewFocusByTicket.get(normalizeText(candidate?.ticketId)) || candidate.reviewFocus,
        }))
      : result.candidates,
    summaryText: summary.summaryText,
    answerModel: summary.answerModel,
    summarySource: summary.summarySource,
  };
}
