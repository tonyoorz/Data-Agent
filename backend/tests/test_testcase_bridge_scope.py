from __future__ import annotations

from backend.analytics import test_case_index
from scripts import testcase_bridge


def _defect() -> dict[str, str]:
    return {
        "defect_id": "D-7",
        "name": "Scoped defect",
        "project": "SP25",
        "problem_finder_team": "DTSV_China",
        "assigned_ecu": "HU",
    }


def test_prepare_denies_scope_before_rag_retrieval(monkeypatch) -> None:
    monkeypatch.setattr(testcase_bridge, "_read_defect", lambda _defect_id: _defect())

    def unexpected_retrieval(*_args, **_kwargs):
        raise AssertionError("RAG retrieval must not run for an unauthorized defect")

    monkeypatch.setattr(test_case_index, "retrieve_similar_test_cases", unexpected_retrieval)
    result = testcase_bridge._do_prepare({
        "defect_id": "D-7",
        "actor_scope": {"project_ids": ["OTHER"], "team_ids": ["DTSV_China"]},
    })

    assert result == {"success": False, "error": "TESTCASE_DEFECT_SCOPE_DENIED", "status_code": 403}


def test_prepare_allows_matching_project_and_team_scope(monkeypatch) -> None:
    monkeypatch.setattr(testcase_bridge, "_read_defect", lambda _defect_id: _defect())
    monkeypatch.setattr(test_case_index, "retrieve_similar_test_cases", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(test_case_index, "format_few_shot_examples", lambda *_args, **_kwargs: "")

    result = testcase_bridge._do_prepare({
        "defect_id": "D-7",
        "actor_scope": {"project_ids": ["SP25"], "team_ids": ["DTSV_China"]},
    })

    assert result["success"] is True
    assert result["defect_info"]["defect_id"] == "D-7"
