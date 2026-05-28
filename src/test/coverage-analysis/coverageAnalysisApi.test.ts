import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CoverageAnalysisApiError,
  fetchCoverageAnalysisPageData,
} from "@/components/dashboard/coverage-analysis/coverageAnalysisApi";

function createJsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("fetchCoverageAnalysisPageData", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the four TAP coverage-analysis endpoints with shared query params", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        createJsonResponse({
          years: ["2026"],
          projects: ["IDCEVO"],
          test_weeks: ["2026-CW21"],
          pus: ["PU1"],
          aidas: ["AIDA-1"],
          statuses: ["Passed"],
          feature_regions: ["China Specific"],
          fvps: ["Voice Experience"],
          fvs: ["Speech"],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse([
          {
            test_week: "2026-CW21",
            fv: "Speech",
            fvp: "Voice Experience",
            status: "Passed",
            count: 1,
          },
        ]),
      )
      .mockResolvedValueOnce(
        createJsonResponse([
          {
            test_week: "2026-CW21",
            top_aida: "AIDA-1",
            status: "Passed",
            count: 1,
          },
        ]),
      )
      .mockResolvedValueOnce(
        createJsonResponse([
          {
            test_id: "T-1",
            test_name: "Wake test",
            test_week: "2026-CW21",
            status: "Passed",
            top_aida: "AIDA-1",
            project: "IDCEVO",
            pu: "PU1",
            tester: "Tester-A",
            count: 1,
          },
        ]),
      );

    const data = await fetchCoverageAnalysisPageData({
      years: ["2026"],
      projects: ["IDCEVO", "Audio,Platform"],
      testWeeks: ["2026-CW21", "2026-CW22"],
      featureRegions: ["China Specific", "North,America"],
    });

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/testing/coverage-analysis/filters?years=2026&projects=IDCEVO&projects=Audio%2CPlatform&test_weeks=2026-CW21&test_weeks=2026-CW22&feature_regions=China+Specific&feature_regions=North%2CAmerica",
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/testing/coverage-analysis/project-status?years=2026&projects=IDCEVO&projects=Audio%2CPlatform&test_weeks=2026-CW21&test_weeks=2026-CW22&feature_regions=China+Specific&feature_regions=North%2CAmerica",
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "/api/testing/coverage-analysis/aida-status?years=2026&projects=IDCEVO&projects=Audio%2CPlatform&test_weeks=2026-CW21&test_weeks=2026-CW22&feature_regions=China+Specific&feature_regions=North%2CAmerica",
    );
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      "/api/testing/coverage-analysis/testcase-detail?years=2026&projects=IDCEVO&projects=Audio%2CPlatform&test_weeks=2026-CW21&test_weeks=2026-CW22&feature_regions=China+Specific&feature_regions=North%2CAmerica&limit=500",
    );

    expect(data.filterOptions).toEqual({
      years: ["2026"],
      projects: ["IDCEVO"],
      testWeeks: ["2026-CW21"],
      pus: ["PU1"],
      aidas: ["AIDA-1"],
      statuses: ["Passed"],
      featureRegions: ["China Specific"],
      fvps: ["Voice Experience"],
      fvs: ["Speech"],
    });
    expect(data.projectStatusRows[0].fv).toBe("Speech");
  });

  it("preserves missing_fields from backend not-ready responses", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            error: "testing coverage analysis data not ready",
            missing_fields: ["test_week", "top_aida"],
          },
          { status: 503, statusText: "Service Unavailable" },
        ),
      )
      .mockResolvedValueOnce(createJsonResponse([]))
      .mockResolvedValueOnce(createJsonResponse([]))
      .mockResolvedValueOnce(createJsonResponse([]));

    let thrownError: unknown;

    try {
      await fetchCoverageAnalysisPageData();
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(CoverageAnalysisApiError);
    expect(thrownError).toMatchObject({
      message: expect.stringContaining("testing coverage analysis data not ready"),
      missingFields: ["test_week", "top_aida"],
      status: 503,
    });
  });

  it("normalizes malformed filter payload fields to empty arrays", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        createJsonResponse({
          years: ["2026"],
          projects: null,
          pus: "PU1",
          aidas: ["AIDA-1"],
          statuses: undefined,
          feature_regions: ["China Specific"],
          fvps: { value: "Voice Experience" },
        }),
      )
      .mockResolvedValueOnce(createJsonResponse([]))
      .mockResolvedValueOnce(createJsonResponse([]))
      .mockResolvedValueOnce(createJsonResponse([]));

    const data = await fetchCoverageAnalysisPageData();

    expect(data.filterOptions).toEqual({
      years: ["2026"],
      projects: [],
      testWeeks: [],
      pus: [],
      aidas: ["AIDA-1"],
      statuses: [],
      featureRegions: ["China Specific"],
      fvps: [],
      fvs: [],
    });
  });
});