# Full Picture Top Topic Ticket Detail Design

## Goal

Make the Ticket Detail section on the Full Picture dashboard always surface management-priority Top Topic tickets at the top of the first page, even when they fall outside the current Creation Time window or Problem Finder Team filter, while still respecting the rest of the active dashboard scope.

## Current Behavior

- The dashboard summary and ticket table both derive from the same filter state.
- The tickets endpoint applies all dashboard filters, including `creation_time_start`, `creation_time_end`, and `problem_finder_teams`.
- The page then applies frontend drilldown narrowing on top of the backend ticket result.
- Because the backend already excludes out-of-range rows, Ticket Detail cannot currently surface Top Topic tickets that management still expects to see.

## Desired Behavior

### Ticket Detail override scope

The Ticket Detail section should receive two logical row groups from the tickets API:

- `rows`: the existing paginated ticket result with current behavior unchanged
- `priority_rows`: a small pinned row set for management-priority tickets

`priority_rows` must follow these rules:

- Only include tickets whose `requirement` value contains `Top Topic`
- Ignore `creation_time_start` and `creation_time_end`
- Ignore `problem_finder_teams`
- Continue to respect all other active dashboard filters, including `requirements`, `projects`, `phases`, `china_scopes`, and the remaining filter set
- Continue to respect table-level `search`, `sort_by`, and `sort_order`
- Only appear on page `1`
- Be deduplicated against normal `rows` by `ticket_id`

This preserves the user-selected business scope while exempting the two filters that are currently hiding management-priority tickets.

### UI behavior

- Ticket Detail renders `priority_rows` first, followed by normal drilldown rows
- The pinned rows are still part of the table dataset for table search and sort, but they keep their top placement on page 1
- If no Top Topic rows match the relaxed scope, the table behaves exactly as it does today
- Existing drilldown badges and clear-selection behavior remain unchanged
- Frontend drilldown interactions such as outcome and team narrowing still apply after the backend returns `priority_rows`; the override only bypasses the Creation Time and Problem Finder Team dashboard filters

## Backend Design

### API payload

Extend the Full Picture tickets response payload with:

- `priority_rows: MainDashboardTicketRowPayload[]`

The existing fields stay unchanged so current consumers remain compatible after the frontend adapts.

### Query model

Reuse the existing `FullPictureDashboardQuery` and materialized ticket snapshot path.

For `priority_rows`, derive a relaxed query from the active query by clearing only:

- `creation_time_start`
- `creation_time_end`
- `problem_finder_teams`

Then add an extra Top Topic predicate over requirement data.

For the materialized snapshot path, this predicate should use the already-materialized `requirement` and `requirements_json` columns so the result comes from the same `snapshot_version` as the main table rows.

### Result assembly

The tickets endpoint should:

1. Load normal paginated `rows` exactly as today
2. If `page != 1`, return `priority_rows = []`
3. If `page == 1`, execute the relaxed Top Topic query using the same `snapshot_version`, `search`, and `sort`
4. Remove any ticket already present in normal `rows`
5. Return the remaining rows as `priority_rows`

This keeps the normal pagination contract stable and avoids inflating `total_rows` with a second logical data source.

## Frontend Design

### Data types and adapter

- Extend the tickets payload and view-model types to carry `priorityRows`
- Adapt the API response so the page receives both `rows` and `priorityRows`

### Page composition

`MainDashboard.tsx` should keep its existing drilldown flow for both normal `rows` and `priorityRows`, then prepend the drilldown-filtered `priorityRows` before passing data to `TicketDetailTable`.

Frontend drilldown should still narrow pinned rows, because the override is only intended to bypass the two dashboard filters above rather than all interactive narrowing.

The page should still deduplicate by `ticketId` before rendering.

### Table presentation

Keep `TicketDetailTable` mostly unchanged.

Add a lightweight indicator when pinned rows are present, for example:

- a small subtitle note that X Top Topic tickets are pinned above current Creation Time / Problem Finder Team scope

No separate second table is needed.

## Edge Cases

- If the active `requirements` filter excludes Top Topic values, `priority_rows` should be empty because requirement filtering still applies
- If search text removes all Top Topic rows, `priority_rows` should be empty
- If sort order changes, `priority_rows` should follow that sort before being pinned as a group above normal rows
- If a Top Topic ticket also appears in normal `rows`, show it once
- If the user navigates to page 2+, pinned rows disappear and only normal paginated rows remain

## Testing Strategy

### Backend

Add API coverage showing that:

- a Top Topic ticket outside the selected Creation Time range is returned in `priority_rows`
- a Top Topic ticket excluded only by Problem Finder Team is returned in `priority_rows`
- a ticket excluded by another filter such as `project` or `phase` does not return in `priority_rows`
- `priority_rows` are empty on page 2
- duplicate ticket IDs are not returned in both `rows` and `priority_rows`

### Frontend

Add page-level tests showing that:

- pinned Top Topic rows render ahead of normal filtered rows on page 1
- pinned rows still disappear when the remaining active filters exclude them
- pinned rows are not shown on page 2
- existing drilldown interactions still narrow both normal rows and pinned rows without breaking the pinned management rows contract

## Out of Scope

- Changing KPI cards, outcome panels, or summary counts
- Changing summary filter option generation
- Introducing a new persisted Top Topic flag field
- Making pinned rows ignore all dashboard filters