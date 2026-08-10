import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";

import { useMainDashboardData } from "@/components/dashboard/main-dashboard/useMainDashboardData";

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
}));

describe("useMainDashboardData", () => {
  beforeEach(() => {
    vi.mocked(useQuery).mockReset();
    vi.mocked(useQuery).mockReturnValue({} as ReturnType<typeof useQuery>);
  });

  it("disables automatic background refetches for the large dashboard payload", () => {
    useMainDashboardData();

    expect(useQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["main-dashboard", {}],
        staleTime: 60_000,
        retry: 0,
        refetchOnMount: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
      }),
    );
  });
});