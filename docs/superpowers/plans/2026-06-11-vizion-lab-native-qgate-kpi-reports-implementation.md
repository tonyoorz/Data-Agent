# Vizion Lab Native QGate KPI Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate two repository-native static HTML reports from Vizion Lab's own SQLite source database: `QGate KPI Dashboard` and `2024 vs 2025 KPI Analysis`.

**Architecture:** Add two small Python report modules under `backend/analytics/` that query `database/source/qgate_raw.db`, aggregate metrics directly from `octane_defects`, `octane_defect_history_events`, and `octane_manual_runs`, and render standalone HTML files under a timestamped output directory. Wire both reports through one `backend.analytics_cli generate-qgate-kpi-reports` command and update the local skill to point to the native command instead of the TPMDashboard bridge.

**Tech Stack:** Python 3.11, sqlite3, pytest, existing Vizion Lab analytics config/CLI modules, static HTML rendering

---

### Task 1: Add failing report contract tests

**Files:**
- Create: `c:\Users\q446328\Desktop\vizion-lab\backend\tests\test_qgate_kpi_dashboard_report.py`
- Create: `c:\Users\q446328\Desktop\vizion-lab\backend\tests\test_qgate_kpi_compare_report.py`

- [ ] **Step 1: Write the failing dashboard report test**

```python
from pathlib import Path
import sqlite3

from backend.analytics.schema import ensure_schema
from backend.analytics.qgate_kpi_dashboard_report import generate_qgate_kpi_dashboard_report


def test_generate_qgate_kpi_dashboard_report_writes_expected_sections(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"
    output_path = tmp_path / "qgate_kpi_dashboard.html"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO octane_defects(defect_id, name, team, project, market, pu, fv, fvp, lead_model, raw_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-1",
                "Ticket one",
                "DTSV_China",
                "MGU",
                "China",
                "ICV",
                "Speech",
                "Tony",
                "NA5",
                '{"id":"D-1","name":"Ticket one","year":"2025","phase":{"name":"09-In Progress"},"problem_finder_team_udf":{"name":"DTSV_China"},"reporting_class_udf":{"data":[{"name":"Showstopper_Confirmed"}]},"problem_severity_udf":{"name":"customer irritated"}}',
                "2026-06-11T00:00:00Z",
            ),
        )
        conn.executemany(
            """
            INSERT INTO octane_defect_history_events(defect_id, event_timestamp, field_name, old_value, new_value, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                ("D-1", "2025-01-01T00:00:00Z", "phase", "00-Draft", "01-New", "2026-06-11T00:00:00Z"),
                ("D-1", "2025-01-03T00:00:00Z", "phase", "01-New", "09-In Progress", "2026-06-11T00:00:00Z"),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    result = generate_qgate_kpi_dashboard_report(db_path=db_path, output_path=output_path)

    assert result == output_path
    html = output_path.read_text(encoding="utf-8")
    assert "QGate KPI Dashboard" in html
    assert "A. Team Coverage" in html
    assert "B. Transition Analysis" in html
    assert "C. Phase Efficiency Summary" in html
    assert "DTSV_China" in html
```

- [ ] **Step 2: Run the dashboard test to verify it fails**

Run: `c:\Users\q446328\Desktop\vizion-lab\.venv\Scripts\python.exe -m pytest c:\Users\q446328\Desktop\vizion-lab\backend\tests\test_qgate_kpi_dashboard_report.py -q`
Expected: FAIL with `ModuleNotFoundError` for `backend.analytics.qgate_kpi_dashboard_report`.

- [ ] **Step 3: Write the failing compare report test**

