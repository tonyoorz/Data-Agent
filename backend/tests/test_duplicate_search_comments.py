import importlib.util
import json
import sqlite3
import sys
from pathlib import Path
from unittest.mock import patch

import pandas as pd

from backend import duplicate_issue_finder


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from progressive_reranker import FeatureReRanker


def _load_duplicate_search_bridge_module():
    module_path = Path(__file__).resolve().parents[2] / "scripts" / "duplicate_search_bridge.py"
    spec = importlib.util.spec_from_file_location("duplicate_search_bridge_test_comments", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_build_from_df_uses_comments_in_default_text_fields():
    df = pd.DataFrame(
        [
            {
                "id": "1",
                "name": "Intermittent wake issue",
                "description": "Wake pipeline unstable after cold boot.",
                "comments": "Gateway wake CANoe trace timeout after KL15 on.",
                "status_phase": "03-In Analysis",
            },
            {
                "id": "2",
                "name": "Trace collection issue",
                "description": "CANoe trace timeout",
                "comments": "",
                "status_phase": "03-In Analysis",
            },
        ]
    )

    with patch("backend.duplicate_issue_finder._get_st_model", return_value=None):
        index = duplicate_issue_finder.DuplicateIssueIndex()
        index.build_from_df(df)

    candidates = index.search("Gateway wake CANoe trace timeout after KL15 on", top_k=2)

    assert candidates[0].ticket_id == "1"


def test_rows_from_octane_defects_flattens_comments_from_sqlite(tmp_path):
    bridge = _load_duplicate_search_bridge_module()
    db_path = tmp_path / "qgate_data.db"

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT,
                name TEXT,
                description TEXT,
                project TEXT,
                pu TEXT,
                software_version TEXT,
                status_phase TEXT,
                assigned_ecu TEXT,
                lead_model TEXT,
                detected_in_release TEXT,
                comments TEXT
            )
            """
        )
        conn.execute(
            """
            INSERT INTO octane_defects (
                defect_id,
                name,
                description,
                project,
                pu,
                software_version,
                status_phase,
                assigned_ecu,
                lead_model,
                detected_in_release,
                comments
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "1",
                "Wake issue",
                "General wake instability.",
                "IDCEVO",
                "27-07",
                "27-07",
                "03-In Analysis",
                "HU-H5",
                "G60",
                "EES27",
                json.dumps(
                    [
                        {"text": "<p>Gateway wake CANoe trace timeout after KL15 on.</p>"},
                        {"text": "Need more logs."},
                    ]
                ),
            ),
        )
        conn.commit()
    finally:
        conn.close()

    rows = bridge._rows_from_octane_defects(db_path)

    assert len(rows) == 1
    assert rows[0]["comments"].startswith("Gateway wake CANoe trace timeout after KL15 on.")
    assert "Need more logs." in rows[0]["comments"]
    assert "<p>" not in rows[0]["comments"]


def test_keyword_fallback_search_uses_comments_text(monkeypatch):
    df = pd.DataFrame(
        [
            {
                "id": "1",
                "name": "Issue A",
                "description": "",
                "comments": "Gateway wake CANoe trace timeout after KL15 on.",
                "status_phase": "03-In Analysis",
            },
            {
                "id": "2",
                "name": "Issue B",
                "description": "Completely unrelated description.",
                "comments": "",
                "status_phase": "03-In Analysis",
            },
        ]
    )

    monkeypatch.setattr(duplicate_issue_finder, "TfidfVectorizer", None)
    monkeypatch.setattr(duplicate_issue_finder, "sklearn_cosine_similarity", None)

    with patch("backend.duplicate_issue_finder._get_st_model", return_value=None):
        index = duplicate_issue_finder.DuplicateIssueIndex()
        index.build_from_df(df)

    candidates = index.search("Gateway wake CANoe trace timeout after KL15 on", top_k=2)

    assert candidates[0].ticket_id == "1"


def test_search_candidate_snippet_falls_back_to_comments_when_description_is_blank(monkeypatch):
    df = pd.DataFrame(
        [
            {
                "id": "1",
                "name": "Wake trace issue",
                "description": "",
                "comments": "Gateway wake CANoe trace timeout after KL15 on.",
                "status_phase": "03-In Analysis",
            }
        ]
    )

    with patch("backend.duplicate_issue_finder._get_st_model", return_value=None):
        index = duplicate_issue_finder.DuplicateIssueIndex()
        index.build_from_df(df)

    candidates = index.search("Gateway wake CANoe trace timeout after KL15 on", top_k=1)

    assert candidates[0].snippet.startswith("Gateway wake CANoe trace timeout after KL15 on.")


def test_feature_reranker_overlap_uses_comments_text():
    reranker = FeatureReRanker(feedback_store=None)

    feature_row = reranker.build_feature_row(
        query_text="Gateway wake CANoe trace timeout after KL15 on",
        meta={
            "name": "Issue A",
            "description": "",
            "comments": "Gateway wake CANoe trace timeout after KL15 on.",
            "project": "",
            "pu": "",
            "ecu": "",
            "lead_model": "",
        },
        base_similarity=0.5,
        popularity_stats=None,
        rank_pos=0,
    )

    assert feature_row[5] > 0.0