# Trusted Closure P0.2 Semantic Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject selected grouping dimensions that have no backend binding or no source value, preventing `(missing)` pseudo-groups and raw `KeyError` failures from becoming semantic results.

**Architecture:** The deterministic Python executor owns availability. Before aggregation, it validates every selected dimension against the entity's field map and every retained source row. The error contract distinguishes an unbound catalog dimension from a bound dimension with unavailable values, both as HTTP-compatible `422` semantic errors. `_dimension_value()` remains defensive so new call paths cannot reintroduce a synthetic `(missing)` value.

**Tech Stack:** Python 3.11, FastAPI semantic executor, pytest, compiled ontology fixture.

---

## Task 1: Lock Down Unavailable-Dimension Behavior

**Files:**

- Modify: `backend/tests/test_semantic_query_api.py`

- [x] **Step 1: Add a failing all-empty dimension test**

```python
def test_grouping_rejects_rows_without_dimension_values(catalog) -> None:
    payload = _payload(catalog)
    payload["query"]["dimensionIds"] = ["product.ecu"]

    with pytest.raises(SemanticQueryError, match="SEMANTIC_DIMENSION_VALUES_UNAVAILABLE:product.ecu") as exc_info:
        execute_semantic_query(
            payload,
            catalog=catalog,
            defect_provider=lambda _filters: {
                "snapshot_version": "missing-ecu-1",
                "generated_from": {},
                "ticket_rows": [{"ticket_id": "D-1", "problem_finder_team": "DTSV_China", "assigned_ecu": ""}],
            },
        )

    assert exc_info.value.status_code == 422
```

- [x] **Step 2: Add a failing approved-but-unbound catalog dimension test**

```python
def test_grouping_rejects_approved_dimension_without_executor_binding(catalog) -> None:
    payload = _payload(catalog)
    payload["query"]["dimensionIds"] = ["quality.solution_cluster"]

    with pytest.raises(SemanticQueryError, match="SEMANTIC_DIMENSION_NOT_EXECUTABLE:quality.solution_cluster") as exc_info:
        execute_semantic_query(
            payload,
            catalog=catalog,
            defect_provider=lambda _filters: {
                "snapshot_version": "unbound-dimension-1",
                "generated_from": {},
                "ticket_rows": [{"ticket_id": "D-1", "problem_finder_team": "DTSV_China"}],
            },
        )

    assert exc_info.value.status_code == 422
```

- [x] **Step 3: Run the two tests and confirm RED**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest backend/tests/test_semantic_query_api.py -q -k "grouping_rejects"
```

Expected: the empty case returns a `(missing)` group instead of raising, and the unbound case leaks a `KeyError` instead of `SemanticQueryError`.

## Task 2: Enforce Availability Before Aggregation

**Files:**

- Modify: `backend/analytics/semantic_query.py`
- Test: `backend/tests/test_semantic_query_api.py`

- [x] **Step 1: Add shared source-value and grouping-availability helpers**

```python
def _has_source_value(value: Any) -> bool:
    return value is not None and str(value).strip() != ""

def _validate_grouping_dimensions(rows: list[dict[str, Any]], dimension_ids: list[str], field_map: dict[str, str]) -> None:
    for dimension_id in dimension_ids:
        source_field = field_map.get(dimension_id)
        if not source_field:
            raise SemanticQueryError(f"SEMANTIC_DIMENSION_NOT_EXECUTABLE:{dimension_id}", status_code=422)
        if any(not _has_source_value(row.get(source_field)) for row in rows):
            raise SemanticQueryError(f"SEMANTIC_DIMENSION_VALUES_UNAVAILABLE:{dimension_id}", status_code=422)
```

An empty row set remains a real zero result. A non-empty row set with even one unavailable selected grouping value is not a valid aggregate grain.

- [x] **Step 2: Invoke availability validation at the start of `_aggregate_rows()`**

```python
_validate_grouping_dimensions(rows, dimension_ids, field_map)
```

Remove the `DIMENSION_VALUES_MISSING` warning path; a returned group must never contain `(missing)`.

- [x] **Step 3: Make `_dimension_value()` defensive**

```python
source_field = field_map.get(dimension_id)
if not source_field:
    raise SemanticQueryError(f"SEMANTIC_DIMENSION_NOT_EXECUTABLE:{dimension_id}", status_code=422)
value = row.get(source_field)
if not _has_source_value(value):
    raise SemanticQueryError(f"SEMANTIC_DIMENSION_VALUES_UNAVAILABLE:{dimension_id}", status_code=422)
```

For time dimensions, reject an unparseable value with the same availability code rather than emitting `(missing)`.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest backend/tests/test_semantic_query_api.py -q -k "grouping_rejects or empty_result_is_zero_not_missing or test_run_metrics_use_team_scope_status_and_time"
```

Expected: unavailable groupings return `422`, zero rows remain a zero result, and valid defect/test-run grouping results remain unchanged.

## Task 3: Verify the Semantic Availability Slice

**Files:**

- Test: `backend/tests/test_semantic_query_api.py`
- Test: `backend/tests/test_semantic_analysis_store.py`

- [x] **Step 1: Run semantic executor and analysis-reference regressions**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest backend/tests/test_semantic_query_api.py backend/tests/test_semantic_analysis_store.py -q
```

Expected: all semantic query, record continuation, scope, revision, and store lifecycle tests pass.

- [x] **Step 2: Run Python syntax and worktree checks**

Run:

```powershell
.\.venv\Scripts\python.exe -m py_compile backend/analytics/semantic_query.py
git diff --check
git status --short
```

Expected: no syntax or whitespace errors and only planned P0 files are changed.

### Scope Boundaries

- Do not make an unavailable catalog dimension executable by adding an ad hoc mapping in this slice.
- Do not introduce fallback grouping labels, partial-group filtering, or silent row dropping.
- Do not change records pagination, source revision policy, or row-policy execution here; those require separate contracts.
