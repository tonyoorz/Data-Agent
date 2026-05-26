import {
  coverageAnalysisFilterFieldMappings,
  type CoverageAnalysisAidaStatusRow,
  type CoverageAnalysisFilterOptions,
  type CoverageAnalysisFilters,
  type CoverageAnalysisPageData,
  type CoverageAnalysisProjectStatusRow,
  type CoverageAnalysisTestcaseDetailRow,
} from "./coverageAnalysisTypes";

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
  const filtersUrl = buildCoverageAnalysisUrl(
    "/api/testing/coverage-analysis/filters",
    filters,
  );
  const projectStatusUrl = buildCoverageAnalysisUrl(
    "/api/testing/coverage-analysis/project-status",
    filters,
  );
  const aidaStatusUrl = buildCoverageAnalysisUrl(
    "/api/testing/coverage-analysis/aida-status",
    filters,
  );
  const testcaseDetailUrl = buildCoverageAnalysisUrl(
    "/api/testing/coverage-analysis/testcase-detail",
    filters,
  );

  const [filterOptions, projectStatusRows, aidaStatusRows, testcaseDetailRows] =
    await Promise.all([
      fetchJson<CoverageAnalysisFilterOptionsResponse>(filtersUrl, "coverage filters"),
      fetchJson<CoverageAnalysisProjectStatusRow[]>(
        projectStatusUrl,
        "coverage project status",
      ),
      fetchJson<CoverageAnalysisAidaStatusRow[]>(
        aidaStatusUrl,
        "coverage AIDA status",
      ),
      fetchJson<CoverageAnalysisTestcaseDetailRow[]>(
        testcaseDetailUrl,
        "coverage testcase detail",
      ),
    ]);

  return {
    filterOptions: adaptCoverageAnalysisFilterOptions(filterOptions),
    projectStatusRows,
    aidaStatusRows,
    testcaseDetailRows,
  };
}

export { buildCoverageAnalysisUrl };