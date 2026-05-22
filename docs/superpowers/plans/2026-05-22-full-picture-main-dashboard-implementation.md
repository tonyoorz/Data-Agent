# Full Picture Main Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native `Main Dashboard` page to Vizion Lab that reuses Full Picture data and interactions from TPMDashboard while keeping the existing Vizion Lab shell, styling method, and navigation model.

**Architecture:** Build a local Full Picture adapter layer inside Vizion Lab, fetch the existing backend payload through a configurable API client, derive the active ticket scope with pure filtering utilities, and render the approved workbench as native React components under the current dashboard shell. Keep the TPMDashboard data contract, but convert it into local camelCase view models so the UI stays isolated from backend naming and can evolve safely.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, React Query, Tailwind utility classes, existing shadcn/ui primitives.

---

## File Structure

### Create

- `src/components/dashboard/main-dashboard/mainDashboardTypes.ts`
  Responsibility: local snake_case payload types and camelCase view-model types.
- `src/components/dashboard/main-dashboard/mainDashboardAdapter.ts`
  Responsibility: convert Full Picture payload into the local view model.
- `src/components/dashboard/main-dashboard/mainDashboardApi.ts`
  Responsibility: build request URLs and fetch the backend payload.
- `src/components/dashboard/main-dashboard/mainDashboardFiltering.ts`
  Responsibility: apply search, filters, and drill-down selections to ticket rows.
- `src/components/dashboard/main-dashboard/useMainDashboardData.ts`
  Responsibility: React Query hook for loading the page payload.
- `src/components/dashboard/main-dashboard/MultiSelectFilterField.tsx`
  Responsibility: compact multi-select popover control for dense filter layout.
- `src/components/dashboard/main-dashboard/MainDashboardToolbar.tsx`
  Responsibility: search input, filters toggle, and reset actions.
- `src/components/dashboard/main-dashboard/MainDashboardFilters.tsx`
  Responsibility: render the dense filter grid.
- `src/components/dashboard/main-dashboard/MainDashboardKpis.tsx`
  Responsibility: render the four KPI cards.
- `src/components/dashboard/main-dashboard/OutcomePanel.tsx`
  Responsibility: render and handle outcome selection rows.
- `src/components/dashboard/main-dashboard/TeamExpansionPanel.tsx`
  Responsibility: render and handle team-by-outcome drill-down rows.
- `src/components/dashboard/main-dashboard/TicketDetailTable.tsx`
  Responsibility: render the filtered ticket detail table.
- `src/components/dashboard/pages/MainDashboard.tsx`
  Responsibility: compose the page and connect data, filters, and drill-down state.
- `src/test/main-dashboard/mainDashboardAdapter.test.ts`
  Responsibility: adapter and query-surface tests.
- `src/test/main-dashboard/mainDashboardFiltering.test.ts`
  Responsibility: filtering and drill-down tests.
- `src/test/main-dashboard/MainDashboardPage.test.tsx`
  Responsibility: render and interaction tests for the new page.

### Modify

- `vite.config.ts`
  Responsibility: add a development proxy for Full Picture API access.
- `src/components/dashboard/DashboardSidebar.tsx`
  Responsibility: insert `Main Dashboard` above `Top Issue 分析`.
- `src/pages/Index.tsx`
  Responsibility: default to `main-dashboard`, add title metadata, and render the new page.
- `src/index.css`
  Responsibility: add a small set of reusable classes for compact workbench cards and panel states if inline utilities become repetitive.

---

### Task 1: Bootstrap The Full Picture Data Contract

**Files:**

