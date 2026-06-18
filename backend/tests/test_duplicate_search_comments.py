import importlib.util
import json
import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
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


def test_build_from_df_uses_search_comments_for_matching_and_persists_curated_metadata():
    df = pd.DataFrame(
        [
            {
                "id": "1",
                "name": "Intermittent wake issue",
                "description": "",
                "search_comments": "Gateway wake CANoe trace timeout after KL15 on because the first handshake is missed.",
                "evidence_snippets": [
                    "Gateway wake CANoe trace timeout after KL15 on because the first handshake is missed.",
                    "Need HU-H5 logs from the next reproduction attempt.",
                ],
                "comments": "Status changed from New to In Progress.",
                "status_phase": "03-In Analysis",
            },
            {
                "id": "2",
                "name": "Unrelated workflow ticket",
                "description": "",
                "search_comments": "",
                "evidence_snippets": [],
                "comments": "Assigned to John Doe.",
                "status_phase": "03-In Analysis",
            },
        ]
    )

    with patch("backend.duplicate_issue_finder._get_st_model", return_value=None):
        index = duplicate_issue_finder.DuplicateIssueIndex()
        index.build_from_df(df)

    candidates = index.search(
        "Gateway wake CANoe trace timeout after KL15 on because the first handshake is missed",
        top_k=2,
    )

    assert candidates[0].ticket_id == "1"
    assert index._meta[0]["search_comments"].startswith("Gateway wake CANoe trace timeout")
    assert index._meta[0]["evidence_snippets"] == [
        "Gateway wake CANoe trace timeout after KL15 on because the first handshake is missed.",
        "Need HU-H5 logs from the next reproduction attempt.",
    ]


def test_build_from_df_keeps_sparse_index_when_local_embeddings_are_available(monkeypatch):
    class FakeSentenceTransformer:
        def encode(self, texts, batch_size=64, show_progress_bar=False, normalize_embeddings=True):
            values = list(texts)
            vectors = []
            for text in values:
                lowered = str(text).lower()
                vectors.append(
                    np.asarray(
                        [1.0 if "wake" in lowered else 0.0, 1.0 if "trace" in lowered else 0.0],
                        dtype=np.float32,
                    )
                )
            return np.vstack(vectors)

    df = pd.DataFrame(
        [
            {
                "id": "1",
                "name": "Wake trace issue",
                "description": "Wake handshake trace missing.",
                "search_comments": "Wake trace shows the first handshake is missed.",
                "status_phase": "03-In Analysis",
            },
            {
                "id": "2",
                "name": "Unrelated audio issue",
                "description": "Audio route flaky.",
                "search_comments": "No wake trace signal.",
                "status_phase": "03-In Analysis",
            },
        ]
    )

    monkeypatch.setattr(duplicate_issue_finder, "_get_st_model", lambda: FakeSentenceTransformer())
    monkeypatch.setattr(duplicate_issue_finder, "_resolve_embedding_model_name", lambda: "test-local-hybrid-model")

    index = duplicate_issue_finder.DuplicateIssueIndex()
    index.build_from_df(df)

    assert index._use_embeddings is True
    assert index._embedding_backend == "local"
    assert index._vectorizer is not None
    assert index._matrix is not None


def test_build_from_df_uses_remote_embeddings_when_local_model_is_unavailable(monkeypatch):
    df = pd.DataFrame(
        [
            {
                "id": "1",
                "name": "Wake issue",
                "description": "Wake handshake missing after KL15 on.",
                "status_phase": "03-In Analysis",
            },
            {
                "id": "2",
                "name": "Audio issue",
                "description": "Audio route missing after reconnect.",
                "status_phase": "03-In Analysis",
            },
        ]
    )

    def fake_remote_encode(texts, model_name=None):
        vectors = []
        for text in texts:
            lowered = str(text).lower()
            vectors.append(
                np.asarray(
                    [1.0 if "wake" in lowered else 0.0, 1.0 if "audio" in lowered else 0.0],
                    dtype=np.float32,
                )
            )
        return np.vstack(vectors)

    monkeypatch.setattr(duplicate_issue_finder, "_get_st_model", lambda: None)
    monkeypatch.setattr(
        duplicate_issue_finder,
        "_get_remote_embedding_config",
        lambda: {
            "url": "https://example.invalid/embeddings",
            "authorization": "ACCESSCODE test",
            "model": "test-remote-hybrid-model",
            "timeout": 1.0,
        },
    )
    monkeypatch.setattr(duplicate_issue_finder, "_encode_remote_embeddings", fake_remote_encode)

    index = duplicate_issue_finder.DuplicateIssueIndex()
    index.build_from_df(df)
    candidates = index.search("wake handshake", top_k=1)

    assert index._use_embeddings is True
    assert index._embedding_backend == "remote"
    assert index._vectorizer is not None
    assert candidates[0].ticket_id == "1"


