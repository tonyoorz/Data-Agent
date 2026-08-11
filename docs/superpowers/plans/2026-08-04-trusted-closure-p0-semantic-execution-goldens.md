# Trusted Closure P0.4 Semantic Execution Goldens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic execution goldens that run the real Semantic Kernel and analysis-reference store against a fixed pinned snapshot, rather than only resolver output or hand-written Node HTTP responses.

**Architecture:** A JSONL corpus in `evals/semantic-execution/target` defines exact query/result/error contracts. A pytest harness reads each case, overlays the compiled ontology version and fingerprint, and invokes `execute_semantic_query()` and `execute_semantic_records()` with a fixed in-memory provider and temporary SQLite `SemanticAnalysisStore`. The first ten cases establish the extensible baseline for aggregate, compare, trend, records, scope, revision, zero, availability, and evidence behavior.

**Tech Stack:** Python 3.11, pytest, SQLite, existing Semantic Kernel and compiled ontology.

---

## Task 1: Define a Failing JSONL Golden Harness

**Files:**

- Create: `backend/tests/test_semantic_execution_goldens.py`

- [x] **Step 1: Add a pytest harness that requires an execution corpus**

```python
GOLDEN_PATH = REPO_ROOT / "evals" / "semantic-execution" / "target" / "semantic-execution-golden.jsonl"

def _load_cases() -> list[dict[str, Any]]:
    return [json.loads(line) for line in GOLDEN_PATH.read_text(encoding="utf-8").splitlines() if line.strip()]

def test_semantic_execution_goldens(catalog, tmp_path: Path) -> None:
    cases = _load_cases()
    assert len(cases) >= 10
    for case in cases:
        _execute_case(case, catalog, tmp_path / f"{case['caseId']}.db")
```

`_execute_case()` must dispatch `query`, `records`, and expected-error cases through actual `execute_semantic_query()` / `execute_semantic_records()` calls, not `TestClient` or Node fetch mocks.

- [x] **Step 2: Run the harness and confirm RED**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest backend/tests/test_semantic_execution_goldens.py -q
```

Expected: the test fails only because `semantic-execution-golden.jsonl` is absent.

## Task 2: Add Fixed-Snapshot Golden Cases

**Files:**

- Create: `evals/semantic-execution/target/semantic-execution-golden.jsonl`
- Modify: `backend/tests/test_semantic_execution_goldens.py`

- [x] **Step 1: Define one pinned fixture provider and complete request builders**

```python
GOLDEN_SNAPSHOT_ID = "semantic-execution-snapshot-v1"
GOLDEN_ROWS = [
    {"ticket_id": "D-G1", "problem_finder_team": "DTSV_China", "assigned_ecu": "HU", "os": "OS8", "project": "P1", "creation_time": "2026-07-10T08:00:00Z"},
    {"ticket_id": "D-G2", "problem_finder_team": "DTSV_China", "assigned_ecu": "HU", "os": "OS9", "project": "P1", "creation_time": "2026-07-11T08:00:00Z"},
    {"ticket_id": "D-G3", "problem_finder_team": "DTSV_China", "assigned_ecu": "ADAS", "os": "OS9", "project": "P2", "creation_time": "2026-06-15T08:00:00Z"},
]
```

The provider must return `GOLDEN_SNAPSHOT_ID` when records replay the aggregate revision, proving continuation remains on one snapshot.

- [x] **Step 2: Add ten JSONL cases**

The corpus must contain these categories:

```text
aggregate_ecu
aggregate_project
compare_os
trend_creation_date
records_same_snapshot
records_scope_denied
records_stale_snapshot
empty_zero
dimension_values_unavailable
dimension_not_executable
```

Every successful query asserts exact `data`, `summary.metrics`, `sourceRevision.revisionId`, `analysisRef` presence, and evidence kind. Records asserts same `analysisRef`, revision, stable IDs, and allowlisted fields. Error cases assert exact code and status.

- [x] **Step 3: Run the golden harness and confirm GREEN**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest backend/tests/test_semantic_execution_goldens.py -q
```

Expected: all ten cases execute through the real Kernel and pass.

## Task 3: Verify the Execution Golden Slice

**Files:**

- Test: `backend/tests/test_semantic_execution_goldens.py`
- Test: `backend/tests/test_semantic_query_api.py`
- Test: `backend/tests/test_semantic_analysis_store.py`

- [x] **Step 1: Run execution and semantic regressions together**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest backend/tests/test_semantic_execution_goldens.py backend/tests/test_semantic_query_api.py backend/tests/test_semantic_analysis_store.py -q
```

Expected: golden execution, records continuation, scope, revision, and availability behavior all pass.

- [x] **Step 2: Check Python syntax and corpus shape**

Run:

```powershell
.\.venv\Scripts\python.exe -m py_compile backend/tests/test_semantic_execution_goldens.py
.\.venv\Scripts\python.exe -c "import json, pathlib; p=pathlib.Path('evals/semantic-execution/target/semantic-execution-golden.jsonl'); print(sum(1 for line in p.read_text(encoding='utf-8').splitlines() if json.loads(line)))"
git diff --check
```

Expected: the harness compiles, the corpus reports at least 10 valid JSON lines, and the diff has no whitespace errors.

### Scope Boundaries

- Do not call a live analytics database or company model from these tests.
- Do not classify resolver-only cases as execution goldens.
- Do not claim the initial 10 cases satisfy the eventual 40-60-case P0 coverage target; this creates the deterministic harness and a representative execution baseline.
- Do not change production query behavior solely to make a golden pass.
