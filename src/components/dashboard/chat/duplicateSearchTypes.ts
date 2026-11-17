export type DuplicateFeedbackSignal = "positive" | "negative" | "click";

export type DuplicateLlmVerdict = "duplicate" | "not_duplicate" | "uncertain";

export interface DuplicateSearchCandidate {
  score1to10: number;
  confidenceScore1to10?: number;
  confidenceLabel?: "high" | "medium" | "low" | "review" | string;
  similarity: number;
  ticketId: string;
  name: string;
  project?: string;
  pu?: string;
  statusPhase?: string;
  snippet: string;
  reviewFocus?: string;
  evidenceSnippets?: string[];
  llmVerdict?: DuplicateLlmVerdict;
  llmVerdictReason?: string;
  rankingSignals?: {
    denseRank?: number | null;
    denseScore?: number | null;
    sparseRank?: number | null;
    sparseScore?: number | null;
    denseWeight?: number | null;
    sparseWeight?: number | null;
    crossEncoderScore?: number | null;
  };
}

export interface DuplicateSearchResult {
  searchId: string;
  queryText: string;
  candidates: DuplicateSearchCandidate[];
  modelPhase: string;
  crossEncoderRerank?: boolean;
  feedbackCount: number;
  summaryText?: string;
  answerModel?: string;
  summarySource?: "llm" | "fallback";
}