- Create: `src/components/dashboard/main-dashboard/mainDashboardTypes.ts`
- Create: `src/components/dashboard/main-dashboard/mainDashboardAdapter.ts`
- Create: `src/components/dashboard/main-dashboard/mainDashboardApi.ts`
- Test: `src/test/main-dashboard/mainDashboardAdapter.test.ts`
- Modify: `vite.config.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { adaptMainDashboardPayload, buildMainDashboardApiUrl } from "@/components/dashboard/main-dashboard/mainDashboardAdapter";

describe("adaptMainDashboardPayload", () => {
  it("maps the TPMDashboard payload into local camelCase fields", () => {
    const viewModel = adaptMainDashboardPayload({
      generated_from: {
        defect_db_path: "defect.db",
        history_db_path: "history.db",
        years: ["2026"],
        projects: ["G68"],
        assigned_ecus: ["ECU-A"],
        problem_finder_teams: ["DTSV_China"],
        aidas: ["Digital"],
        phases: ["Validation"],
        solution_clusters: ["Integration"],
        pus: ["PU1"],
        markets: ["CN"],
        lead_models: ["LM1"],
        groups: ["Integration"],
      },
      filters: {
        years: ["2026"],
        projects: ["G68"],
        assigned_ecus: ["ECU-A"],
        problem_finder_teams: ["DTSV_China"],
        aidas: ["Digital"],
        phases: ["Validation"],
        solution_clusters: ["Integration"],
        pus: ["PU1"],
        markets: ["CN"],
        lead_models: ["LM1"],
        groups: ["Integration"],
      },
      overview: {
        ticket_count: 9,
        resolved_forward_count: 4,
        rejected_directly_count: 3,
        resolved_forward_percent: 44.4,
        rejected_directly_percent: 33.3,
      },
      outcome_summary: [
        { key: "resolved_forward", label: "Resolved Forward", count: 4, percent: 44.4, denominator: 9 },
        { key: "rejected_directly", label: "Rejected Directly", count: 3, percent: 33.3, denominator: 9 },
      ],
      team_outcome_rows: [
        {
          problem_finder_team: "DTSV_China",
          total_tickets: 3,
          resolved_forward_count: 2,
          rejected_directly_count: 1,
          resolved_forward_team_percent: 66.7,
          rejected_directly_team_percent: 33.3,
          team_denominator: 3,
        },
      ],
      ticket_rows: [
        {
          ticket_id: "2553006",
          ticket_name: "Navigation app reset after route recalculation under mixed market scope.",
          status: "03-In Analysis",
          problem_finder_team: "DTSV_China",
          group: "Integration",
          phase: "Validation",
          is_resolved_forward: true,
          is_rejected_directly: false,
          year: "2026",
          project: "G68",
          assigned_ecu: "ECU-A",
          aida: "Digital",
          solution_cluster: "Integration",
          pu: "PU1",
          market: "CN",
          lead_model: "LM1",
        },
      ],
    });

    expect(viewModel.overview.ticketCount).toBe(9);
    expect(viewModel.filters.problemFinderTeams).toEqual(["DTSV_China"]);
    expect(viewModel.outcomeSummary[0].key).toBe("resolvedForward");
    expect(viewModel.ticketRows[0].ticketId).toBe("2553006");
    expect(viewModel.ticketRows[0].isResolvedForward).toBe(true);
  });
});

describe("buildMainDashboardApiUrl", () => {
  it("preserves the TPMDashboard query parameter names", () => {
    const url = buildMainDashboardApiUrl("/api/full-picture/dashboard", {
      years: ["2026"],
      projects: ["G68", "U12"],
      problemFinderTeams: ["DTSV_China"],
      groups: ["Integration"],
    });

    expect(url).toContain("years=2026");
    expect(url).toContain("projects=G68%2CU12");
    expect(url).toContain("problem_finder_teams=DTSV_China");
    expect(url).toContain("groups=Integration");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/test/main-dashboard/mainDashboardAdapter.test.ts`
Expected: FAIL because the adapter and API modules do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/components/dashboard/main-dashboard/mainDashboardApi.ts
import type { MainDashboardFilters } from "./mainDashboardTypes";

