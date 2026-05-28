import { useQuery } from "@tanstack/react-query";

import { fetchMainDashboardData } from "./mainDashboardApi";

export function useMainDashboardData() {
  return useQuery({
    queryKey: ["main-dashboard"],
    queryFn: () => fetchMainDashboardData(),
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: 0,
  });
}