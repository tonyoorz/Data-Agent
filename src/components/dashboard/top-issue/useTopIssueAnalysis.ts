import { useQuery } from "@tanstack/react-query";

import { fetchTopIssueAnalysis } from "./topIssueApi";
import type { TopIssueAnalysisQuery } from "./topIssueTypes";

export function useTopIssueAnalysis(
  filters: TopIssueAnalysisQuery,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ["top-issue", "analysis", filters],
    queryFn: () => fetchTopIssueAnalysis(filters),
    enabled: options?.enabled ?? true,
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: 0,
  });
}