def test_rrf_fusion_combines_dense_and_sparse_rankings():
    index = duplicate_issue_finder.DuplicateIssueIndex()

    fused = index._fuse_ranked_lists_rrf(
        dense_ranked=[(0, 0.95), (1, 0.85), (2, 0.40)],
        sparse_ranked=[(2, 0.99), (1, 0.50), (3, 0.30)],
        top_k=4,
    )

    assert [idx for idx, _ in fused] == [2, 1, 0, 3]
    assert fused[0][1] == 0.99


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


def test_build_comment_views_prefers_analysis_text_and_drops_workflow_noise():
    bridge = _load_duplicate_search_bridge_module()

    views = bridge._build_comment_views(
        "\n".join(
            [
                "Status changed from New to In Progress.",
                "Root cause analysis: Gateway wake CANoe trace timeout after KL15 on because the session starts after bus sleep.",
                "Need HU-H5 logs from the next reproduction attempt.",
                "Assigned to John Doe.",
                "Fix candidate: retry the wake handshake before the first trace collection.",
            ]
        )
    )

    assert "Root cause analysis" in views["search_comments"]
    assert "Need HU-H5 logs" in views["search_comments"]
    assert "Fix candidate" in views["search_comments"]
    assert "Status changed" not in views["search_comments"]
    assert "Assigned to John Doe" not in views["search_comments"]
    assert len(views["evidence_snippets"]) == 2
    assert any("Root cause analysis" in snippet for snippet in views["evidence_snippets"])


def test_build_comment_views_keeps_analysis_from_mixed_workflow_segment():
    bridge = _load_duplicate_search_bridge_module()

    mixed_segment = (
        "Status changed from In Progress to In Analysis after root cause analysis "
        "showed the gateway misses the first wake handshake."
    )

    views = bridge._build_comment_views(mixed_segment)

    assert "root cause analysis" in views["search_comments"].lower()
    assert views["search_comments"] == mixed_segment
    assert views["evidence_snippets"] == [mixed_segment]


def test_build_comment_views_excludes_workflow_attachment_lines_with_evidence_tokens():
    bridge = _load_duplicate_search_bridge_module()

    workflow_segment = "Attachment added: timeout trace logs from the latest run."

    views = bridge._build_comment_views(workflow_segment)

    assert views["search_comments"] == ""
    assert views["evidence_snippets"] == []


def test_build_comment_views_caps_oversized_single_line_comment():
    bridge = _load_duplicate_search_bridge_module()

    oversized_segment = (
        "Root cause analysis: "
        + "gateway wake handshake timeout reproduced in CANoe trace. " * 20
    ).strip()

    views = bridge._build_comment_views(oversized_segment)

    assert len(views["search_comments"]) <= 700
    assert views["search_comments"].endswith("...")
    assert "Root cause analysis" in views["search_comments"]
    assert views["evidence_snippets"] == [bridge._truncate_comment_segment(oversized_segment)]


def test_rows_from_octane_defects_adds_search_comments_and_evidence_snippets(tmp_path):
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
                "2",
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
                        {"text": "Status changed from New to In Progress."},
                        {
                            "text": "Analysis: Gateway wake CANoe trace timeout after KL15 on when the gateway misses the first handshake.",
                        },
                        {"text": "Need more logs from the HU-H5 next run."},
                    ]
                ),
            ),
        )
        conn.commit()
    finally:
        conn.close()

    rows = bridge._rows_from_octane_defects(db_path)

    assert len(rows) == 1
    assert rows[0]["comments"].startswith("Status changed from New to In Progress.")
    assert "Analysis: Gateway wake CANoe trace timeout" in rows[0]["search_comments"]
    assert "Status changed from New to In Progress." not in rows[0]["search_comments"]
    assert rows[0]["evidence_snippets"] == [
        "Analysis: Gateway wake CANoe trace timeout after KL15 on when the gateway misses the first handshake.",
    ]


