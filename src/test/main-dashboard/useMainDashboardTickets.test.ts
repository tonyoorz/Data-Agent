import { beforeEach, describe, expect, it, vi } from "vitest";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { useMainDashboardSummary } from "@/components/dashboard/main-dashboard/useMainDashboardSummary";
import { useMainDashboardTickets } from "@/components/dashboard/main-dashboard/useMainDashboardTickets";

vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: vi.fn(),
  useQuery: vi.fn(),
}));

describe("main dashboard split data hooks", () => {
  beforeEach(() => {
    vi.mocked(useQuery).mockReset();
    vi.mocked(useQuery).mockReturnValue({} as ReturnType<typeof useQuery>);
  });

  it("loads summary data with a stable summary query key", () => {
    useMainDashboardSummary({ years: ["2026"] });

    expect(useQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["main-dashboard", "summary", { years: ["2026"] }],
        placeholderData: keepPreviousData,
        staleTime: 60_000,
        retry: 0,
        refetchOnMount: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
      }),
    );
  });

  it("loads ticket pages with filter and page request state in the query key", () => {
    useMainDashboardTickets(
      { years: ["2026"], projects: ["IDCEVO"] },
      {
        page: 1,
        pageSize: 50,
        search: "wake",
        sortBy: "ticketId",
        sortOrder: "asc",
        snapshotVersion: "snapshot-20260528-1",
      },
    );

    expect(useQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: [
          "main-dashboard",
          "tickets",
          { years: ["2026"], projects: ["IDCEVO"] },
          {
            page: 1,
            pageSize: 50,
            search: "wake",
            sortBy: "ticketId",
            sortOrder: "asc",
            snapshotVersion: "snapshot-20260528-1",
          },
        ],
        placeholderData: keepPreviousData,
        staleTime: 30_000,
        retry: 0,
      }),
    );
  });
});