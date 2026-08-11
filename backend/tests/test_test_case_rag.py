from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest

from backend.analytics.test_case_index import (
    SimilarTestCase,
    format_few_shot_examples,
    _load_test_cases_df,
)
from backend.analytics.test_case_verifier import (
    VerificationResult,
    verify_test_case,
)


# --- test_case_index tests ---


def _make_test_db(tmp_path: Path) -> str:
    db = tmp_path / "test_source.db"
    with sqlite3.connect(str(db)) as conn:
        conn.execute(
            """
            CREATE TABLE octane_testcases (
                test_id TEXT, test_name TEXT, test_subtype TEXT,
                scope_team TEXT, scope_release TEXT, run_count INTEGER,
                raw_json TEXT, fetched_at TEXT
            )
            """
        )
        conn.executemany(
            "INSERT INTO octane_testcases(test_id, test_name, test_subtype, scope_team, scope_release, run_count, raw_json, fetched_at) VALUES (?,?,?,?,?,?,?,?)",
            [
                ("T1", "Speech wakeup fails on IDCEVO U11", "test_manual", "DTSV_China", "R-26-07", 1, "{}", "2026-01-01"),
                ("T2", "CPU load monitoring during navigation", "test_manual", "DTSV_China", "R-26-06", 2, "{}", "2026-01-01"),
                ("T3", "Bluetooth pairing after restart", "test_manual", "DTSV_China", "R-26-05", 1, "{}", "2026-01-01"),
            ],
        )
    return str(db)


def test_load_test_cases_df_renames_test_name_to_name(tmp_path: Path) -> None:
    db = _make_test_db(tmp_path)
    df = _load_test_cases_df(db)
    assert "name" in df.columns
    assert "id" in df.columns
    assert len(df) == 3
    assert df.iloc[0]["name"] == "Speech wakeup fails on IDCEVO U11"


def test_load_test_cases_df_skips_empty_names(tmp_path: Path) -> None:
    db = str(tmp_path / "test.db")
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE octane_testcases (test_id TEXT, test_name TEXT, test_subtype TEXT, scope_team TEXT, scope_release TEXT, run_count INTEGER, raw_json TEXT, fetched_at TEXT)")
        conn.executemany("INSERT INTO octane_testcases VALUES (?,?,?,?,?,?,?,?)", [("T1", "valid name", "test_manual", "x", "y", 1, "{}", ""), ("T2", "", "test_manual", "x", "y", 1, "{}", "")])
    df = _load_test_cases_df(db)
    assert len(df) == 1  # empty name filtered out


def test_format_few_shot_examples_empty() -> None:
    assert format_few_shot_examples([]) == ""


def test_format_few_shot_examples_formats_cases() -> None:
    cases = [
        SimilarTestCase(test_id="123", name="Speech wakeup test", score=0.5, team="", release="", subtype=""),
        SimilarTestCase(test_id="456", name="CPU load test", score=0.3, team="", release="", subtype=""),
    ]
    result = format_few_shot_examples(cases, max_cases=2)
    assert "T123" in result
    assert "Speech wakeup test" in result
    assert "T456" in result
    assert "similarity: 0.50" in result


def test_format_few_shot_respects_max_cases() -> None:
    cases = [SimilarTestCase(test_id=str(i), name=f"test {i}", score=0.1 * i, team="", release="", subtype="") for i in range(5)]
    result = format_few_shot_examples(cases, max_cases=2)
    assert "T0" in result
    assert "T1" in result
    assert "T3" not in result


# --- test_case_verifier tests ---


def _good_defect() -> dict[str, Any]:
    return {"defect_id": "2804379", "name": "pps constant CPU load when car is moving", "severity": "Very High"}


def _good_steps() -> str:
    return "\n".join([
        "- [PreCon] IDCEvo test vehicle U11 with PU2707 software",
        "- [PreCon] Perfetto trace recording available",
        "- Flash the baseline build pu2707_i420-26w30.1-2",
        "- Record CPU load of com.bmwgroup.apinext.pps in each drive mode",
        "- Flash candidate build pu2707_i420-26w32.1-1",
        "- Compare CPU load against baseline",
        "- ? CPU load must NOT exceed 0.17% in IDLE-FAHREN mode",
        "- ? No increase beyond 0.10% in TYPICAL mode",
    ])


def _good_description() -> str:
    return "<html><body>Objective: verify pps CPU load. Reference: defect D2804379</body></html>"


def test_verify_test_case_passes_on_good_content() -> None:
    result = verify_test_case(defect=_good_defect(), description_html=_good_description(), steps_text=_good_steps())
    assert result.passed is True
    assert result.pass_count == result.total_count
    assert result.feedback == ""
    criterion_names = [c.name for c in result.criteria]
    assert "failure_mode_coverage" in criterion_names
    assert "step_reproducibility" in criterion_names
    assert "format_compliance" in criterion_names
    assert "checkpoint_quantification" in criterion_names
    assert "defect_traceability" in criterion_names


def test_verify_fails_on_missing_precon_prefix() -> None:
    steps = "- Flash build\n- Record CPU\n- ? load below 0.17%"  # no [PreCon]
    result = verify_test_case(defect=_good_defect(), description_html=_good_description(), steps_text=steps)
    assert result.passed is False
    fmt = next(c for c in result.criteria if c.name == "format_compliance")
    assert fmt.passed is False
    assert "[PreCon]" in fmt.evidence


def test_verify_fails_on_missing_defect_id() -> None:
    desc = "<html><body>Objective: verify CPU load</body></html>"  # no defect id
    result = verify_test_case(defect=_good_defect(), description_html=desc, steps_text=_good_steps())
    assert result.passed is False
    trace = next(c for c in result.criteria if c.name == "defect_traceability")
    assert trace.passed is False
    assert "2804379" in trace.evidence


def test_verify_fails_on_vague_checkpoints() -> None:
    steps = "\n".join([
        "- [PreCon] vehicle ready",
        "- do the test",
        "- ? check it works",
        "- ? verify behavior",
    ])
    result = verify_test_case(defect=_good_defect(), description_html=_good_description(), steps_text=steps)
    quant = next(c for c in result.criteria if c.name == "checkpoint_quantification")
    assert quant.passed is False


def test_verify_fails_on_too_few_steps() -> None:
    steps = "- [PreCon] ready\n- ? check pps load below 0.17%"
    result = verify_test_case(defect=_good_defect(), description_html=_good_description(), steps_text=steps)
    repro = next(c for c in result.criteria if c.name == "step_reproducibility")
    assert repro.passed is False


def test_verify_feedback_lists_all_failures() -> None:
    result = verify_test_case(defect=_good_defect(), description_html="no defect id", steps_text="vague")
    assert result.passed is False
    assert "format_compliance" in result.feedback
    assert "Regeneration needed" in result.feedback
