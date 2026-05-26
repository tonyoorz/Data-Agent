import { useQuery } from "@tanstack/react-query";

import { fetchCoverageAnalysisPageData } from "./coverageAnalysisApi";
import type { CoverageAnalysisFilters } from "./coverageAnalysisTypes";

export function useCoverageAnalysisData(
  filters: Partial<CoverageAnalysisFilters> = {},
) {
  return useQuery({
    queryKey: ["coverage-analysis", filters],
    queryFn: () => fetchCoverageAnalysisPageData(filters),
    staleTime: 60_000,
    retry: 0,
  });
}