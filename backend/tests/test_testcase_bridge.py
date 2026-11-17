from __future__ import annotations

from typing import Any

from backend.analytics import test_case_bodies, test_case_index
from backend.analytics import ontology_context
from backend.analytics.test_case_bodies import TestCaseBody
from scripts import testcase_bridge


def _defect() -> dict[str, str]:
    return {
        "defect_id": "2804379",
        "name": "pps constant CPU load when car is moving",
        "severity": "Very High",
        "software_version": "PU2707",
        "assigned_ecu": "IDCEVO",
        "lead_model": "G20",
        "project": "SP25",
        "phase": "open",
        "description": "CPU load rises constantly while driving",
    }


def _similar() -> list[test_case_index.SimilarTestCase]:
    return [
        test_case_index.SimilarTestCase(
            test_id="1414874",
            name="pps CPU load stable when car is moving",
            score=0.83,
            team="DTSV_China",
            release="R-26-07",
            subtype="test_manual",
        ),
        test_case_index.SimilarTestCase(
            test_id="690490",
            name="CPU load monitoring during navigation",
            score=0.71,
            team="",
            release="",
            subtype="",
        ),
    ]


def _bodies() -> dict[str, TestCaseBody]:
    return {
        "1414874": TestCaseBody(
            test_id="1414874",
            name="pps CPU load stable when car is moving",
            description_text="objective",
            steps_text="- [PreCon] IDCEvo vehicle\n- record CPU load\n- ? CPU load <= 0.17%",
        ),
        "690490": TestCaseBody(
            test_id="690490",
            name="CPU load monitoring during navigation",
            description_text="",
            steps_text="- [PreCon] navigation active\n- ? load <= 30%",
        ),
    }


def _patch_happy_path(monkeypatch, *, bodies: dict[str, TestCaseBody] | None = None) -> dict[str, list[Any]]:
    calls: dict[str, list[Any]] = {"bodies": [], "context": []}
    monkeypatch.setattr(testcase_bridge, "_read_defect", lambda _defect_id: _defect())
    monkeypatch.setattr(test_case_index, "retrieve_similar_test_cases", lambda _q, top_k=5: _similar())
    monkeypatch.setattr(
        test_case_bodies,
        "get_test_bodies",
        lambda ids, **_kwargs: calls["bodies"].append(list(ids)) or (bodies if bodies is not None else _bodies()),
    )
    monkeypatch.setattr(
        ontology_context,
        "build_test_case_context_payload",
        lambda _payload: calls["context"].append(_payload)
        or {
            "business_scope": {"project": "SP25", "release": "R-26-07"},
            "coverage_summary": {"related_testcases": 3, "latest_runs": 5, "passed": 4, "failed": 1},
            "traceability": {"features": [{"id": "f1", "name": "Performance stability"}]},
            "gaps": [{"gap_type": "failed_related_run", "description": "Related testcase has failed runs."}],
            "defect_context": {"defect_id": "2804379", "requirement": "CPU load must stay stable"},
        },
    )
    return calls


def test_prepare_returns_full_body_few_shot_and_context(monkeypatch) -> None:
    calls = _patch_happy_path(monkeypatch)

    result = testcase_bridge._do_prepare({"defect_id": "2804379"})

    assert result["success"] is True
    assert result["defect_info"]["defect_id"] == "2804379"
    assert [c["testId"] for c in result["similar_cases"]] == ["1414874", "690490"]
    # Full-body few-shot: the reference step script itself is in the prompt text.
    assert "- ? CPU load <= 0.17%" in result["few_shot_text"]
    assert "Steps:" in result["few_shot_text"]
    # Ontology context: scope + requirement + gap rendered as prompt text.
    assert "SP25" in result["context_text"]
    assert "CPU load must stay stable" in result["context_text"]
    assert "failed_related_run" in result["context_text"]
    assert result["bodies_fetched"] == 2
    # Body enrichment asked for the top-3 retrieved ids only.
    assert calls["bodies"] == [["1414874", "690490"]]
    # Context anchored on the defect.
    assert calls["context"] == [{"anchor": {"type": "defect_id", "value": "2804379"}}]


def test_prepare_degrades_to_name_only_when_octane_unavailable(monkeypatch) -> None:
    monkeypatch.setattr(testcase_bridge, "_read_defect", lambda _defect_id: _defect())
    monkeypatch.setattr(test_case_index, "retrieve_similar_test_cases", lambda _q, top_k=5: _similar())
    monkeypatch.setattr(
        test_case_bodies,
        "get_test_bodies",
        lambda _ids, **_kwargs: (_ for _ in ()).throw(RuntimeError("octane unreachable")),
    )
    monkeypatch.setattr(
        ontology_context,
        "build_test_case_context_payload",
        lambda _payload: {"business_scope": {"project": "SP25"}},
    )

    result = testcase_bridge._do_prepare({"defect_id": "2804379"})

    assert result["success"] is True
    assert "full body unavailable" in result["few_shot_text"]
    assert "Steps:" not in result["few_shot_text"]
    assert result["bodies_fetched"] == 0
    assert "SP25" in result["context_text"]


