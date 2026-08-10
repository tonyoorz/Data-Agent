export type CoverageAnalysisFilters = {
  years: string[];
  projects: string[];
  testWeeks: string[];
  pus: string[];
  aidas: string[];
  statuses: string[];
  featureRegions: string[];
  fvps: string[];
  fvs: string[];
};

export type CoverageAnalysisFilterOptions = CoverageAnalysisFilters;

export type CoverageAnalysisFilterKey = keyof CoverageAnalysisFilters;

export const coverageAnalysisFilterFieldMappings: Array<{
  frontendKey: CoverageAnalysisFilterKey;
  backendKey: string;
}> = [
  { frontendKey: "years", backendKey: "years" },
  { frontendKey: "projects", backendKey: "projects" },
  { frontendKey: "testWeeks", backendKey: "test_weeks" },
  { frontendKey: "pus", backendKey: "pus" },
  { frontendKey: "aidas", backendKey: "aidas" },
  { frontendKey: "statuses", backendKey: "statuses" },
  { frontendKey: "featureRegions", backendKey: "feature_regions" },
  { frontendKey: "fvps", backendKey: "fvps" },
  { frontendKey: "fvs", backendKey: "fvs" },
];

export type CoverageAnalysisProjectStatusRow = {
  test_week: string;
  fv: string;
  fvp: string;
  status: string;
  count: number;
};

export type CoverageAnalysisAidaStatusRow = {
  test_week: string;
  top_aida: string;
  status: string;
  count: number;
};

export type CoverageAnalysisTestcaseDetailRow = {
  test_id: string;
  test_name: string;
  test_week: string;
  status: string;
  top_aida: string;
  project: string;
  pu: string;
  fvp: string;
  fv: string;
  tester: string;
  count: number;
};

export type CoverageAnalysisPageData = {
  filterOptions: CoverageAnalysisFilterOptions;
  projectStatusRows: CoverageAnalysisProjectStatusRow[];
  aidaStatusRows: CoverageAnalysisAidaStatusRow[];
  testcaseDetailRows: CoverageAnalysisTestcaseDetailRow[];
};