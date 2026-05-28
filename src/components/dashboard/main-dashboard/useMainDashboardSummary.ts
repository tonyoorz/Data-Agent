import { keepPreviousData, useQuery } from "@tanstack/react-query";

import type { MainDashboardFilters } from "./mainDashboardTypes";
import { fetchMainDashboardSummary } from "./mainDashboardApi";


export function useMainDashboardSummary(filters: Partial<MainDashboardFilters>) {
  return useQuery({
    queryKey: ["main-dashboard", "summary", filters],
    queryFn: () => fetchMainDashboardSummary(filters),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: 0,
  });
}