def test_prepare_degrades_to_empty_context_on_context_failure(monkeypatch) -> None:
    monkeypatch.setattr(testcase_bridge, "_read_defect", lambda _defect_id: _defect())
    monkeypatch.setattr(test_case_index, "retrieve_similar_test_cases", lambda _q, top_k=5: _similar())
    monkeypatch.setattr(
        test_case_bodies,
        "get_test_bodies",
        lambda _ids, **_kwargs: (_ for _ in ()).throw(RuntimeError("no bodies")),
    )
    monkeypatch.setattr(
        ontology_context,
        "build_test_case_context_payload",
        lambda _payload: (_ for _ in ()).throw(RuntimeError("db locked")),
    )

    result = testcase_bridge._do_prepare({"defect_id": "2804379"})

    assert result["success"] is True
    assert result["context_text"] == ""
    assert result["bodies_fetched"] == 0


def test_prepare_skips_body_fetch_when_disabled(monkeypatch) -> None:
    monkeypatch.setenv("TESTCASE_FEW_SHOT_FULL_BODIES", "0")
    monkeypatch.setattr(testcase_bridge, "_read_defect", lambda _defect_id: _defect())
    monkeypatch.setattr(test_case_index, "retrieve_similar_test_cases", lambda _q, top_k=5: _similar())

    def unexpected_fetch(*_args, **_kwargs):
        raise AssertionError("body fetch must not run when full bodies are disabled")

    monkeypatch.setattr(test_case_bodies, "get_test_bodies", unexpected_fetch)
    monkeypatch.setattr(
        ontology_context,
        "build_test_case_context_payload",
        lambda _payload: {"business_scope": {"project": "SP25"}},
    )

    result = testcase_bridge._do_prepare({"defect_id": "2804379"})
    assert result["success"] is True
    assert "full body unavailable" in result["few_shot_text"]


def test_prepare_requires_defect_id() -> None:
    result = testcase_bridge._do_prepare({"defect_id": "  "})
    assert result == {"success": False, "error": "defect_id is required"}


def test_handle_payload_propagates_defect_errors() -> None:
    def missing_defect(_defect_id: str):
        raise ValueError("defect 999 not found in local SQLite")

    import unittest.mock as mock

    with mock.patch.object(testcase_bridge, "_read_defect", missing_defect):
        # _handle_payload propagates; run_server is the layer that wraps errors as JSON lines.
        try:
            testcase_bridge._handle_payload({"action": "prepare", "defect_id": "999"})
            raised = False
        except ValueError as exc:
            raised = True
            assert "999 not found" in str(exc)
    assert raised is True


def test_do_verify_passes_content_through(monkeypatch) -> None:
    steps = "\n".join([
        "- [PreCon] vehicle ready",
        "- record pps CPU load in each drive mode",
        "- compare candidate against baseline build",
        "- flash the candidate software build",
        "- ? CPU load must NOT exceed 0.17%",
    ])
    description = "<html><body>Reference: defect D2804379</body></html>"
    result = testcase_bridge._do_verify({
        "defect_info": _defect(),
        "description_html": description,
        "steps_text": steps,
    })
    assert result["success"] is True
    assert result["verification"]["passed"] is True
    assert {c["name"] for c in result["verification"]["criteria"]} == {
        "failure_mode_coverage",
        "step_reproducibility",
        "format_compliance",
        "checkpoint_quantification",
        "defect_traceability",
    }


def test_do_verify_passes_test_model_through() -> None:
    test_model = {
        "dimensions": [{"name": "drive_mode", "aspect": "x", "classes": [{"id": "dm-1", "name": "IDLE-FAHREN"}]}],
        "combinations": [{"id": "TC-1", "classRefs": ["dm-1"], "priority": "high", "rationale": ""}],
    }
    steps = "\n".join([
        "- [PreCon] vehicle ready",
        "- record pps CPU load in each drive mode",
        "- compare candidate against baseline build",
        "- flash candidate software build",
        "- ? drive in IDLE-FAHREN mode, CPU load must NOT exceed 0.17%",
    ])
    result = testcase_bridge._do_verify({
        "defect_info": _defect(),
        "description_html": "<html><body>Reference: defect D2804379</body></html>",
        "steps_text": steps,
        "test_model": test_model,
        "combination_coverage": ["TC-1"],
    })
    assert result["success"] is True
    assert result["verification"]["passed"] is True
    model_criterion = next(c for c in result["verification"]["criteria"] if c["name"] == "model_coverage")
    assert model_criterion["passed"] is True

    # Without a model the criterion must not appear (single-stage contract).
    result_single = testcase_bridge._do_verify({
        "defect_info": _defect(),
        "description_html": "<html><body>Reference: defect D2804379</body></html>",
        "steps_text": steps,
    })
    assert all(c["name"] != "model_coverage" for c in result_single["verification"]["criteria"])
