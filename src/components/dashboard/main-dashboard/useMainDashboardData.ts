import { useQuery } from "@tanstack/react-query";

import { fetchMainDashboardData } from "./mainDashboardApi";

export function useMainDashboardData() {
  return useQuery({
    queryKey: ["main-dashboard"],
    queryFn: () => fetchMainDashboardData(),
    staleTime: 60_000,
    retry: 0,
  });
}