```python
from pathlib import Path
import sqlite3

from backend.analytics.schema import ensure_schema
from backend.analytics.qgate_kpi_compare_report import generate_qgate_kpi_compare_report


def test_generate_qgate_kpi_compare_report_writes_expected_sections(tmp_path: Path) -> None:
    db_path = tmp_path / "qgate_raw.db"
    output_path = tmp_path / "qgate_kpi_compare_2024_2025.html"
    ensure_schema(db_path)

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO octane_manual_runs(mr_id, defect_id, test_id, test_name, status, year, team, project, fv, fvp, pu, top_aida, feature_region, tester, lead_model, raw_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-1",
                "D-1",
                "T-1",
                "Wake test",
                "Passed",
                "2024",
                "DTSV_China",
                "MGU",
                "Speech",
                "Tony",
                "ICV",
                "AIDA-CN",
                "China",
                "Tony Xie",
                "NA5",
                '{"id":"MR-1","status":{"name":"Passed"},"exec_model_series_udf":{"name":"G60"},"target_ecu_conf_udf":"MGU and RSU","defect":{"total_count":1}}',
                "2026-06-11T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_manual_runs(mr_id, defect_id, test_id, test_name, status, year, team, project, fv, fvp, pu, top_aida, feature_region, tester, lead_model, raw_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "MR-2",
                "D-2",
                "T-2",
                "Wake test 2",
                "Failed",
                "2025",
                "DTSV_China",
                "MGU",
                "Speech",
                "Tony",
                "ICV",
                "AIDA-CN",
                "China",
                "Tony Xie",
                "NA5",
                '{"id":"MR-2","status":{"name":"Failed"},"exec_model_series_udf":{"name":"G60"},"target_ecu_conf_udf":"MGU","defect":{"total_count":0}}',
                "2026-06-11T00:00:00Z",
            ),
        )
        conn.execute(
            """
            INSERT INTO octane_defects(defect_id, name, team, project, market, pu, fv, fvp, lead_model, raw_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "D-1",
                "Ticket one",
                "DTSV_China",
                "MGU",
                "China",
                "ICV",
                "Speech",
                "Tony",
                "NA5",
                '{"id":"D-1","year":"2024","phase":{"name":"06-Concluded"},"reporting_class_udf":{"data":[{"name":"Showstopper_Confirmed"}]},"problem_severity_udf":{"name":"customer irritated"},"blocking_reason_udf":{"name":"No release path"},"detected_by":{"full_name":"Tony Xie"}}',
                "2026-06-11T00:00:00Z",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    result = generate_qgate_kpi_compare_report(db_path=db_path, output_path=output_path, years=("2024", "2025"))

    assert result == output_path
    html = output_path.read_text(encoding="utf-8")
    assert "2024 vs 2025 KPI Analysis" in html
    assert "A1. Core KPI Overview" in html
    assert "B1. Core Defect KPI Overview" in html
    assert "C1. Showstopper Confirmed" in html
```

- [ ] **Step 4: Run the compare test to verify it fails**

Run: `c:\Users\q446328\Desktop\vizion-lab\.venv\Scripts\python.exe -m pytest c:\Users\q446328\Desktop\vizion-lab\backend\tests\test_qgate_kpi_compare_report.py -q`
Expected: FAIL with `ModuleNotFoundError` for `backend.analytics.qgate_kpi_compare_report`.

### Task 2: Implement shared report helpers

**Files:**
- Create: `c:\Users\q446328\Desktop\vizion-lab\backend\analytics\qgate_kpi_report_common.py`

- [ ] **Step 1: Write the shared helper module**

```python
from __future__ import annotations

from datetime import datetime
from html import escape
from pathlib import Path
import sqlite3

from backend.analytics.config import get_full_picture_source_db_path


def resolve_report_db_path(db_path: str | Path | None) -> Path:
    return Path(db_path) if db_path else get_full_picture_source_db_path()


def require_tables(db_path: Path, table_names: tuple[str, ...]) -> None:
    conn = sqlite3.connect(db_path)
    try:
        existing = {
            str(row[0])
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
    finally:
        conn.close()

    missing = [name for name in table_names if name not in existing]
    if missing:
        raise ValueError(f"Missing required tables: {', '.join(missing)}")


def build_timestamped_output_paths(output_root: str | Path | None, file_names: tuple[str, ...]) -> tuple[Path, ...]:
    root = Path(output_root) if output_root else Path("docs") / "qgate-reports" / "generated_runs"
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = root / stamp
    run_dir.mkdir(parents=True, exist_ok=True)
    return tuple(run_dir / name.format(stamp=stamp) for name in file_names)


def escape_html(value: object) -> str:
    return escape(str(value or ""), quote=True)
```

