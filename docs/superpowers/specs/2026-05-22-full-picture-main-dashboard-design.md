# Full Picture Main Dashboard Integration Design

## Goal

Integrate the TPMDashboard Full Picture workbench into the current Vizion Lab dashboard as a first-class page named `Main Dashboard`, placed above `Top Issue 分析` in the existing left navigation.

The result must follow the current Vizion Lab frontend design method and component structure, while reusing the existing Full Picture data model, API behavior, and filtering semantics from TPMDashboard.

## Design Decisions

1. Do not embed `http://127.0.0.1:3002/full-picture` as an iframe or foreign page.
2. Do not copy the interactive mock HTML into the app as-is.
3. Rebuild the screen as native React components inside Vizion Lab.
4. Use the interactive mock HTML as the visual contract for layout density, section order, and interaction rhythm.
5. Reuse TPMDashboard Full Picture data semantics and request surface.

## Source Anchors

### Current Vizion Lab integration anchors

- `src/components/dashboard/DashboardSidebar.tsx`
- `src/pages/Index.tsx`
- `src/index.css`
- `src/components/dashboard/pages/*.tsx`

### TPMDashboard data and interaction anchors

- `C:/Users/q446328/Desktop/TPMDashbaord/full_picture_api_service.py`
- `C:/Users/q446328/Desktop/TPMDashbaord/apps/qgate-kpi/src/lib/full-picture-types.ts`
- `C:/Users/q446328/Desktop/TPMDashbaord/apps/qgate-kpi/src/features/full-picture-dashboard/full-picture-filtering.ts`
- `C:/Users/q446328/Desktop/TPMDashbaord/apps/qgate-kpi/src/features/full-picture-dashboard/full-picture-page.tsx`
- `C:/Users/q446328/Desktop/TPMDashbaord/docs/full-picture-workbench-v2-interactive-mock.html`

## User-Facing Outcome

### Navigation

- Add `Main Dashboard` as the first item in the left sidebar.
- Keep the rest of the navigation unchanged.
- Make `Main Dashboard` the default landing page for the dashboard shell.

### Main Dashboard content structure

The new page should render in this order inside the existing main content area:

1. Sticky page header using Vizion Lab shell styling
2. Workbench toolbar with search, filter toggle, and reset
3. Dense filter grid styled to match the mock layout but using current app tokens
4. Four KPI cards
5. Two-column analysis section
6. Ticket detail table

### KPI set

The top summary cards should show:

1. `Tickets in scope`
2. `Resolved Forward`
3. `Rejected Directly`
4. `Teams in scope` or `Table scope`

The first three values come directly from filtered Full Picture scope. The fourth card is a page-level usefulness metric and may switch to `Table scope` once drill-down is active.

## Data Integration Design

### Canonical payload

Reuse the payload family already exposed by TPMDashboard Full Picture:

- `filters`
- `overview`
- `outcome_summary`
- `team_outcome_rows`
- `ticket_rows`

The source service is `get_full_picture_dashboard_payload()` in `full_picture_api_service.py`.

### Request surface to preserve

The Vizion Lab frontend should preserve the same backend filter vocabulary used by TPMDashboard:

- `years`
- `projects`
- `assigned_ecus`
- `problem_finder_teams`
- `aidas`
- `phases`
- `solution_clusters`
- `pus`
- `markets`
- `lead_models`
- `groups`

### Frontend adapter model

Vizion Lab should normalize the backend payload into camelCase view data similar to TPMDashboard types:

- `generatedFrom`
- `filters`
- `overview`
- `outcomeSummary`
- `teamOutcomeRows`
- `ticketRows`

This adapter belongs in a dedicated local module so UI components never depend on raw snake_case fields.

### Recommended API access pattern

For local development and staged integration, prefer this sequence:

1. Add a small Vizion Lab API client module dedicated to Full Picture.
2. Point it at `http://127.0.0.1:3002/api/full-picture/dashboard` through a configurable base URL.
3. Use Vite proxy during local development when needed to avoid CORS issues.
4. Keep a single fetch function that accepts the current filter state and returns the normalized payload.

### Filtering semantics to preserve

Filtering behavior must stay aligned with TPMDashboard logic:

