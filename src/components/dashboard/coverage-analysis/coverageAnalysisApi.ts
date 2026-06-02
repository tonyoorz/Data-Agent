import {
  coverageAnalysisFilterFieldMappings,
  type CoverageAnalysisAidaStatusRow,
  type CoverageAnalysisFilterOptions,
  type CoverageAnalysisFilters,
  type CoverageAnalysisPageData,
  type CoverageAnalysisProjectStatusRow,
  type CoverageAnalysisTestcaseDetailRow,
} from "./coverageAnalysisTypes";

export const DEFAULT_TESTCASE_DETAIL_LIMIT = 500;

export type CoverageAnalysisOverviewData = Omit<CoverageAnalysisPageData, "testcaseDetailRows">;

type CoverageAnalysisFilterOptionsResponse = {
  years: string[];
  projects: string[];
  test_weeks: string[];
  pus: string[];
  aidas: string[];
  statuses: string[];
  feature_regions: string[];
  fvps: string[];
  fvs: string[];
};

type CoverageAnalysisErrorResponse = {
  error?: unknown;
  missing_fields?: unknown;
};

export class CoverageAnalysisApiError extends Error {
  status: number;
  missingFields: string[];

  constructor(message: string, options?: { status?: number; missingFields?: string[] }) {
    super(message);
    this.name = "CoverageAnalysisApiError";
    this.status = options?.status ?? 0;
    this.missingFields = options?.missingFields ?? [];
  }
}

function buildCoverageAnalysisUrl(
  basePath: string,
  filters: Partial<CoverageAnalysisFilters>,
  extraParams: Record<string, string | number | undefined> = {},
) {
  const params = new URLSearchParams();

  for (const { frontendKey, backendKey } of coverageAnalysisFilterFieldMappings) {
    const values = filters[frontendKey];
    if (!values?.length) {
      continue;
    }

    values.forEach((value) => {
      params.append(backendKey, value);
    });
  }

  Object.entries(extraParams).forEach(([key, value]) => {
    if (value === undefined || value === "") {
      return;
    }

    params.append(key, String(value));
  });

  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

function normalizeMissingFields(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

async function extractErrorDetails(response: Response) {
  try {
    const payload = (await response.json()) as CoverageAnalysisErrorResponse;
    const missingFields = normalizeMissingFields(payload?.missing_fields);

    if (typeof payload?.error === "string" && payload.error.trim()) {
      return {
        message: payload.error,
        missingFields,
      };
    }

    return {
      message: "",
      missingFields,
    };
  } catch {
    // Ignore invalid JSON error bodies and fall back to status text.
  }

  if (response.statusText) {
    return {
      message: response.statusText,
      missingFields: [],
    };
  }

  return {
    message: `Request failed with status ${response.status}`,
    missingFields: [],
  };
}

async function fetchJson<T>(url: string, label: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const { message, missingFields } = await extractErrorDetails(response);
    throw new CoverageAnalysisApiError(`Failed to load ${label}: ${message}`, {
      status: response.status,
      missingFields,
    });
  }

  return response.json() as Promise<T>;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function adaptCoverageAnalysisFilterOptions(
  payload: CoverageAnalysisFilterOptionsResponse,
): CoverageAnalysisFilterOptions {
  return {
    years: normalizeStringArray(payload.years),
    projects: normalizeStringArray(payload.projects),
    testWeeks: normalizeStringArray(payload.test_weeks),
    pus: normalizeStringArray(payload.pus),
    aidas: normalizeStringArray(payload.aidas),
    statuses: normalizeStringArray(payload.statuses),
    featureRegions: normalizeStringArray(payload.feature_regions),
    fvps: normalizeStringArray(payload.fvps),
    fvs: normalizeStringArray(payload.fvs),
  };
}

export async function fetchCoverageAnalysisPageData(
  filters: Partial<CoverageAnalysisFilters> = {},
): Promise<CoverageAnalysisPageData> {
  const overviewData = await fetchCoverageAnalysisOverviewData(filters);
  const testcaseDetailRows = await fetchCoverageAnalysisTestcaseDetailRows(filters);

  return {
    ...overviewData,
    testcaseDetailRows,
  };
}

export async function fetchCoverageAnalysisOverviewData(
  filters: Partial<CoverageAnalysisFilters> = {},
): Promise<CoverageAnalysisOverviewData> {
  const [filterOptions, projectStatusRows, aidaStatusRows] =
    await Promise.all([
      fetchCoverageAnalysisFilterOptions(filters),
      fetchCoverageAnalysisProjectStatusRows(filters),
      fetchCoverageAnalysisAidaStatusRows(filters),
    ]);

  return {
    filterOptions,
    projectStatusRows,
    aidaStatusRows,
  };
}

export async function fetchCoverageAnalysisFilterOptions(
  filters: Partial<CoverageAnalysisFilters> = {},
): Promise<CoverageAnalysisFilterOptions> {
  const filtersUrl = buildCoverageAnalysisUrl(
    "/api/testing/coverage-analysis/filters",
    filters,
  );

  const payload = await fetchJson<CoverageAnalysisFilterOptionsResponse>(
    filtersUrl,
    "coverage filters",
  );

  return adaptCoverageAnalysisFilterOptions(payload);
}

export async function fetchCoverageAnalysisProjectStatusRows(
  filters: Partial<CoverageAnalysisFilters> = {},
): Promise<CoverageAnalysisProjectStatusRow[]> {
  const projectStatusUrl = buildCoverageAnalysisUrl(
    "/api/testing/coverage-analysis/project-status",
    filters,
  );

  return fetchJson<CoverageAnalysisProjectStatusRow[]>(
    projectStatusUrl,
    "coverage project status",
  );
}

export async function fetchCoverageAnalysisAidaStatusRows(
  filters: Partial<CoverageAnalysisFilters> = {},
): Promise<CoverageAnalysisAidaStatusRow[]> {
  const aidaStatusUrl = buildCoverageAnalysisUrl(
    "/api/testing/coverage-analysis/aida-status",
    filters,
  );

  return fetchJson<CoverageAnalysisAidaStatusRow[]>(
    aidaStatusUrl,
    "coverage AIDA status",
  );
}

export async function fetchCoverageAnalysisTestcaseDetailRows(
  filters: Partial<CoverageAnalysisFilters> = {},
  limit = DEFAULT_TESTCASE_DETAIL_LIMIT,
): Promise<CoverageAnalysisTestcaseDetailRow[]> {
  const testcaseDetailUrl = buildCoverageAnalysisUrl(
    "/api/testing/coverage-analysis/testcase-detail",
    filters,
    { limit },
  );

  return fetchJson<CoverageAnalysisTestcaseDetailRow[]>(
    testcaseDetailUrl,
    "coverage testcase detail",
  );
}

export { buildCoverageAnalysisUrl };