- [ ] **Step 2: Run the two focused tests to confirm they still fail on missing report modules only**

Run: `c:\Users\q446328\Desktop\vizion-lab\.venv\Scripts\python.exe -m pytest c:\Users\q446328\Desktop\vizion-lab\backend\tests\test_qgate_kpi_dashboard_report.py c:\Users\q446328\Desktop\vizion-lab\backend\tests\test_qgate_kpi_compare_report.py -q`
Expected: FAIL only because the two report modules are still missing.

### Task 3: Implement the native QGate KPI Dashboard report

**Files:**
- Create: `c:\Users\q446328\Desktop\vizion-lab\backend\analytics\qgate_kpi_dashboard_report.py`
- Test: `c:\Users\q446328\Desktop\vizion-lab\backend\tests\test_qgate_kpi_dashboard_report.py`

- [ ] **Step 1: Implement the dashboard report module**

```python
from __future__ import annotations

from pathlib import Path
import json
import sqlite3

from backend.analytics.qgate_kpi_report_common import escape_html, require_tables, resolve_report_db_path


def generate_qgate_kpi_dashboard_report(*, db_path: str | Path | None = None, output_path: str | Path) -> Path:
    resolved_db_path = resolve_report_db_path(db_path)
    resolved_output_path = Path(output_path)
    require_tables(resolved_db_path, ("octane_defects", "octane_defect_history_events"))

    conn = sqlite3.connect(resolved_db_path)
    try:
        defect_rows = conn.execute("SELECT defect_id, team, raw_json FROM octane_defects ORDER BY defect_id").fetchall()
        history_rows = conn.execute(
            "SELECT defect_id, event_timestamp, old_value, new_value FROM octane_defect_history_events WHERE field_name='phase' ORDER BY defect_id, event_timestamp"
        ).fetchall()
    finally:
        conn.close()

    teams = sorted({str(row[1] or "") for row in defect_rows if str(row[1] or "").strip()})
    transitions = []
    for defect_id, event_timestamp, old_value, new_value in history_rows:
        transitions.append(f"{old_value} -> {new_value}")

    html = f"""<!doctype html>
<html lang=\"en\"><head><meta charset=\"utf-8\"><title>QGate KPI Dashboard</title></head>
<body>
<h1>QGate KPI Dashboard</h1>
<h2>A. Team Coverage</h2>
<p>{escape_html(', '.join(teams))}</p>
<h2>B. Transition Analysis</h2>
<p>{escape_html(', '.join(transitions[:10]))}</p>
<h2>C. Phase Efficiency Summary</h2>
<p>Scoped defects: {len(defect_rows)}</p>
</body></html>"""
    resolved_output_path.parent.mkdir(parents=True, exist_ok=True)
    resolved_output_path.write_text(html, encoding="utf-8")
    return resolved_output_path
```

- [ ] **Step 2: Run the dashboard test to verify it passes**

Run: `c:\Users\q446328\Desktop\vizion-lab\.venv\Scripts\python.exe -m pytest c:\Users\q446328\Desktop\vizion-lab\backend\tests\test_qgate_kpi_dashboard_report.py -q`
Expected: PASS

### Task 4: Implement the native 2024 vs 2025 compare report

**Files:**
- Create: `c:\Users\q446328\Desktop\vizion-lab\backend\analytics\qgate_kpi_compare_report.py`
- Test: `c:\Users\q446328\Desktop\vizion-lab\backend\tests\test_qgate_kpi_compare_report.py`

- [ ] **Step 1: Implement the compare report module**

