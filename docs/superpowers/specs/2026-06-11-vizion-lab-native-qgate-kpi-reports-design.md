# Vizion Lab Native QGate KPI Reports Design

## Goal

Generate two repository-native static HTML reports from Vizion Lab's own SQLite source data so the workspace no longer depends on TPMDashboard scripts, templates, or Python modules.

The two reports are:

- `QGate KPI Dashboard`
- `2024 vs 2025 KPI Analysis`

## Current Behavior

- Vizion Lab currently contains a migrated `qgate-kpi-report-generator` skill.
- The current execution path still bridges into the sibling TPMDashboard repository.
- The bridge can already trigger report generation from Vizion Lab, but the actual report logic, HTML structure, and metric derivation still live outside this repository.
- Vizion Lab already has its own staged source database at `database/source/qgate_raw.db` and local analytics enrichment logic under `backend/analytics/`.

## Desired Behavior

### Independent generation

Vizion Lab should generate both reports directly from its own SQLite source database without calling TPMDashboard code.

### Static HTML outputs

Each run should write two standalone HTML files under a timestamped output directory:

- `docs/qgate-reports/generated_runs/<timestamp>/qgate_kpi_dashboard_<timestamp>.html`
- `docs/qgate-reports/generated_runs/<timestamp>/qgate_kpi_compare_2024_2025_<timestamp>.html`

The HTML files must open directly from disk without a running server.

### Native execution entrypoint

Vizion Lab should expose one native command:

```powershell
python -m backend.analytics_cli generate-qgate-kpi-reports
```

Supported options should remain minimal:

- `--db-path` to override the default source database
- `--output-root` to override the default output directory
- `--years` to control the compare-report year window

The command should generate both reports in one run by default.

## Data Inputs

### Primary database

The default data source is Vizion Lab's staged SQLite source database:

- `database/source/qgate_raw.db`

The command may accept an explicit alternative path through `--db-path`, but it still reads only Vizion Lab-compatible SQLite schema.

### Required tables

The report generator requires these source tables:

- `octane_defects`
- `octane_defect_history_events`
- `octane_manual_runs`

If any required table is missing, generation must fail with an actionable error message.

### Available raw payload fields

The current staged database already preserves the original raw payloads needed for metric parity.

Observed `octane_manual_runs.raw_json` fields include:

- `status`
- `exec_model_series_udf`
- `target_ecu_conf_udf`
- `defect`
- `run_team_000_udf`
- `finished_udf`
- `execution_sw_version_udf`

Observed `octane_defects.raw_json` fields include:

- `phase`
- `reporting_class_udf`
- `blocking_reason_udf`
- `problem_severity_udf`
- `assigned_ecu_udf`
- `lead_model_udf`
- `problem_finder_team_udf`
- `solution_cluster_udf`

This makes it feasible to preserve the original report metrics while still using Vizion Lab as the sole runtime.

## Report 1: QGate KPI Dashboard

This report should stay close to the current TPMDashboard metric structure, but use Vizion Lab SQLite inputs only.

### Overview cards

Preserve these top-level metrics:

- Team count
- Scoped defects
- History OK
- History Missing or Error
- History success rate
- Tickets in view
- Transition samples
- Changed-by count

### Section A: Team Coverage

Show per-team coverage bars and totals:

- scoped defects
- tickets currently represented in the filtered issue set
- tickets out of view
- view rate

### Section B: Transition Analysis

Keep grouped transition analysis by phase-group family:

- `Q-Gate`
- `Integration`
- `CoC`
- `Other`

For each transition, preserve:

- transition name
- group
- sample count
- average days

### Section C: Phase Efficiency Summary

Preserve these slices:

- Team × Group efficiency bars
- summary table with ticket count and summed phase-average days
- ticket drilldown table

### Filters

Preserve the current dashboard filter shape:

- years
- teams
- groups
- changed by
- FiF
- ticket timespan min/max
- minimum transition count

### Derivation rules

The native implementation should preserve the current group classification logic:

- `02` / `07` -> `Q-Gate`
- `00` / `01` / `06` / `08` / `09` -> `Integration`
- `03` / `04` / `05` -> `CoC`
- everything else -> `Other`

Transition durations should be derived from `octane_defect_history_events` and not from external history JSON files.

## Report 2: 2024 vs 2025 KPI Analysis

