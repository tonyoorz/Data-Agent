import { useQuery } from "@tanstack/react-query";

import { fetchMainDashboardData } from "./mainDashboardApi";
import type { MainDashboardFilters } from "./mainDashboardTypes";

export function useMainDashboardData(filters: Partial<MainDashboardFilters> = {}) {
  return useQuery({
    queryKey: ["main-dashboard", filters],
    queryFn: () => fetchMainDashboardData(filters),
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: 0,
  });
}