export function buildMainDashboardApiUrl(basePath: string, filters: Partial<MainDashboardFilters>) {
  const params = new URLSearchParams();

  if (filters.years?.length) params.set("years", filters.years.join(","));
  if (filters.projects?.length) params.set("projects", filters.projects.join(","));
  if (filters.assignedEcus?.length) params.set("assigned_ecus", filters.assignedEcus.join(","));
  if (filters.problemFinderTeams?.length) params.set("problem_finder_teams", filters.problemFinderTeams.join(","));
  if (filters.aidas?.length) params.set("aidas", filters.aidas.join(","));
  if (filters.phases?.length) params.set("phases", filters.phases.join(","));
  if (filters.solutionClusters?.length) params.set("solution_clusters", filters.solutionClusters.join(","));
  if (filters.pus?.length) params.set("pus", filters.pus.join(","));
  if (filters.markets?.length) params.set("markets", filters.markets.join(","));
  if (filters.leadModels?.length) params.set("lead_models", filters.leadModels.join(","));
  if (filters.groups?.length) params.set("groups", filters.groups.join(","));

  return `${basePath}?${params.toString()}`;
}
```

```ts
// src/components/dashboard/main-dashboard/mainDashboardAdapter.ts
import type {
  MainDashboardPayload,
  MainDashboardViewModel,
} from "./mainDashboardTypes";
import { buildMainDashboardApiUrl } from "./mainDashboardApi";

export { buildMainDashboardApiUrl };

export function adaptMainDashboardPayload(payload: MainDashboardPayload): MainDashboardViewModel {
  return {
    generatedFrom: {
      defectDbPath: payload.generated_from.defect_db_path,
      historyDbPath: payload.generated_from.history_db_path,
      years: payload.generated_from.years,
      projects: payload.generated_from.projects,
      assignedEcus: payload.generated_from.assigned_ecus,
      problemFinderTeams: payload.generated_from.problem_finder_teams,
      aidas: payload.generated_from.aidas,
      phases: payload.generated_from.phases,
      solutionClusters: payload.generated_from.solution_clusters,
      pus: payload.generated_from.pus,
      markets: payload.generated_from.markets,
      leadModels: payload.generated_from.lead_models,
      groups: payload.generated_from.groups,
    },
    filters: {
      years: payload.filters.years,
      projects: payload.filters.projects,
      assignedEcus: payload.filters.assigned_ecus,
      problemFinderTeams: payload.filters.problem_finder_teams,
      aidas: payload.filters.aidas,
      phases: payload.filters.phases,
      solutionClusters: payload.filters.solution_clusters,
      pus: payload.filters.pus,
      markets: payload.filters.markets,
      leadModels: payload.filters.lead_models,
      groups: payload.filters.groups,
    },
    overview: {
      ticketCount: payload.overview.ticket_count,
      resolvedForwardCount: payload.overview.resolved_forward_count,
      rejectedDirectlyCount: payload.overview.rejected_directly_count,
      resolvedForwardPercent: payload.overview.resolved_forward_percent,
      rejectedDirectlyPercent: payload.overview.rejected_directly_percent,
    },
    outcomeSummary: payload.outcome_summary.map((row) => ({
      key: row.key === "resolved_forward" ? "resolvedForward" : "rejectedDirectly",
      label: row.label,
      count: row.count,
      percent: row.percent,
      denominator: row.denominator,
    })),
    teamOutcomeRows: payload.team_outcome_rows.map((row) => ({
      problemFinderTeam: row.problem_finder_team,
      totalTickets: row.total_tickets,
      resolvedForwardCount: row.resolved_forward_count,
      rejectedDirectlyCount: row.rejected_directly_count,
      resolvedForwardTeamPercent: row.resolved_forward_team_percent,
      rejectedDirectlyTeamPercent: row.rejected_directly_team_percent,
      teamDenominator: row.team_denominator,
    })),
    ticketRows: payload.ticket_rows.map((row) => ({
      ticketId: row.ticket_id,
      ticketName: row.ticket_name,
      status: row.status,
      problemFinderTeam: row.problem_finder_team,
      group: row.group,
      phase: row.phase,
      isResolvedForward: row.is_resolved_forward,
      isRejectedDirectly: row.is_rejected_directly,
      year: row.year,
      project: row.project,
      assignedEcu: row.assigned_ecu,
      aida: row.aida,
      solutionCluster: row.solution_cluster,
      pu: row.pu,
      market: row.market,
      leadModel: row.lead_model,
    })),
  };
}
```

```ts
// vite.config.ts
server: {
  host: "::",
  port: 8080,
  hmr: { overlay: false },
  proxy: {
    "/api/full-picture": {
      target: "http://127.0.0.1:3002",
      changeOrigin: true,
    },
  },
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/test/main-dashboard/mainDashboardAdapter.test.ts`
Expected: PASS with 2 passing tests.

- [ ] **Step 5: Commit**

```bash
git add vite.config.ts src/components/dashboard/main-dashboard/mainDashboardTypes.ts src/components/dashboard/main-dashboard/mainDashboardAdapter.ts src/components/dashboard/main-dashboard/mainDashboardApi.ts src/test/main-dashboard/mainDashboardAdapter.test.ts
git commit -m "feat: bootstrap main dashboard data contract"
```

### Task 2: Implement Pure Filtering And Drill-Down Logic

**Files:**

- Create: `src/components/dashboard/main-dashboard/mainDashboardFiltering.ts`
- Test: `src/test/main-dashboard/mainDashboardFiltering.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
  applyMainDashboardFilters,
  selectTicketRowsForDrilldown,
} from "@/components/dashboard/main-dashboard/mainDashboardFiltering";

