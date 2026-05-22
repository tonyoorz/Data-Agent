import { adaptMainDashboardPayload } from "./mainDashboardAdapter";
import {
  type MainDashboardFilters,
  type MainDashboardPayload,
  type MainDashboardViewModel,
  mainDashboardFilterFieldMappings,
} from "./mainDashboardTypes";

const MAIN_DASHBOARD_API_PATH = "/api/full-picture/dashboard";

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