export type DuplicateFeedbackSignal = "positive" | "negative" | "click";

export interface DuplicateSearchCandidate {
  score1to10: number;
  similarity: number;
  ticketId: string;
  name: string;
  project?: string;
  pu?: string;
  statusPhase?: string;
  snippet: string;
  evidenceSnippets?: string[];
  rankingSignals?: {
    denseRank?: number | null;
    denseScore?: number | null;
    sparseRank?: number | null;
    sparseScore?: number | null;
    denseWeight?: number | null;
    sparseWeight?: number | null;
  };
}

export interface DuplicateSearchResult {
  searchId: string;
  queryText: string;
  candidates: DuplicateSearchCandidate[];
  modelPhase: string;
  feedbackCount: number;
  summaryText?: string;
  answerModel?: string;
  summarySource?: "llm" | "fallback";
}