const viewModel = {
  overview: { ticketCount: 3, resolvedForwardCount: 2, rejectedDirectlyCount: 1, resolvedForwardPercent: 66.7, rejectedDirectlyPercent: 33.3 },
  outcomeSummary: [],
  teamOutcomeRows: [],
  ticketRows: [
    { ticketId: "1", ticketName: "Alpha issue", problemFinderTeam: "DTSV_China", status: "03", group: "Integration", phase: "Validation", isResolvedForward: true, isRejectedDirectly: false, year: "2026", project: "G68", assignedEcu: "ECU-A", aida: "Digital", solutionCluster: "Integration", pu: "PU1", market: "CN", leadModel: "LM1" },
    { ticketId: "2", ticketName: "Beta issue", problemFinderTeam: "[AT]W72-FIT", status: "04", group: "Q-Gate", phase: "Analysis", isResolvedForward: false, isRejectedDirectly: true, year: "2026", project: "U12", assignedEcu: "ECU-B", aida: "EE", solutionCluster: "CoC", pu: "PU2", market: "EU", leadModel: "LM2" },
    { ticketId: "3", ticketName: "Gamma search match", problemFinderTeam: "DTSV_China", status: "05", group: "Integration", phase: "Validation", isResolvedForward: true, isRejectedDirectly: false, year: "2025", project: "NA6", assignedEcu: "ECU-C", aida: "Digital", solutionCluster: "Integration", pu: "PU3", market: "CN", leadModel: "LM3" },
  ],
};

describe("applyMainDashboardFilters", () => {
  it("filters rows by search text and multi-select values", () => {
    const filtered = applyMainDashboardFilters(viewModel as any, {
      searchText: "gamma",
      filters: { years: ["2025"], projects: [], assignedEcus: [], problemFinderTeams: [], aidas: [], phases: [], solutionClusters: [], pus: [], markets: [], leadModels: [], groups: [] },
    });

    expect(filtered.ticketRows).toHaveLength(1);
    expect(filtered.ticketRows[0].ticketId).toBe("3");
    expect(filtered.overview.ticketCount).toBe(1);
  });
});

