export type DuplicateFeedbackSignal = "positive" | "negative";

export interface DuplicateSearchCandidate {
  score1to10: number;
  similarity: number;
  ticketId: string;
  name: string;
  project?: string;
  pu?: string;
  statusPhase?: string;
  snippet: string;
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
