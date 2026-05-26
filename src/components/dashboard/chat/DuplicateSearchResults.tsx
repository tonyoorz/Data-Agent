import { useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";

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
    <div className="mt-3 space-y-3 rounded-xl border border-border/70 bg-card/70 p-3">
      {result.candidates.map((candidate, index) => (
        <article
          key={`${candidate.ticketId || "candidate"}-${index}`}
          className="rounded-lg border border-border bg-background px-3 py-3 shadow-sm"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="rounded-md bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
              {candidate.ticketId || "N/A"}
            </span>
            <span className="text-xs font-medium text-muted-foreground">
              评分 {candidate.score1to10}/10
            </span>
          </div>
          <h4 className="mt-2 text-sm font-semibold text-foreground">
            {candidate.name || "Untitled issue"}
          </h4>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {candidate.snippet || "No snippet available"}
          </p>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
            <span className="rounded-full bg-muted px-2 py-1">
              {candidate.project || "project: -"}
            </span>
            <span className="rounded-full bg-muted px-2 py-1">
              {candidate.pu || "pu: -"}
            </span>
            <span className="rounded-full bg-muted px-2 py-1">
              {candidate.statusPhase || "phase: -"}
            </span>
          </div>
          {allowFeedback ? (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => submitFeedback(candidate, "positive", index + 1)}
                disabled={loadingKey !== ""}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
              >
                <ThumbsUp className="h-3.5 w-3.5" /> 命中
              </button>
              <button
                type="button"
                onClick={() => submitFeedback(candidate, "negative", index + 1)}
                disabled={loadingKey !== ""}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
              >
                <ThumbsDown className="h-3.5 w-3.5" /> 不相关
              </button>
            </div>
          ) : null}
        </article>
      ))}
      {allowFeedback && feedbackHint ? <p className="text-xs text-muted-foreground">{feedbackHint}</p> : null}
    </div>
  );
};

export default DuplicateSearchResults;