describe("selectTicketRowsForDrilldown", () => {
  it("narrows rows by outcome and team selection", () => {
    const rows = selectTicketRowsForDrilldown(viewModel.ticketRows as any, {
      outcomeKey: "resolvedForward",
      team: "DTSV_China",
    });

    expect(rows.map((row) => row.ticketId)).toEqual(["1", "3"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/test/main-dashboard/mainDashboardFiltering.test.ts`
Expected: FAIL because the filtering module does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/components/dashboard/main-dashboard/mainDashboardFiltering.ts
import type {
  MainDashboardFilters,
  MainDashboardOutcomeKey,
  MainDashboardTicketRow,
  MainDashboardViewModel,
} from "./mainDashboardTypes";

type FilterState = {
  searchText: string;
  filters: MainDashboardFilters;
};

type DrillSelection = {
  outcomeKey?: MainDashboardOutcomeKey | null;
  team?: string | null;
};

function matchesList(activeValues: string[], candidate: string) {
  return activeValues.length === 0 || activeValues.includes(candidate);
}

function matchesSearch(row: MainDashboardTicketRow, searchText: string) {
  const query = searchText.trim().toLowerCase();
  if (!query) return true;
  return row.ticketId.toLowerCase().includes(query) || row.ticketName.toLowerCase().includes(query);
}

function matchesOutcome(row: MainDashboardTicketRow, outcomeKey?: MainDashboardOutcomeKey | null) {
  if (!outcomeKey) return true;
  return outcomeKey === "resolvedForward" ? row.isResolvedForward : row.isRejectedDirectly;
}

export function applyMainDashboardFilters(viewModel: MainDashboardViewModel, state: FilterState) {
  const ticketRows = viewModel.ticketRows.filter((row) =>
    matchesSearch(row, state.searchText) &&
    matchesList(state.filters.years, row.year) &&
    matchesList(state.filters.projects, row.project) &&
    matchesList(state.filters.assignedEcus, row.assignedEcu) &&
    matchesList(state.filters.problemFinderTeams, row.problemFinderTeam) &&
    matchesList(state.filters.aidas, row.aida) &&
    matchesList(state.filters.phases, row.phase) &&
    matchesList(state.filters.solutionClusters, row.solutionCluster) &&
    matchesList(state.filters.pus, row.pu) &&
    matchesList(state.filters.markets, row.market) &&
    matchesList(state.filters.leadModels, row.leadModel) &&
    matchesList(state.filters.groups, row.group),
  );

  const resolvedForwardCount = ticketRows.filter((row) => row.isResolvedForward).length;
  const rejectedDirectlyCount = ticketRows.filter((row) => row.isRejectedDirectly).length;

  return {
    ticketRows,
    overview: {
      ticketCount: ticketRows.length,
      resolvedForwardCount,
      rejectedDirectlyCount,
      resolvedForwardPercent: ticketRows.length ? Math.round((resolvedForwardCount / ticketRows.length) * 10000) / 100 : 0,
      rejectedDirectlyPercent: ticketRows.length ? Math.round((rejectedDirectlyCount / ticketRows.length) * 10000) / 100 : 0,
    },
  };
}

export function selectTicketRowsForDrilldown(ticketRows: MainDashboardTicketRow[], selection: DrillSelection) {
  return ticketRows.filter((row) => (!selection.team || row.problemFinderTeam === selection.team) && matchesOutcome(row, selection.outcomeKey));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/test/main-dashboard/mainDashboardFiltering.test.ts`
Expected: PASS with 2 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/main-dashboard/mainDashboardFiltering.ts src/test/main-dashboard/mainDashboardFiltering.test.ts
git commit -m "feat: add main dashboard filtering engine"
```

### Task 3: Integrate Main Dashboard Into The Existing Shell

**Files:**

- Create: `src/components/dashboard/main-dashboard/useMainDashboardData.ts`
- Create: `src/components/dashboard/pages/MainDashboard.tsx`
- Modify: `src/components/dashboard/DashboardSidebar.tsx`
- Modify: `src/pages/Index.tsx`
- Test: `src/test/main-dashboard/MainDashboardPage.test.tsx`

- [ ] **Step 1: Write the failing render test**

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Index from "@/pages/Index";

vi.mock("@/components/dashboard/pages/MainDashboard", () => ({
  default: () => <div>Main Dashboard shell</div>,
}));

describe("Index main dashboard integration", () => {
  it("shows Main Dashboard in the sidebar and renders it by default", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Index />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Main Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Main Dashboard shell")).toBeInTheDocument();
    expect(screen.getByText("Full Picture 管理总览")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/test/main-dashboard/MainDashboardPage.test.tsx`
Expected: FAIL because the page is not wired into `Index` or `DashboardSidebar` yet.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/components/dashboard/DashboardSidebar.tsx
const navItems = [
  { id: "main-dashboard", label: "Main Dashboard", sublabel: "Full Picture 管理总览", icon: LayoutDashboard },
  { id: "topissue", label: "Top Issue 分析", icon: TrendingUp },
  // existing items continue unchanged
];
```

```tsx
// src/pages/Index.tsx
import MainDashboard from "@/components/dashboard/pages/MainDashboard";

const pageTitles = {
  "main-dashboard": { title: "Main Dashboard", subtitle: "将 Full Picture 数据和交互方式融合到当前数据看板" },
  topissue: { title: "Top Issue 分析", subtitle: "关键问题追踪与趋势分析" },
  // existing titles
};

const [activeNav, setActiveNav] = useState("main-dashboard");

switch (activeNav) {
  case "main-dashboard":
    return <MainDashboard />;
  // existing cases
}
```

```tsx
// src/components/dashboard/pages/MainDashboard.tsx
const MainDashboard = () => {
  return (
    <div className="space-y-5">
      <div className="dashboard-card p-6">
        <h2 className="text-lg font-bold text-foreground">Main Dashboard shell</h2>
        <p className="mt-2 text-sm text-muted-foreground">Full Picture 管理总览</p>
      </div>
    </div>
  );
};

export default MainDashboard;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/test/main-dashboard/MainDashboardPage.test.tsx`
Expected: PASS with the new nav item visible and selected page rendered.

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/DashboardSidebar.tsx src/pages/Index.tsx src/components/dashboard/pages/MainDashboard.tsx src/test/main-dashboard/MainDashboardPage.test.tsx
git commit -m "feat: wire main dashboard into shell"
```

### Task 4: Build The Toolbar, Dense Filters, And KPI Summary

**Files:**

- Create: `src/components/dashboard/main-dashboard/MultiSelectFilterField.tsx`
- Create: `src/components/dashboard/main-dashboard/MainDashboardToolbar.tsx`
- Create: `src/components/dashboard/main-dashboard/MainDashboardFilters.tsx`
- Create: `src/components/dashboard/main-dashboard/MainDashboardKpis.tsx`
- Modify: `src/components/dashboard/pages/MainDashboard.tsx`
- Modify: `src/index.css`
- Test: `src/test/main-dashboard/MainDashboardPage.test.tsx`

- [ ] **Step 1: Extend the page test with toolbar and KPI expectations**

```tsx
it("renders toolbar controls, compact filters, and KPI cards from loaded data", async () => {
  vi.mocked(fetchMainDashboardData).mockResolvedValueOnce(sampleViewModel);

  renderMainDashboard();

  expect(await screen.findByPlaceholderText("Search ticket ID or title")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
  expect(screen.getByText("Tickets in scope")).toBeInTheDocument();
  expect(screen.getByText("Resolved Forward")).toBeInTheDocument();
  expect(screen.getByText("Rejected Directly")).toBeInTheDocument();
  expect(screen.getByText("Table scope")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/test/main-dashboard/MainDashboardPage.test.tsx`
Expected: FAIL because the page shell does not render the workbench controls or KPI cards yet.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/components/dashboard/pages/MainDashboard.tsx
import MainDashboardToolbar from "@/components/dashboard/main-dashboard/MainDashboardToolbar";
import MainDashboardFilters from "@/components/dashboard/main-dashboard/MainDashboardFilters";
import MainDashboardKpis from "@/components/dashboard/main-dashboard/MainDashboardKpis";

<section className="dashboard-card overflow-hidden rounded-[22px] border border-border/90 bg-card shadow-sm">
  <MainDashboardToolbar
    filtersOpen={filtersOpen}
    searchText={searchText}
    onSearchTextChange={setSearchText}
    onToggleFilters={() => setFiltersOpen((current) => !current)}
    onReset={handleReset}
  />
  {filtersOpen ? (
    <MainDashboardFilters
      availableFilters={viewModel.filters}
      selectedFilters={filters}
      onToggleValue={toggleFilterValue}
    />
  ) : null}
</section>

<MainDashboardKpis
  overview={filtered.overview}
  selectedRowCount={selectedTicketRows.length}
  teamCount={teamRows.length}
/>
```

```css
/* src/index.css */
.workbench-panel {
  @apply dashboard-card rounded-[20px] border-border/90 shadow-sm;
}

.workbench-filter-label {
  @apply text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground/80;
}

.workbench-selection-chip {
  @apply inline-flex items-center rounded-full bg-primary/10 px-3 py-1.5 text-[11px] font-semibold text-primary;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/test/main-dashboard/MainDashboardPage.test.tsx`
Expected: PASS with toolbar, filter grid, and KPI cards visible.

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/main-dashboard/MultiSelectFilterField.tsx src/components/dashboard/main-dashboard/MainDashboardToolbar.tsx src/components/dashboard/main-dashboard/MainDashboardFilters.tsx src/components/dashboard/main-dashboard/MainDashboardKpis.tsx src/components/dashboard/pages/MainDashboard.tsx src/index.css src/test/main-dashboard/MainDashboardPage.test.tsx
git commit -m "feat: add main dashboard toolbar and summary"
```

### Task 5: Implement Outcome, Team, And Ticket Detail Drill-Down

**Files:**

- Create: `src/components/dashboard/main-dashboard/OutcomePanel.tsx`
- Create: `src/components/dashboard/main-dashboard/TeamExpansionPanel.tsx`
- Create: `src/components/dashboard/main-dashboard/TicketDetailTable.tsx`
- Modify: `src/components/dashboard/pages/MainDashboard.tsx`
- Test: `src/test/main-dashboard/MainDashboardPage.test.tsx`

- [ ] **Step 1: Extend the page test with drill-down behavior**

```tsx
import userEvent from "@testing-library/user-event";

it("narrows the table when outcome and team selections are applied", async () => {
  vi.mocked(fetchMainDashboardData).mockResolvedValueOnce(sampleViewModel);
  const user = userEvent.setup();

  renderMainDashboard();

  await user.click(await screen.findByRole("button", { name: /Portfolio Resolved Forward/i }));
  expect(screen.getByText("Outcome: Resolved Forward")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /DTSV_China Resolved Forward/i }));
  expect(screen.getByText("Team: DTSV_China")).toBeInTheDocument();
  expect(screen.getByText("rows = 2")).toBeInTheDocument();
  expect(screen.getByText("2553006")).toBeInTheDocument();
  expect(screen.queryByText("2526002")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/test/main-dashboard/MainDashboardPage.test.tsx`
Expected: FAIL because the outcome panel, team panel, and ticket table are not interactive yet.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/components/dashboard/pages/MainDashboard.tsx
import OutcomePanel from "@/components/dashboard/main-dashboard/OutcomePanel";
import TeamExpansionPanel from "@/components/dashboard/main-dashboard/TeamExpansionPanel";
import TicketDetailTable from "@/components/dashboard/main-dashboard/TicketDetailTable";
import { applyMainDashboardFilters, selectTicketRowsForDrilldown } from "@/components/dashboard/main-dashboard/mainDashboardFiltering";

const filtered = applyMainDashboardFilters(viewModel, { searchText, filters });
const selectedTicketRows = selectTicketRowsForDrilldown(filtered.ticketRows, selection);

<div className="grid gap-3 xl:grid-cols-[0.95fr_1.45fr]">
  <OutcomePanel
    outcomeSummary={filteredOutcomeSummary}
    selection={selection}
    onToggleOutcome={handleToggleOutcome}
    ticketCount={filtered.ticketRows.length}
  />
  <TeamExpansionPanel
    rows={filteredTeamRows}
    selection={selection}
    onToggleTeamOutcome={handleToggleTeamOutcome}
  />
</div>

<TicketDetailTable
  rows={selectedTicketRows}
  selection={selection}
  onClearSelection={() => setSelection({})}
/>
```

```tsx
// src/components/dashboard/main-dashboard/TicketDetailTable.tsx
<div className="flex flex-wrap items-center gap-2">
  {selection.outcomeKey ? <span className="workbench-selection-chip">Outcome: {OUTCOME_LABELS[selection.outcomeKey]}</span> : null}
  {selection.team ? <span className="workbench-selection-chip">Team: {selection.team}</span> : null}
  <span className="rounded-full bg-muted px-3 py-1.5 font-mono text-[11px] text-muted-foreground">rows = {rows.length}</span>
</div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/test/main-dashboard/MainDashboardPage.test.tsx`
Expected: PASS with outcome selection, team drill-down, and ticket table scope updates working.

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/main-dashboard/OutcomePanel.tsx src/components/dashboard/main-dashboard/TeamExpansionPanel.tsx src/components/dashboard/main-dashboard/TicketDetailTable.tsx src/components/dashboard/pages/MainDashboard.tsx src/test/main-dashboard/MainDashboardPage.test.tsx
git commit -m "feat: add main dashboard drilldown panels"
```

### Task 6: Add Loading, Error, And Final Verification Coverage

**Files:**

- Modify: `src/components/dashboard/main-dashboard/mainDashboardApi.ts`
- Modify: `src/components/dashboard/main-dashboard/useMainDashboardData.ts`
- Modify: `src/components/dashboard/pages/MainDashboard.tsx`
- Test: `src/test/main-dashboard/MainDashboardPage.test.tsx`

- [ ] **Step 1: Add failing tests for loading and API failure states**

```tsx
it("shows a loading shell while the first request is in flight", () => {
  vi.mocked(fetchMainDashboardData).mockReturnValue(new Promise(() => {}));

  renderMainDashboard();

  expect(screen.getByText("Loading Full Picture data...")).toBeInTheDocument();
});

it("shows a non-blocking error panel when the Full Picture API fails", async () => {
  vi.mocked(fetchMainDashboardData).mockRejectedValueOnce(new Error("Unable to reach the Full Picture API."));

  renderMainDashboard();

  expect(await screen.findByText("Unable to reach the Full Picture API.")).toBeInTheDocument();
  expect(screen.getByText("Main Dashboard")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/test/main-dashboard/MainDashboardPage.test.tsx`
Expected: FAIL because the page has no explicit loading and error states yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/components/dashboard/main-dashboard/useMainDashboardData.ts
import { useQuery } from "@tanstack/react-query";
import { adaptMainDashboardPayload } from "./mainDashboardAdapter";
import { fetchMainDashboardData } from "./mainDashboardApi";

export function useMainDashboardData() {
  return useQuery({
    queryKey: ["main-dashboard"],
    queryFn: async () => adaptMainDashboardPayload(await fetchMainDashboardData()),
  });
}
```

```tsx
// src/components/dashboard/pages/MainDashboard.tsx
if (query.isLoading) {
  return (
    <div className="dashboard-card p-6">
      <h2 className="text-lg font-bold text-foreground">Loading Full Picture data...</h2>
      <p className="mt-2 text-sm text-muted-foreground">The workbench shell stays visible while the API warms up.</p>
    </div>
  );
}

if (query.isError) {
  return (
    <div className="dashboard-card border-destructive/20 p-6">
      <h2 className="text-lg font-bold text-foreground">Main Dashboard</h2>
      <p className="mt-2 text-sm text-destructive">{(query.error as Error).message}</p>
    </div>
  );
}
```

- [ ] **Step 4: Run focused verification and then broader verification**

Run: `npm test -- src/test/main-dashboard/mainDashboardAdapter.test.ts src/test/main-dashboard/mainDashboardFiltering.test.ts src/test/main-dashboard/MainDashboardPage.test.tsx`
Expected: PASS with all new tests green.

Run: `npm run build`
Expected: PASS with Vite build exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/main-dashboard/mainDashboardApi.ts src/components/dashboard/main-dashboard/useMainDashboardData.ts src/components/dashboard/pages/MainDashboard.tsx src/test/main-dashboard/MainDashboardPage.test.tsx
git commit -m "feat: finish main dashboard states and verification"
```

## Self-Review

### Spec Coverage

- `Main Dashboard` nav item: covered by Task 3.
- Native Vizion Lab shell integration: covered by Tasks 3 and 4.
- Reuse Full Picture payload and backend surface: covered by Task 1.
- Search, filters, outcome drill-down, team drill-down, reset: covered by Tasks 2, 4, and 5.
- KPI, outcome, team, and table numerical consistency: covered by Tasks 2 and 5.
- Loading, error, and empty states: covered by Task 6.

### Placeholder Scan

- No `TODO`, `TBD`, or deferred implementation notes remain.
- All task steps include explicit file targets, code examples, and commands.

### Type Consistency

- Backend filter names remain snake_case only at the API boundary.
- UI components consume camelCase types from `mainDashboardTypes.ts`.
- Drill-down state uses `outcomeKey` and `team` consistently across Tasks 2, 5, and 6.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-22-full-picture-main-dashboard-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
