from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest

from backend.analytics.test_case_bodies import TestCaseBody
from backend.analytics.test_case_index import (
    SimilarTestCase,
    format_few_shot_examples,
    format_few_shot_examples_full,
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


# --- format_few_shot_examples_full tests ---


def _case(test_id: str, name: str, score: float = 0.8) -> SimilarTestCase:
    return SimilarTestCase(test_id=test_id, name=name, score=score, team="", release="", subtype="")


def test_format_few_shot_full_includes_step_script() -> None:
    bodies = {
        "123": TestCaseBody(
            test_id="123",
            name="pps CPU load regression",
            description_text="objective",
            steps_text="- [PreCon] vehicle ready\n- record CPU load\n- ? CPU load <= 0.17%",
        ),
    }
    result = format_few_shot_examples_full([_case("123", "name-only")], bodies)
    assert "Steps:" in result
    assert "- [PreCon] vehicle ready" in result
    assert "- ? CPU load <= 0.17%" in result
    assert "pps CPU load regression" in result
    assert "similarity: 0.80" in result


def test_format_few_shot_full_falls_back_to_name_only_without_body() -> None:
    result = format_few_shot_examples_full([_case("123", "Speech wakeup test")], {})
    assert "Speech wakeup test" in result
    assert "full body unavailable" in result
    assert "Steps:" not in result


def test_format_few_shot_full_truncates_long_step_scripts() -> None:
    long_steps = "\n".join(f"- action step {i}" for i in range(100))
    bodies = {"1": TestCaseBody(test_id="1", name="n", description_text="", steps_text=long_steps)}
    result = format_few_shot_examples_full([_case("1", "n")], bodies, max_step_lines=5, max_chars=120)
    assert "action step 5" not in result
    assert "(truncated)" in result


def test_format_few_shot_full_mixed_bodies() -> None:
    cases = [_case("1", "with body"), _case("2", "without body")]
    bodies = {"1": TestCaseBody(test_id="1", name="full", description_text="", steps_text="- a\n- ? b <= 1%")}
    result = format_few_shot_examples_full(cases, bodies)
    assert "- a" in result
    assert "without body" in result


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


# --- model_coverage criterion tests (stage-1 test design model) ---


def _test_model() -> dict[str, Any]:
    return {
        "dimensions": [
            {
                "name": "drive_mode",
                "aspect": "vehicle state",
                "classes": [
                    {"id": "dm-1", "name": "IDLE-FAHREN"},
                    {"id": "dm-2", "name": "TYPICAL mode", "isBoundary": True},
                ],
            },
            {
                "name": "software_build",
                "aspect": "candidate vs baseline",
                "classes": [
                    {"id": "sw-1", "name": "baseline build PU2707"},
                    {"id": "sw-2", "name": "candidate build PU2708"},
                ],
            },
        ],
        "combinations": [
            {"id": "TC-1", "classRefs": ["dm-1", "sw-2"], "priority": "high", "rationale": "defect scenario"},
            {"id": "TC-2", "classRefs": ["dm-2", "sw-1"], "priority": "normal", "rationale": "boundary contrast"},
        ],
    }


_MODEL_STEPS = "\n".join([
    "- [PreCon] IDCEvo test vehicle ready",
    "- record pps CPU load",
    "- drive in IDLE-FAHREN mode on candidate build PU2708",
    "- drive in TYPICAL mode on baseline build PU2707",
    "- compare candidate against baseline",
    "- ? CPU load must NOT exceed 0.17%",
])


def _model_description() -> str:
    return "<html><body>Reference: defect D2804379</body></html>"


def test_model_coverage_passes_when_all_combinations_covered() -> None:
    result = verify_test_case(
        defect=_good_defect(),
        description_html=_model_description(),
        steps_text=_MODEL_STEPS,
        test_model=_test_model(),
        combination_coverage=["TC-1", "TC-2"],
    )
    model = next(c for c in result.criteria if c.name == "model_coverage")
    assert model.passed is True
    assert "2 combinations" in model.evidence


def test_model_coverage_fails_on_unclaimed_combination() -> None:
    result = verify_test_case(
        defect=_good_defect(),
        description_html=_model_description(),
        steps_text=_MODEL_STEPS,
        test_model=_test_model(),
        combination_coverage=["TC-1"],
    )
    model = next(c for c in result.criteria if c.name == "model_coverage")
    assert model.passed is False
    assert "TC-2" in model.evidence


def test_model_coverage_rejects_claims_without_step_evidence() -> None:
    # TC-1 is claimed but the steps never mention the candidate build class.
    steps = _MODEL_STEPS.replace("candidate build PU2708", "another build")
    result = verify_test_case(
        defect=_good_defect(),
        description_html=_model_description(),
        steps_text=steps,
        test_model=_test_model(),
        combination_coverage=["TC-1", "TC-2"],
    )
    model = next(c for c in result.criteria if c.name == "model_coverage")
    assert model.passed is False
    assert "TC-1" in model.evidence


def test_model_coverage_criterion_absent_without_model() -> None:
    result = verify_test_case(defect=_good_defect(), description_html=_good_description(), steps_text=_good_steps())
    assert all(c.name != "model_coverage" for c in result.criteria)
