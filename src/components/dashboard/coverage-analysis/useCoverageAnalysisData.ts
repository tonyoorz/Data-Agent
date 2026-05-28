import { useQuery } from "@tanstack/react-query";

import {
  DEFAULT_TESTCASE_DETAIL_LIMIT,
  fetchCoverageAnalysisOverviewData,
  fetchCoverageAnalysisTestcaseDetailRows,
} from "./coverageAnalysisApi";
import type { CoverageAnalysisFilters } from "./coverageAnalysisTypes";

export function useCoverageAnalysisOverviewData(
  filters: Partial<CoverageAnalysisFilters> = {},
) {
  return useQuery({
    queryKey: ["coverage-analysis", "overview", filters],
    queryFn: () => fetchCoverageAnalysisOverviewData(filters),
    staleTime: 60_000,
    retry: 0,
  });
}

export function useCoverageAnalysisTestcaseDetailData(
  filters: Partial<CoverageAnalysisFilters> = {},
  options?: { enabled?: boolean; limit?: number },
) {
  const limit = options?.limit ?? DEFAULT_TESTCASE_DETAIL_LIMIT;

  return useQuery({
    queryKey: ["coverage-analysis", "testcase-detail", filters, limit],
    queryFn: () => fetchCoverageAnalysisTestcaseDetailRows(filters, limit),
    staleTime: 60_000,
    retry: 0,
    enabled: options?.enabled ?? true,
  });
}