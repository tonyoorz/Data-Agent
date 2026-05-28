import { useEffect, useState } from "react";
import { CheckCheck, CircleSlash, ThumbsDown, ThumbsUp } from "lucide-react";

import type {
  DuplicateFeedbackSignal,
  DuplicateSearchCandidate,
  DuplicateSearchResult,
} from "./duplicateSearchTypes";

type DuplicateSearchResultsProps = {
  result: DuplicateSearchResult;
  allowFeedback?: boolean;
};

const DuplicateSearchResults = ({
  result,
  allowFeedback = true,
}: DuplicateSearchResultsProps) => {
  const [feedbackHint, setFeedbackHint] = useState("");
  const [loadingKey, setLoadingKey] = useState("");
  const [visibleFeedbackCount, setVisibleFeedbackCount] = useState(result.feedbackCount);
  const [feedbackByTicket, setFeedbackByTicket] = useState<
    Record<string, DuplicateFeedbackSignal>
  >({});

  useEffect(() => {
    setFeedbackHint("");
    setLoadingKey("");
    setVisibleFeedbackCount(result.feedbackCount);
    setFeedbackByTicket({});
  }, [result.feedbackCount, result.searchId]);

  const submitFeedback = async (
    candidate: DuplicateSearchCandidate,
    signal: DuplicateFeedbackSignal,
    rankPos: number,
  ) => {
    if (!candidate.ticketId) {
      return;
    }

    const key = `${candidate.ticketId}:${signal}`;
    setLoadingKey(key);

    try {
      const response = await fetch("/api/duplicate-feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          queryText: result.queryText,
          ticketId: candidate.ticketId,
          signal,
          baseScore: candidate.similarity,
          rankPos,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        result?: { feedback_count?: number };
      };

      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "反馈提交失败");
      }

      const feedbackCount = payload.result?.feedback_count;
      setFeedbackByTicket((current) => ({
        ...current,
        [candidate.ticketId]: signal,
      }));
      if (feedbackCount != null) {
        setVisibleFeedbackCount(feedbackCount);
      }
      setFeedbackHint(
        feedbackCount == null ? "已记录反馈" : `已记录反馈，累计 ${feedbackCount} 条`,
      );
    } catch {
      setFeedbackHint("反馈提交失败，请稍后重试");
    } finally {
      setLoadingKey("");
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-border/70 bg-card/70 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2">
        <div>
          <p className="text-sm font-semibold text-foreground">候选缺陷</p>
          <p className="text-xs text-muted-foreground">
            共 {result.candidates.length} 条 · 阶段 {result.modelPhase} · 反馈 {visibleFeedbackCount}
          </p>
        </div>
      </div>
      <ul aria-label="候选缺陷列表" className="mt-2 divide-y divide-border/60">
        {result.candidates.map((candidate, index) => {
          const feedback = candidate.ticketId ? feedbackByTicket[candidate.ticketId] : undefined;
          const positiveKey = `${candidate.ticketId}:positive`;
          const negativeKey = `${candidate.ticketId}:negative`;
          const isPositiveLoading = loadingKey === positiveKey;
          const isNegativeLoading = loadingKey === negativeKey;

          return (
            <li
              key={`${candidate.ticketId || "candidate"}-${index}`}
              className="flex gap-3 py-3 first:pt-1 last:pb-1"
            >
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                {index + 1}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                    {candidate.ticketId || "N/A"}
                  </span>
                  <span className="min-w-0 text-sm font-semibold text-foreground">
                    {candidate.name || "Untitled issue"}
                  </span>
                  <span className="text-[11px] font-medium text-muted-foreground">
                    评分 {candidate.score1to10}/10
                  </span>
                  {feedback === "positive" ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600">
                      <CheckCheck className="h-3 w-3" /> 已标记命中
                    </span>
                  ) : null}
                  {feedback === "negative" ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      <CircleSlash className="h-3 w-3" /> 已标记不相关
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {candidate.snippet || "No snippet available"}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="rounded-full bg-muted px-2 py-0.5">
                    {candidate.project || "project: -"}
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5">
                    {candidate.pu || "pu: -"}
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5">
                    {`Phase ${candidate.statusPhase || "-"}`}
                  </span>
                </div>
              </div>
              {allowFeedback ? (
                <div className="flex shrink-0 items-start gap-1.5">
                  <button
                    type="button"
                    onClick={() => submitFeedback(candidate, "positive", index + 1)}
                    disabled={loadingKey !== ""}
                    aria-label={`${candidate.ticketId || `candidate-${index + 1}`} 命中`}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                    title={isPositiveLoading ? "正在提交命中反馈" : "标记为命中"}
                  >
                    <ThumbsUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => submitFeedback(candidate, "negative", index + 1)}
                    disabled={loadingKey !== ""}
                    aria-label={`${candidate.ticketId || `candidate-${index + 1}`} 不相关`}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                    title={isNegativeLoading ? "正在提交不相关反馈" : "标记为不相关"}
                  >
                    <ThumbsDown className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {allowFeedback && feedbackHint ? (
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {feedbackHint}
        </p>
      ) : null}
    </div>
  );
};

export default DuplicateSearchResults;
