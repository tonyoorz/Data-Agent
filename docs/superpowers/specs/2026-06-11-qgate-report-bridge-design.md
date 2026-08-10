# QGate Report Bridge Design

## Goal

Let this Vizion Lab workspace host a reusable `qgate` skill and a local command that can generate the existing TPMDashboard KPI reports without forcing the user to switch repositories.

## Current Behavior

- Vizion Lab has no workspace-local `.github/skills` directory.
- The existing `qgate-kpi-report-generator` skill lives in the sibling TPMDashboard repository.
- The actual report generation logic also lives in TPMDashboard under `report/generate_dual_kpi_reports.py` and related Python modules.
- Vizion Lab already consumes the same family of staged QGate data, but it does not yet expose a report-generation entrypoint for the TPMDashboard KPI artifacts.

## Desired Behavior

### Workspace-local entrypoint

Add a Vizion Lab command that can be run from this repository root:

- `npm run report:qgate-kpi`

The command should invoke the existing TPMDashboard generator from Vizion Lab.

### Workspace-local skill

Add `.github/skills/qgate-kpi-report-generator/SKILL.md` so the workflow can be invoked from this repository.

The skill should describe:

- what reports get generated
- which command to run from Vizion Lab
- which environment overrides are available when the sibling repo or Python path differs
- what validation to perform after generation

### Bridge behavior

The Vizion Lab bridge should:

1. locate the source TPMDashboard repository from a small set of known sibling candidates, with an environment-variable override
2. locate a usable Python executable, preferring explicit override first, then sibling repo `.venv`, then local repo `.venv`, then `python`
3. set `PYTHONPATH` to the source repository root so TPMDashboard child imports resolve reliably
4. default the output root into Vizion Lab so generated artifacts are visible from this workspace
5. pass through extra CLI arguments to the underlying TPMDashboard generator

## Implementation Design

### Files

- `scripts/qgateKpiReportBridge.mjs`: path resolution and child-process command construction helpers
- `scripts/generateQgateKpiReportsBridge.mjs`: CLI wrapper that runs the bridge
- `src/test/server/qgateKpiReportBridge.test.ts`: focused Vitest coverage for repo/python resolution and command construction
- `package.json`: add `report:qgate-kpi` script
- `.github/skills/qgate-kpi-report-generator/SKILL.md`: workspace-local skill definition
- `README.md`: document the new bridge command and overrides

### Default output path

Unless the user explicitly passes `--output-root`, the bridge should write into:

- `docs/qgate-reports/generated_runs/`

This keeps generated artifacts inside Vizion Lab instead of the sibling TPMDashboard tree.

## Edge Cases

- If neither sibling repo candidate exists, fail with an actionable error explaining how to set `VIZION_QGATE_REPORT_SOURCE_REPO`.
- If no preferred Python executable exists, still fall back to `python` so environments with PATH-managed Python can work.
- If the user passes an explicit `--output-root`, do not override it.
- If `PYTHONPATH` already exists, prepend the TPMDashboard repo path instead of discarding the existing value.

## Testing Strategy

Add focused tests that prove:

- source repo resolution prefers explicit override and otherwise falls back to known sibling candidates
- Python resolution prefers explicit override, then sibling `.venv`, then local `.venv`
- command construction injects `PYTHONPATH` and defaults output into Vizion Lab
- explicit `--output-root` is preserved instead of replaced

## Out of Scope

- Reimplementing the TPMDashboard report logic inside Vizion Lab
- Changing the generated HTML/XLSX report content
- Replacing TPMDashboard data prerequisites with a Vizion-Lab-native analytics report in this first migration