def test_rows_from_octane_defects_handles_legacy_schema_without_comments_column(tmp_path):
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
                detected_in_release TEXT
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
                detected_in_release
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "legacy-1",
                "Wake issue",
                "Legacy schema row without comments column.",
                "IDCEVO",
                "27-07",
                "27-07",
                "03-In Analysis",
                "HU-H5",
                "G60",
                "EES27",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    rows = bridge._rows_from_octane_defects(db_path)

    assert len(rows) == 1
    assert rows[0]["id"] == "legacy-1"
    assert rows[0]["comments"] == ""


def test_search_bridge_serializes_evidence_snippets_to_camel_case(monkeypatch):
    bridge = _load_duplicate_search_bridge_module()

    candidate = SimpleNamespace(
        score_1_10=8,
        similarity=0.87,
        ticket_id="DP-101",
        name="Wake trace issue",
        project="IDCEVO",
        pu="27-07",
        status_phase="03-In Analysis",
        snippet="Evidence: gateway misses the first wake handshake before trace collection.",
        evidence_snippets=[
            "Evidence: gateway misses the first wake handshake before trace collection.",
            "Need HU-H5 logs from the next reproduction attempt.",
        ],
    )

    class StubIndex:
        def search_with_metadata(self, query, hints, top_k, reranker, feedback_db_path):
            assert query == "Gateway wake CANoe trace timeout after KL15 on"
            assert hints == {"normalized": "gateway wake canoe trace timeout after kl15 on"}
            assert top_k == 3
            assert reranker == "stub-reranker"
            assert feedback_db_path == "feedback.db"
            return [candidate], {"model_phase": "progressive"}

    class StubFeedbackStore:
        def __init__(self, db_path):
            assert db_path == "feedback.db"

        def count_feedback(self):
            return 4

        @staticmethod
        def query_hash(value):
            assert value.startswith("dupsearch-agent:Gateway wake CANoe trace timeout after KL15 on:")
            return "search-123"

    monkeypatch.setattr(
        bridge,
        "_get_cached_defect_df",
        lambda repo_root: (pd.DataFrame([{"id": "DP-101"}]), "cache-key", True),
    )
    monkeypatch.setattr(
        bridge,
        "get_or_build_index_with_metadata",
        lambda cache_key, df: (
            StubIndex(),
            {"index_cache_hit": True, "index_rebuilt": False, "index_row_count": 1},
        ),
    )
    monkeypatch.setattr(
        bridge,
        "extract_hints",
        lambda query: {"normalized": query.lower()},
    )
    monkeypatch.setattr(bridge, "get_progressive_reranker", lambda db_path: "stub-reranker")
    monkeypatch.setattr(bridge, "FeedbackStore", StubFeedbackStore)

    result = bridge._search(
        {
            "query": "Gateway wake CANoe trace timeout after KL15 on",
            "top_k": 3,
            "feedback_db_path": "feedback.db",
        },
        Path("C:/repo"),
    )

    assert result["success"] is True
    assert result["result"]["queryText"] == "Gateway wake CANoe trace timeout after KL15 on"
    assert result["result"]["modelPhase"] == "progressive"
    assert result["result"]["feedbackCount"] == 4
    assert result["result"]["candidates"] == [
        {
            "score1to10": 8,
            "similarity": 0.87,
            "ticketId": "DP-101",
            "name": "Wake trace issue",
            "project": "IDCEVO",
            "pu": "27-07",
            "statusPhase": "03-In Analysis",
            "snippet": "Evidence: gateway misses the first wake handshake before trace collection.",
            "evidenceSnippets": [
                "Evidence: gateway misses the first wake handshake before trace collection.",
                "Need HU-H5 logs from the next reproduction attempt.",
            ],
        }
    ]


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


