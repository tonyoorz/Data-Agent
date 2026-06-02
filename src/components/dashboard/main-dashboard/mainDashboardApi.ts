import {
  adaptMainDashboardPayload,
  adaptMainDashboardSummaryPayload,
  adaptMainDashboardTicketsPagePayload,
} from "./mainDashboardAdapter";
import {
  type MainDashboardFilters,
  type MainDashboardPayload,
  type MainDashboardSummaryPayload,
  type MainDashboardSummaryViewModel,
  type MainDashboardTicketsPage,
  type MainDashboardTicketsPagePayload,
  type MainDashboardTicketsPageRequest,
  type MainDashboardViewModel,
  mainDashboardFilterFieldMappings,
} from "./mainDashboardTypes";

const MAIN_DASHBOARD_API_PATH = "/api/full-picture/dashboard";
const MAIN_DASHBOARD_SUMMARY_API_PATH = "/api/full-picture/dashboard/summary";
const MAIN_DASHBOARD_TICKETS_API_PATH = "/api/full-picture/dashboard/tickets";

export function buildMainDashboardApiUrl(
  basePath: string,
  filters: Partial<MainDashboardFilters>,
) {
  const params = new URLSearchParams();

  for (const { viewKey, payloadKey } of mainDashboardFilterFieldMappings) {
    const values = filters[viewKey];
    if (values?.length) {
      params.set(payloadKey, values.join(","));
    }
  }

  if (filters.creationTimeStart) {
    params.set("creation_time_start", filters.creationTimeStart);
  }
  if (filters.creationTimeEnd) {
    params.set("creation_time_end", filters.creationTimeEnd);
  }

  const queryString = params.toString();
  return queryString ? `${basePath}?${queryString}` : basePath;
}

export async function fetchMainDashboardData(
  filters: Partial<MainDashboardFilters> = {},
): Promise<MainDashboardViewModel> {
  const response = await fetch(
    buildMainDashboardApiUrl(MAIN_DASHBOARD_API_PATH, filters),
  );

  if (!response.ok) {
    throw new Error(
      `Full Picture request failed (${response.status} ${response.statusText})`,
    );
  }

  const payload = (await response.json()) as MainDashboardPayload;
  return adaptMainDashboardPayload(payload);
}


export async function fetchMainDashboardSummary(
  filters: Partial<MainDashboardFilters> = {},
): Promise<MainDashboardSummaryViewModel> {
  const response = await fetch(
    buildMainDashboardApiUrl(MAIN_DASHBOARD_SUMMARY_API_PATH, filters),
  );

  if (!response.ok) {
    throw new Error(
      `Full Picture summary request failed (${response.status} ${response.statusText})`,
    );
  }

  const payload = (await response.json()) as MainDashboardSummaryPayload;
  return adaptMainDashboardSummaryPayload(payload);
}


export async function fetchMainDashboardTickets(
  filters: Partial<MainDashboardFilters>,
  pageRequest: MainDashboardTicketsPageRequest,
): Promise<MainDashboardTicketsPage> {
  const url = new URL(
    buildMainDashboardApiUrl(MAIN_DASHBOARD_TICKETS_API_PATH, filters),
    "http://localhost",
  );
  url.searchParams.set("page", String(pageRequest.page));
  url.searchParams.set("page_size", String(pageRequest.pageSize));
  url.searchParams.set("sort_by", pageRequest.sortBy);
  url.searchParams.set("sort_order", pageRequest.sortOrder);
  if (pageRequest.search) {
    url.searchParams.set("search", pageRequest.search);
  }
  if (pageRequest.snapshotVersion) {
    url.searchParams.set("snapshot_version", pageRequest.snapshotVersion);
  }

  const response = await fetch(`${url.pathname}${url.search}`);

  if (!response.ok) {
    throw new Error(
      `Full Picture tickets request failed (${response.status} ${response.statusText})`,
    );
  }

  const payload = (await response.json()) as MainDashboardTicketsPagePayload;
  return adaptMainDashboardTicketsPagePayload(payload);
}