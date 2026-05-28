import { keepPreviousData, useQuery } from "@tanstack/react-query";

import type {
  MainDashboardFilters,
  MainDashboardTicketsPageRequest,
} from "./mainDashboardTypes";
import { fetchMainDashboardTickets } from "./mainDashboardApi";


export function useMainDashboardTickets(
  filters: Partial<MainDashboardFilters>,
  pageRequest: MainDashboardTicketsPageRequest,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ["main-dashboard", "tickets", filters, pageRequest],
    queryFn: () => fetchMainDashboardTickets(filters, pageRequest),
    enabled: options?.enabled ?? true,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: 0,
  });
}