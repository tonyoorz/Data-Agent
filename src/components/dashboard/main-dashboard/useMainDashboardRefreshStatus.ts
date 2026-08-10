import { useQuery } from "@tanstack/react-query";

import { fetchMainDashboardRefreshStatus } from "./mainDashboardApi";

export function useMainDashboardRefreshStatus() {
  return useQuery({
    queryKey: ["main-dashboard", "refresh-status"],
    queryFn: () => fetchMainDashboardRefreshStatus(),
    enabled: false,
    retry: 0,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
}