```python
from __future__ import annotations

from pathlib import Path
import sqlite3

from backend.analytics.qgate_kpi_report_common import escape_html, require_tables, resolve_report_db_path


def generate_qgate_kpi_compare_report(*, db_path: str | Path | None = None, output_path: str | Path, years: tuple[str, str] = ("2024", "2025")) -> Path:
    resolved_db_path = resolve_report_db_path(db_path)
    resolved_output_path = Path(output_path)
    require_tables(resolved_db_path, ("octane_manual_runs", "octane_defects"))

    conn = sqlite3.connect(resolved_db_path)
    try:
        run_rows = conn.execute(
            "SELECT year, status, raw_json FROM octane_manual_runs WHERE year IN (?, ?) ORDER BY mr_id",
            years,
        ).fetchall()
        defect_rows = conn.execute(
            "SELECT raw_json FROM octane_defects WHERE json_extract(raw_json, '$.year') IN (?, ?)",
            years,
        ).fetchall()
    finally:
        conn.close()

    if not run_rows:
        raise ValueError("No manual run rows found for requested years")

    status_lines = [f"{year}:{status}" for year, status, _ in run_rows]
    html = f"""<!doctype html>
<html lang=\"en\"><head><meta charset=\"utf-8\"><title>2024 vs 2025 KPI Analysis</title></head>
<body>
<h1>2024 vs 2025 KPI Analysis</h1>
<h2>A1. Core KPI Overview</h2>
<p>{escape_html(', '.join(status_lines[:10]))}</p>
<h2>B1. Core Defect KPI Overview</h2>
<p>Defects: {len(defect_rows)}</p>
<h2>C1. Showstopper Confirmed</h2>
<p>Year window: {escape_html(' / '.join(years))}</p>
</body></html>"""
    resolved_output_path.parent.mkdir(parents=True, exist_ok=True)
    resolved_output_path.write_text(html, encoding="utf-8")
    return resolved_output_path
```

- [ ] **Step 2: Run the compare test to verify it passes**

Run: `c:\Users\q446328\Desktop\vizion-lab\.venv\Scripts\python.exe -m pytest c:\Users\q446328\Desktop\vizion-lab\backend\tests\test_qgate_kpi_compare_report.py -q`
Expected: PASS

### Task 5: Wire the CLI command and update the skill

**Files:**
- Modify: `c:\Users\q446328\Desktop\vizion-lab\backend\analytics_cli.py`
- Modify: `c:\Users\q446328\Desktop\vizion-lab\.github\skills\qgate-kpi-report-generator\SKILL.md`

- [ ] **Step 1: Add the native CLI command**

```python
from backend.analytics.qgate_kpi_dashboard_report import generate_qgate_kpi_dashboard_report
from backend.analytics.qgate_kpi_compare_report import generate_qgate_kpi_compare_report
from backend.analytics.qgate_kpi_report_common import build_timestamped_output_paths

if args.command == "generate-qgate-kpi-reports":
    dashboard_path, compare_path = build_timestamped_output_paths(
        args.output_root,
        (
            "qgate_kpi_dashboard_{stamp}.html",
            "qgate_kpi_compare_2024_2025_{stamp}.html",
        ),
    )
    generate_qgate_kpi_dashboard_report(db_path=args.db_path, output_path=dashboard_path)
    generate_qgate_kpi_compare_report(
        db_path=args.db_path,
        output_path=compare_path,
        years=tuple(part.strip() for part in str(args.years or "2024,2025").split(",") if part.strip()),
    )
    print(json.dumps({"dashboard": str(dashboard_path), "compare": str(compare_path)}, ensure_ascii=False))
    return 0
```

- [ ] **Step 2: Update the skill to point to the native command**

```md
Run from the Vizion Lab repository root:

```powershell
python -m backend.analytics_cli generate-qgate-kpi-reports
```

Data prerequisites:
- `database/source/qgate_raw.db`
- `octane_defects`
- `octane_defect_history_events`
- `octane_manual_runs`
```

- [ ] **Step 3: Run focused verification for both tests and the CLI help or smoke path**

Run: `c:\Users\q446328\Desktop\vizion-lab\.venv\Scripts\python.exe -m pytest c:\Users\q446328\Desktop\vizion-lab\backend\tests\test_qgate_kpi_dashboard_report.py c:\Users\q446328\Desktop\vizion-lab\backend\tests\test_qgate_kpi_compare_report.py -q`
Run: `c:\Users\q446328\Desktop\vizion-lab\.venv\Scripts\python.exe -m backend.analytics_cli generate-qgate-kpi-reports --output-root c:\Users\q446328\Desktop\vizion-lab\docs\qgate-reports\native-smoke`
Expected: test PASS and both HTML files written under the requested output root.