def test_keyword_fallback_search_uses_search_comments_text(monkeypatch):
    df = pd.DataFrame(
        [
            {
                "id": "1",
                "name": "Issue A",
                "description": "",
                "search_comments": "Gateway wake CANoe trace timeout after KL15 on.",
                "comments": "Status changed from New to In Progress.",
                "status_phase": "03-In Analysis",
            },
            {
                "id": "2",
                "name": "Issue B",
                "description": "Completely unrelated description.",
                "search_comments": "",
                "comments": "Gateway wake issue seen in CANoe.",
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
    assert candidates[0].similarity > candidates[1].similarity


def test_keyword_fallback_search_does_not_use_raw_comments_when_curated_search_comments_is_empty(monkeypatch):
    df = pd.DataFrame(
        [
            {
                "id": "1",
                "name": "Workflow-only ticket",
                "description": "",
                "search_comments": "",
                "comments": "Gateway wake CANoe trace timeout after KL15 on.",
                "status_phase": "03-In Analysis",
            },
            {
                "id": "2",
                "name": "Actual analysis ticket",
                "description": "Gateway wake CANoe trace timeout after KL15 on because the first handshake is missed.",
                "search_comments": "Gateway wake CANoe trace timeout after KL15 on because the first handshake is missed.",
                "comments": "Status changed from New to In Progress.",
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

    assert candidates[0].ticket_id == "2"
    assert candidates[0].similarity > candidates[1].similarity
    assert candidates[1].similarity == 0.0


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


def test_search_candidate_snippet_prefers_evidence_snippet_before_comments_when_description_is_blank():
    df = pd.DataFrame(
        [
            {
                "id": "1",
                "name": "Wake trace issue",
                "description": "",
                "search_comments": "Gateway wake CANoe trace timeout after KL15 on.",
                "evidence_snippets": [
                    "Evidence: gateway misses the first wake handshake before trace collection.",
                    "Need HU-H5 logs from the next reproduction attempt.",
                ],
                "comments": "Legacy raw comment that should not be the snippet.",
                "status_phase": "03-In Analysis",
            }
        ]
    )

    with patch("backend.duplicate_issue_finder._get_st_model", return_value=None):
        index = duplicate_issue_finder.DuplicateIssueIndex()
        index.build_from_df(df)

    candidates = index.search("Gateway wake CANoe trace timeout after KL15 on", top_k=1)

    assert candidates[0].snippet.startswith(
        "Evidence: gateway misses the first wake handshake before trace collection."
    )


def test_search_candidate_snippet_falls_back_to_search_comments_before_comments_when_description_is_blank():
    df = pd.DataFrame(
        [
            {
                "id": "1",
                "name": "Wake trace issue",
                "description": "",
                "search_comments": "Gateway wake CANoe trace timeout after KL15 on.",
                "evidence_snippets": [],
                "comments": "Legacy raw comment that should only be a compatibility fallback.",
                "status_phase": "03-In Analysis",
            }
        ]
    )

    with patch("backend.duplicate_issue_finder._get_st_model", return_value=None):
        index = duplicate_issue_finder.DuplicateIssueIndex()
        index.build_from_df(df)

    candidates = index.search("Gateway wake CANoe trace timeout after KL15 on", top_k=1)

    assert candidates[0].snippet.startswith("Gateway wake CANoe trace timeout after KL15 on.")


def test_feature_reranker_overlap_uses_search_comments_text():
    reranker = FeatureReRanker(feedback_store=None)

    feature_row = reranker.build_feature_row(
        query_text="Gateway wake CANoe trace timeout after KL15 on",
        meta={
            "name": "Issue A",
            "description": "",
            "search_comments": "Gateway wake CANoe trace timeout after KL15 on.",
            "comments": "Status changed from New to In Progress.",
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


def test_feature_reranker_overlap_does_not_fallback_to_raw_comments_when_curated_search_comments_is_empty():
    reranker = FeatureReRanker(feedback_store=None)

    feature_row = reranker.build_feature_row(
        query_text="Gateway wake CANoe trace timeout after KL15 on",
        meta={
            "name": "Issue A",
            "description": "",
            "search_comments": "",
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

    assert feature_row[5] == 0.0


def test_build_comment_views_evidence_snippets_exclude_next_step_only_segments():
    bridge = _load_duplicate_search_bridge_module()

    views = bridge._build_comment_views(
        "\n".join(
            [
                "Analysis: Gateway wake CANoe trace timeout after KL15 on when the first handshake is missed.",
                "Need HU-H5 logs from the next reproduction attempt.",
                "Please coordinate with the plant team for the next validation run.",
            ]
        )
    )

    assert views["evidence_snippets"] == [
        "Analysis: Gateway wake CANoe trace timeout after KL15 on when the first handshake is missed.",
    ]


def test_build_comment_views_evidence_snippets_keep_analysis_and_symptom_segments():
    bridge = _load_duplicate_search_bridge_module()

    views = bridge._build_comment_views(
        "\n".join(
            [
                "Analysis: Gateway wake CANoe trace timeout after KL15 on when the first handshake is missed.",
                "Need HU-H5 logs from the next reproduction attempt.",
                "Symptom reproduced twice with timeout and error in the trace after bus sleep.",
            ]
        )
    )

    assert views["evidence_snippets"] == [
        "Analysis: Gateway wake CANoe trace timeout after KL15 on when the first handshake is missed.",
        "Symptom reproduced twice with timeout and error in the trace after bus sleep.",
    ]


def test_build_comment_views_strips_supplier_prefix_and_inline_comment_markup():
    bridge = _load_duplicate_search_bridge_module()

    views = bridge._build_comment_views(
        "supplier comment: cc_jira Harish Ayajapuram: Joint Analysis from SystemFunctions with Lifecycle pov ([~prajwalakumarpartner]) [^Flash_Log_DLT.zip] Summary : service crash and coredumps observed crash_id: 1C88FBFC3E1F9A29"
    )

    assert views["search_comments"].startswith("Joint Analysis from SystemFunctions with Lifecycle pov")
    assert "supplier comment" not in views["search_comments"].lower()
    assert "[^" not in views["search_comments"]
    assert "[~" not in views["search_comments"]
    assert views["evidence_snippets"] == [
        "Joint Analysis from SystemFunctions with Lifecycle pov ( ) Summary : service crash and coredumps observed crash_id: 1C88FBFC3E1F9A29"
    ]


def test_build_comment_views_excludes_duplicate_reference_segments_from_search_and_evidence():
    bridge = _load_duplicate_search_bridge_module()

    views = bridge._build_comment_views(
        "\n".join(
            [
                "Problem statement: com.android.car service failure after STR.",
                "supplier comment: cc_jira Tanziya Neelufer: Stability DE-861 Round: Duplicates to IDCEVODEV-1002687 {code:java} timeout trace logs {code}",
            ]
        )
    )

    assert views["search_comments"] == "Problem statement: com.android.car service failure after STR."
    assert views["evidence_snippets"] == [
        "Problem statement: com.android.car service failure after STR.",
    ]


def test_build_comment_views_excludes_automated_attachment_segments_from_search_and_evidence():
    bridge = _load_duplicate_search_bridge_module()

    views = bridge._build_comment_views(
        "supplier comment: cc_jira Techuser APINEXT CI CD: #System performance graphics generator Added the following attachments via the automated performance analysis"
    )

    assert views["search_comments"] == ""
    assert views["evidence_snippets"] == []


def test_build_comment_views_excludes_automated_preanalysis_segments_from_search_and_evidence():
    bridge = _load_duplicate_search_bridge_module()

    views = bridge._build_comment_views(
        "supplier comment: cc_jira Techuser APINEXT CI CD: #bughunter_preanalysis #Performance pattern detection pre analysis This is part of Bughunter Automated Pattern Detection for Performance Domain"
    )

    assert views["search_comments"] == ""
    assert views["evidence_snippets"] == []


def test_build_comment_views_excludes_duplicate_next_step_segments_from_evidence_only():
    bridge = _load_duplicate_search_bridge_module()

    views = bridge._build_comment_views(
        "Performance front desk analysis: Next steps: Duplicate to IDCEVODEV-961113 GPU RESET and maxed out along with timeout errors."
    )

    assert "Performance front desk analysis" in views["search_comments"]
    assert views["evidence_snippets"] == []


def test_build_comment_views_splits_analysis_prelude_from_inline_log_blob():
    bridge = _load_duplicate_search_bridge_module()

    views = bridge._build_comment_views(
        "Joint Analysis from SystemFunctions with Lifecycle pov. Summary: service crash and coredumps observed crash_id: 1C88FBFC3E1F9A29. 1113192 2026/05/28 16:26:33.269000 1432.0204 193 IDCE LSMF UDS 917 log info verbose 1 Call job handler for request #936."
    )

    assert views["evidence_snippets"] == [
        "Joint Analysis from SystemFunctions with Lifecycle pov. Summary: service crash and coredumps observed crash_id: 1C88FBFC3E1F9A29."
    ]
    assert "1113192 2026/05/28 16:26:33.269000" in views["search_comments"]


def test_build_comment_views_limits_log_volume_in_search_comments_when_analysis_exists():
    bridge = _load_duplicate_search_bridge_module()

    views = bridge._build_comment_views(
        "\n".join(
            [
                "Summary: service crash and coredumps observed crash_id: 1C88FBFC3E1F9A29.",
                "1115235 2026/05/28 16:26:33.800000 1433.1406 105 IDCE SYS JOUR 1427 log error verbose 4 2026/05/28 14:24:59.197080 systemd[1]: pnr.service: Watchdog timeout (limit 30s)! Nsg is FullyOperational",
                "1114949 2026/05/28 16:26:33.711000 1432.9516 137 IDCE RECM RECO 1381 log info verbose 1 State changed for pnr.service: Active / Running -> Deactivating / Unknown",
                "1113192 2026/05/28 16:26:33.269000 1432.0204 193 IDCE LSMF UDS 917 log info verbose 1 Call job handler for request #936 with key [31,03,10,71] name 'statusRsuOpenFiletransferStatus' and more details beyond the search limit that should be cropped away when we keep only a compact log snippet",
            ]
        )
    )

    assert views["search_comments"].count("\n") == 1
    assert "Summary: service crash and coredumps observed crash_id: 1C88FBFC3E1F9A29." in views["search_comments"]
    assert "1115235 2026/05/28 16:26:33.800000" in views["search_comments"]
    assert "1114949 2026/05/28 16:26:33.711000" not in views["search_comments"]
    assert "1113192 2026/05/28 16:26:33.269000" not in views["search_comments"]


def test_build_comment_views_truncates_selected_log_segments_in_search_comments():
    bridge = _load_duplicate_search_bridge_module()

    views = bridge._build_comment_views(
        "Summary: gateway wake handshake timeout observed.\n"
        + "1113192 2026/05/28 16:26:33.269000 1432.0204 193 IDCE LSMF UDS 917 log info verbose 1 "
        + ("Call job handler for request #936 with extended diagnostic payload. " * 8)
    )

    search_segments = views["search_comments"].split("\n")
    assert len(search_segments) == 2
    assert search_segments[1].endswith("...")
    assert len(search_segments[1]) <= 220


def test_build_comment_views_excludes_admin_retry_and_ticket_quality_segments_from_search_comments():
    bridge = _load_duplicate_search_bridge_module()

    views = bridge._build_comment_views(
        "\n".join(
            [
                "Problem statement: com.android.car service failure after STR.",
                "#System performance graphics generator_retry No attachments added",
                "Issue has I-Step set but no OCTANE-ID -> I-Step deleted.",
                "Ticket Quality || Data || Available || Acceptance Criteria || | utc | 2026-05-27 09:03:00 | ★ | | ATS | ❌ | | | Video | ✅ |",
            ]
        )
    )

    assert views["search_comments"] == "Problem statement: com.android.car service failure after STR."
    assert views["evidence_snippets"] == [
        "Problem statement: com.android.car service failure after STR.",
    ]


def test_build_comment_views_splits_problem_statement_from_inline_log_blob():
    bridge = _load_duplicate_search_bridge_module()

    views = bridge._build_comment_views(
        "Hi, Problem statement: com.android.car service failure after STR. Resume at 18:40:47.588323 262659 2026/05/27 18:40:47.588323 405.2673 64 IDCA ACWD LCAT 0 log info verbose 1 carwatchdogd[251]:Received SUSPEND_EXIT power cycle"
    )

    assert views["evidence_snippets"] == [
        "Hi, Problem statement: com.android.car service failure after STR. Resume at 18:40:47.588323"
    ]
    assert "262659 2026/05/27 18:40:47.588323" in views["search_comments"]