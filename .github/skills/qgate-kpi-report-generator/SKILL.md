---
name: qgate-kpi-report-generator
description: Use when regenerating native QGate KPI reports from Vizion Lab using the repository's own SQLite source database and static HTML generators.
---

# QGate KPI Report Generator

Use this skill whenever the user asks to regenerate the Vizion Lab native QGate KPI reports from the current workspace.

## What this skill does

This workspace now generates the reports natively.

It reads Vizion Lab's own SQLite source database and writes two standalone static HTML files:

- `QGate KPI Dashboard`
- `2024 vs 2025 KPI Analysis`

## Standard command

Run from the Vizion Lab repository root:

```powershell
python -m backend.analytics_cli generate-qgate-kpi-reports
```

Use a custom source database:

```powershell
python -m backend.analytics_cli generate-qgate-kpi-reports --db-path C:\path\to\qgate_raw.db
```

Use a custom output root:

```powershell
python -m backend.analytics_cli generate-qgate-kpi-reports --output-root docs\qgate-reports\custom_runs
```

Override the compare-report year window:

```powershell
python -m backend.analytics_cli generate-qgate-kpi-reports --years 2024,2025
```

## Default output location

If `--output-root` is not provided, Vizion Lab writes the timestamped run folder under:

- `docs/qgate-reports/generated_runs/YYYYMMDD_HHMMSS/`

## Data prerequisites

The native generator requires a Vizion Lab-compatible SQLite source database with these tables:

- `octane_defects`
- `octane_defect_history_events`
- `octane_manual_runs`

Default source path:

- `database/source/qgate_raw.db`

## Validation after generation

1. Confirm the latest timestamp directory exists under `docs/qgate-reports/generated_runs/` unless a custom output root was used.
2. Confirm both HTML files exist:
	- `qgate_kpi_dashboard_<timestamp>.html`
	- `qgate_kpi_compare_2024_2025_<timestamp>.html`
3. Open the generated HTML files and verify title blocks and tables render normally.
4. If generation fails, inspect whether the source DB is missing required tables or requested compare years.

## Implementation notes

- The native CLI entrypoint is `python -m backend.analytics_cli generate-qgate-kpi-reports`.
- The native modules live under `backend/analytics/`.
- The reports no longer depend on TPMDashboard scripts, templates, or Python modules.