- All list filters are multi-select.
- Empty selection means `All`.
- Search narrows by ticket ID or title.
- Page totals derive from the currently filtered ticket scope.
- `Portfolio Outcome` selection narrows the table by outcome.
- `Team Expansion` selection narrows the table by team plus outcome.
- `Reset` clears search, filters, and chart selections.

## Frontend Architecture

### New page-level modules

Recommended component split:

- `MainDashboard.tsx`
- `main-dashboard/useMainDashboardData.ts`
- `main-dashboard/mainDashboardAdapter.ts`
- `main-dashboard/mainDashboardTypes.ts`
- `main-dashboard/mainDashboardFiltering.ts`
- `main-dashboard/MainDashboardToolbar.tsx`
- `main-dashboard/MainDashboardFilters.tsx`
- `main-dashboard/MainDashboardKpis.tsx`
- `main-dashboard/OutcomePanel.tsx`
- `main-dashboard/TeamExpansionPanel.tsx`
- `main-dashboard/TicketDetailTable.tsx`

### Shell integration

Use current Vizion Lab shell patterns instead of Full Picture page chrome:

- Keep `DashboardSidebar`
- Keep the current sticky header region
- Keep `AIAssistant`
- Keep `dashboard-card` visual language
- Use current color tokens from `src/index.css`

### Styling direction

The page should match the mock HTML in:

- section order
- compact filter density
- active blue selection states
- rounded white panels on soft gray background
- outcome bars and team comparison rows

The page should match Vizion Lab in:

- shell layout
- typography tokens
- border radius scale
- sidebar style
- card treatment
- spacing rhythm with existing dashboard pages

## Page Behavior

### Workbench toolbar

- Search input filters `ticketRows` by `ticketId` and `ticketName`
- `Filters` toggles visibility of the filter grid
- `Reset` restores default year scope and clears UI state

### Filter panel

- Render filter controls in the same logical order as the interactive mock
- Prefer compact button/select surfaces instead of oversized cards
- Show current selection summary inline when helpful

### Outcome panel

- Render two outcome rows: `Resolved Forward` and `Rejected Directly`
- Display count, percent, denominator, and horizontal bar fill
- Clicking a row toggles outcome selection

### Team panel

- Render one row per `problemFinderTeam`
- Preserve team-local denominators
- Display both outcome bars per team
- Clicking a team outcome sets `{ outcomeKey, team }`

### Ticket detail table

- Always derives from the currently selected scope
- Base scope = search + filters
- Drill scope = base scope + chart selection
- Show empty state when no rows match

## Error Handling

### Loading state

- Show lightweight skeleton or shell placeholders inside dashboard cards
- Keep the page frame stable while data loads

### API unavailable

- Show a concise page-level warning inside the content area
- Do not break the rest of the Vizion Lab dashboard
- Keep navigation usable

### Empty filtered scope

- KPI values go to zero
- Outcome and team panels show empty-state copy
- Table shows a no-results message

## Test Plan

### Unit tests

Add focused tests for:

1. payload adaptation from snake_case to camelCase
2. filter application logic
3. search plus filter composition
4. outcome selection narrowing logic
5. team plus outcome drill-down narrowing logic
6. reset behavior

### UI tests

Add at least one render test proving:

1. `Main Dashboard` appears in navigation
2. the page renders KPI cards, outcome panel, team panel, and table
3. clicking outcome and team updates the detail table scope

## Acceptance Criteria

1. `Main Dashboard` is visible above `Top Issue 分析` in the left nav.
2. `Main Dashboard` is rendered inside the current Vizion Lab shell, not as an embedded foreign page.
3. The screen visually follows the supplied interactive mock while still feeling native to Vizion Lab.
4. Data comes from the Full Picture backend surface, not static mock rows.
5. Search, filters, outcome selection, team selection, and reset all work together.
6. KPI totals, outcome totals, team percentages, and table rows stay numerically consistent with the active scope.
7. Empty and error states are handled without breaking the dashboard shell.

## Out Of Scope For This Slice

1. Rebuilding the entire TPMDashboard routing system inside Vizion Lab.
2. Replacing existing Vizion Lab pages other than adding the new `Main Dashboard` entry.
3. Porting unrelated TPMDashboard styling wholesale.
4. Embedding the legacy `3002` page itself.

## Implementation Note

The interactive mock in this repo is a communication artifact only. It is meant to validate layout and intent before implementation. Production code should be React components integrated into the Vizion Lab dashboard architecture.