This report should preserve the original compare-report metric families while sourcing all data from Vizion Lab SQLite.

### Section A1: Core KPI Overview

Compare yearly execution totals and rates using `octane_manual_runs`:

- total executions
- Passed
- Passed rate
- Failed
- Failed rate
- Requires Attention
- Requires Attention rate

### Section A2: Project Coverage

Preserve project-distribution style analysis using manual-run payloads.

The implementation should prefer raw payload extraction from `target_ecu_conf_udf` when available, and only fall back to already-normalized `project` fields when the raw structure is absent.

### Section A3: Model Coverage

Preserve the 2024 vs 2025 model comparison using `exec_model_series_udf` from manual-run raw payloads.

### Section A4: Test Execution and Defect Linkage

Preserve:

- executions linked to defects
- linked-execution rate
- linked executions that are Failed
- linked executions that are Passed

This should be derived from `octane_manual_runs.raw_json.defect` when present, or equivalent normalized linkage when raw fields are missing.

### Section B1: Core Defect KPI Overview

Preserve yearly defect analysis using `octane_defects`:

- total defects
- BI-4 and below
- Showstopper Confirmed
- Preventing Maturity
- Showstopper Candidate
- 06-Concluded

### Section B2-B5

Preserve the same major defect-analysis slices:

- CWA Blocking Reason distribution
- CWA three-color cluster
- Ticket Matrix distribution
- Top 15 submitters

### Section C1-C2

Preserve the 2025 cross-team views:

- Showstopper Confirmed team comparison
- Phase 09 (CWA) team comparison

## Implementation Design

### Files

- `backend/analytics/qgate_kpi_dashboard_report.py`
  Native SQLite queries, aggregations, and HTML rendering for the dashboard report.
- `backend/analytics/qgate_kpi_compare_report.py`
  Native SQLite queries, aggregations, and HTML rendering for the compare report.
- `backend/analytics/qgate_kpi_report_common.py`
  Shared helpers for SQLite reads, HTML escaping, time formatting, and timestamped output layout.
- `backend/analytics_cli.py`
  Add the `generate-qgate-kpi-reports` command.
- `backend/tests/test_qgate_kpi_dashboard_report.py`
  Focused dashboard aggregation and HTML tests.
- `backend/tests/test_qgate_kpi_compare_report.py`
  Focused compare-report aggregation and HTML tests.
- `.github/skills/qgate-kpi-report-generator/SKILL.md`
  Update the skill so it points to Vizion Lab native generation rather than TPMDashboard bridging.

### HTML generation style

Follow the existing static-report pattern already used in this repository:

- standalone HTML
- embedded CSS
- optional embedded JSON payload for client-side filtering where useful
- no framework runtime requirement

`scripts/copilotUsageReport.mjs` is the local style reference for a repository-native static report generator.

## Validation Requirements

Every successful run must validate:

1. the output directory exists and matches the run timestamp
2. both HTML files exist
3. the dashboard HTML contains `QGate KPI Dashboard`
4. the compare HTML contains `2024 vs 2025 KPI Analysis`
5. the dashboard HTML contains the expected major section headings
6. the compare HTML contains the expected A/B/C section headings

## Testing Strategy

### Unit-level report tests

Create focused tests with small temporary SQLite fixtures to prove:

- dashboard overview metrics are computed correctly from defects and history events
- transition grouping and duration derivation match the expected phase-group rules
- compare-report execution totals and yearly rates match the manual-run source rows
- defect severity and CWA slices are correctly parsed from `octane_defects.raw_json`
- HTML rendering includes the required titles and section markers

### CLI-level tests

Add a narrow CLI smoke test that:

- creates a temporary SQLite source database
- runs `generate-qgate-kpi-reports`
- confirms both HTML files are generated under the requested output root

## Failure Strategy

- Missing required tables should raise a hard error.
- Missing yearly compare data should raise a hard error rather than silently generating a partial compare report.
- Empty transition data for the dashboard should raise a hard error.
- The generator should not silently fall back to TPMDashboard scripts, sibling repositories, or local JSON files.

## Out of Scope

- Reusing TPMDashboard HTML templates or Python modules
- Keeping the existing bridge as the primary generation path
- Serving the reports from a running API instead of writing static HTML
- Replacing the current Main Dashboard or testing coverage pages
