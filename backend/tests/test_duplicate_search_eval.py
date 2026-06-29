from __future__ import annotations

import json
from pathlib import Path

from backend.duplicate_search_eval import build_eval_cases_from_feedback, evaluate_duplicate_search, load_eval_cases


def test_evaluate_duplicate_search_reports_core_ranking_metrics() -> None:
    cases = [
        {
            "query": "bt phone disconnect after acp",
            "positive_ticket_ids": ["D-2"],
        },
        {
            "query": "camera black screen after boot",
            "positive_ticket_ids": ["D-9"],
        },
    ]

    def fake_search(query: str, top_k: int):
        assert top_k == 3
        if query.startswith("bt phone"):
            return ["D-1", "D-2", "D-3"]
        return ["D-4", "D-5", "D-6"]

    summary = evaluate_duplicate_search(cases, fake_search, top_k=3)

    assert summary["case_count"] == 2
    assert summary["top_k"] == 3
    assert summary["recall_at_k"] == 0.5
    assert summary["mrr_at_k"] == 0.25
    assert round(summary["ndcg_at_k"], 6) == round((1 / 1.584962500721156) / 2, 6)
    assert summary["cases"][0]["positive_rank"] == 2
    assert summary["cases"][1]["positive_rank"] is None


def test_load_eval_cases_normalizes_ticket_ids(tmp_path: Path) -> None:
    eval_path = tmp_path / "cases.json"
    eval_path.write_text(
        json.dumps(
            [
                {
                    "query": " wake trace timeout ",
                    "positive_ticket_ids": [" DP-101 ", ""],
                    "negative_ticket_ids": [" DP-999 "],
                }
            ]
        ),
        encoding="utf-8",
    )

    cases = load_eval_cases(eval_path)

    assert cases == [
        {
            "query": "wake trace timeout",
            "positive_ticket_ids": ["DP-101"],
            "negative_ticket_ids": ["DP-999"],
        }
    ]


def test_build_eval_cases_from_feedback_groups_positive_and_negative_signals() -> None:
    rows = [
        {"query_text": " wake trace timeout ", "ticket_id": "DP-101", "signal": "positive"},
        {"query_text": "wake trace timeout", "ticket_id": "DP-999", "signal": "negative"},
        {"query_text": "wake trace timeout", "ticket_id": "DP-102", "signal": "click"},
        {"query_text": "only negative", "ticket_id": "DP-404", "signal": "negative"},
    ]

    cases = build_eval_cases_from_feedback(rows)

    assert cases == [
        {
            "query": "wake trace timeout",
            "positive_ticket_ids": ["DP-101"],
            "negative_ticket_ids": ["DP-999"],
        }
    ]