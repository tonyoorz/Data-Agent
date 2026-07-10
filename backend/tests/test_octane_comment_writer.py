from __future__ import annotations

import sqlite3
from typing import Any

from backend import analytics_cli
from backend.analytics.duplicate_comment_runner import (
    DuplicateCommentRunStore,
    load_phase00_ticket_candidates,
    run_duplicate_comment_agent,
)
from backend.analytics.duplicate_comment_writer import build_compact_duplicate_comment_html
from backend.analytics.ingest.client import OctaneApiClient


class FakeResponse:
    def __init__(self, payload: dict[str, Any], status_code: int = 201) -> None:
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> dict[str, Any]:
        return self._payload


class FakeSession:
    def __init__(self) -> None:
        self.headers = {"Cookie": "JSESSIONID=session-1; XSRF_COOKIE=csrf-1"}
        self.post_calls: list[dict[str, Any]] = []

    def post(self, url: str, *, json: dict[str, Any], headers: dict[str, str], timeout: int, verify: bool) -> FakeResponse:
        self.post_calls.append(
            {
                "url": url,
                "json": json,
                "headers": headers,
                "timeout": timeout,
                "verify": verify,
            }
        )
        return FakeResponse({"data": [{"id": "C-1", "text": json["data"][0]["text"]}]})


class FakeOctaneClient:
    def __init__(self) -> None:
        self.created_comments: list[dict[str, str]] = []

    def fetch_work_item(self, work_item_id: str) -> dict[str, str]:
        return {"id": work_item_id, "name": "speech can not wakeup"}

    def create_comment_for_work_item(self, *, work_item_id: str, html_text: str) -> dict[str, Any]:
        self.created_comments.append({"work_item_id": work_item_id, "html_text": html_text})
        return {"id": "C-2", "author": {"full_name": "Tianhua Xie"}}


class FailingThenWorkingClient(FakeOctaneClient):
    def __init__(self, *, fail_on_create: bool) -> None:
        super().__init__()
        self.fail_on_create = fail_on_create

    def create_comment_for_work_item(self, *, work_item_id: str, html_text: str) -> dict[str, Any]:
        if self.fail_on_create:
            raise RuntimeError("401 Client Error: Unauthorized for url: https://octane.example/comments")
        return super().create_comment_for_work_item(work_item_id=work_item_id, html_text=html_text)


def test_create_comment_for_work_item_posts_with_octane_csrf_header() -> None:
    session = FakeSession()
    client = OctaneApiClient(
        base_url="https://octane.example",
        shared_space_id="1002",
        workspace_id="2001",
        session=session,  # type: ignore[arg-type]
    )

    result = client.create_comment_for_work_item(work_item_id="D-1", html_text="<html><body>hello</body></html>")

    assert result["id"] == "C-1"
    assert session.post_calls == [
        {
            "url": "https://octane.example/api/shared_spaces/1002/workspaces/2001/comments",
            "json": {
                "data": [
                    {
                        "type": "comment",
                        "text": "<html><body>hello</body></html>",
                        "owner_work_item": {"type": "work_item", "id": "D-1"},
                    }
                ]
            },
            "headers": {"XSRF-HEADER": "csrf-1"},
            "timeout": 60,
            "verify": False,
        }
    ]


def test_build_compact_duplicate_comment_html_keeps_score_inside_candidate_text() -> None:
    html = build_compact_duplicate_comment_html(
        ticket_id="2762063",
        ticket_name="speech can not wakeup",
        duplicate_result={
            "modelPhase": "click_boost",
            "dataset_size": 6315,
            "candidates": [
                {
                    "ticketId": "2754092",
                    "name": "Speech can not be wake up",
                    "score1to10": 6,
                    "snippet": "Closest wake-up wording.",
                }
            ],
        },
        marker="marker-1",
    )

    assert "recommendation · experimental early-ticket check" not in html
    assert "Experiment ID" not in html
    assert "Search ID" not in html
    assert "<strong>🤖 Agent</strong>" in html
    assert "Search context" in html
    assert "<strong>Analysis</strong>" in html
    assert "Most likely candidate: D2754092" in html
    assert "click_boost · 6,315 defects · top confidence 6/10 · top similarity 6/10" in html
    assert "Rank" not in html
    assert "<th" not in html
    assert "D2754092" in html
    assert "<strong>(review confidence 6/10; similarity 6/10)</strong>" in html
    assert "marker-1" in html


def test_build_compact_duplicate_comment_html_includes_agent_summary_text() -> None:
    html = build_compact_duplicate_comment_html(
        ticket_id="2762063",
        ticket_name="speech can not wakeup",
        duplicate_result={
            "modelPhase": "click_boost",
            "dataset_size": 6315,
            "summaryText": "最可能重复票: 2754092。唤醒语音失败现象接近，但还需要核对平台和日志。",
            "candidates": [
                {
                    "ticketId": "2754092",
                    "name": "Speech can not be wake up",
                    "score1to10": 6,
                    "snippet": "Closest wake-up wording.",
                }
            ],
        },
        marker="marker-1",
    )

    assert "<strong>Analysis</strong>" in html
    assert "最可能重复票: 2754092" in html
    assert "唤醒语音失败现象接近" in html


def test_build_compact_duplicate_comment_html_labels_candidate_comment_evidence_and_review_focus() -> None:
    html = build_compact_duplicate_comment_html(
        ticket_id="2762063",
        ticket_name="speech can not wakeup",
        duplicate_result={
            "modelPhase": "click_boost",
            "dataset_size": 6315,
            "candidates": [
                {
                    "ticketId": "2337201",
                    "name": "Speech did not work in any language",
                    "score1to10": 6,
                    "evidenceSnippets": ["VoiceAssistants App Version: BCA/Alexa log count = 0"],
                },
                {
                    "ticketId": "2588249",
                    "name": "Speech could not be set up in One LC",
                    "score1to10": 6,
                    "snippet": "Speech setup failure pattern.",
                },
            ],
        },
        marker="marker-1",
    )

    assert "D2337201" in html
    assert "Review focus: VoiceAssistants App Version" in html
    assert "D2588249" in html
    assert "Review focus: Speech setup failure pattern" in html


def test_build_compact_duplicate_comment_html_orders_by_confidence_and_shows_match_score() -> None:
    html = build_compact_duplicate_comment_html(
        ticket_id="2762063",
        ticket_name="speech can not wakeup",
        duplicate_result={
            "modelPhase": "click_boost",
            "dataset_size": 6315,
            "candidates": [
                {
                    "ticketId": "2337201",
                    "name": "Speech did not work in any language",
                    "score1to10": 6,
                    "confidenceScore1to10": 6,
                    "snippet": "dense-only top match",
                },
                {
                    "ticketId": "2754092",
                    "name": "Speech can not be wake up",
                    "score1to10": 6,
                    "confidenceScore1to10": 7,
                    "snippet": "sparse and evidence supported match",
                },
            ],
        },
        marker="marker-1",
    )

    assert html.index("D2754092") < html.index("D2337201")
    assert "review confidence 7/10; similarity 6/10" in html
    assert "review confidence 6/10; similarity 6/10" in html
    assert "top confidence 7/10 · top similarity 6/10" in html


def test_post_duplicate_search_comment_dry_run_and_apply(monkeypatch: Any) -> None:
    fake_client = FakeOctaneClient()

    monkeypatch.setattr(analytics_cli.ingest_client, "build_default_octane_client", lambda: fake_client)
    monkeypatch.setattr(
        analytics_cli,
        "_run_duplicate_search_bridge",
        lambda query_text, *, top_k, model="": {
            "success": True,
            "result": {
                "modelPhase": "click_boost",
                "dataset_size": 6315,
                "summaryText": "最可能重复票: 2754092。唤醒语音失败现象接近，需要核对平台和日志。",
                "candidates": [
                    {
                        "ticketId": "2754092",
                        "name": "Speech can not be wake up",
                        "score1to10": 6,
                        "confidenceScore1to10": 7,
                        "snippet": "Closest wake-up wording.",
                    }
                ],
            },
        },
    )

    dry_run = analytics_cli.post_duplicate_search_comment(ticket_id="2762063", apply=False, top_k=5)

    assert dry_run["ticket_name"] == "speech can not wakeup"
    assert dry_run["applied"] is False
    assert dry_run["top_confidence_score"] == 7
    assert dry_run["top_similarity_score"] == 6
    assert fake_client.created_comments == []
    assert "🤖 Agent" in str(dry_run["html_preview"])

    applied = analytics_cli.post_duplicate_search_comment(ticket_id="2762063", apply=True, top_k=5)

    assert applied["applied"] is True
    assert applied["created_comment_id"] == "C-2"
    assert fake_client.created_comments[0]["work_item_id"] == "2762063"
    assert "D2754092" in fake_client.created_comments[0]["html_text"]
    assert "最可能重复票: 2754092" in fake_client.created_comments[0]["html_text"]


def test_post_duplicate_search_comment_refreshes_cookie_once_after_401(monkeypatch: Any) -> None:
    clients = [FailingThenWorkingClient(fail_on_create=True), FailingThenWorkingClient(fail_on_create=False)]
    refresh_calls: list[dict[str, bool]] = []

    monkeypatch.setattr(analytics_cli.ingest_client, "build_default_octane_client", lambda: clients.pop(0))
    monkeypatch.setattr(
        analytics_cli,
        "refresh_octane_cookie",
        lambda headless=False: refresh_calls.append({"headless": headless}) or {"cookie_validated": True},
    )
    monkeypatch.setattr(
        analytics_cli,
        "_run_duplicate_search_bridge",
        lambda query_text, *, top_k, model="": {
            "success": True,
            "result": {
                "modelPhase": "click_boost",
                "dataset_size": 6315,
                "candidates": [{"ticketId": "2754092", "name": "Speech can not be wake up", "score1to10": 6}],
            },
        },
    )

    result = analytics_cli.post_duplicate_search_comment(
        ticket_id="2762063",
        ticket_name="speech can not wakeup",
        apply=True,
        auto_refresh_cookie_on_auth_failure=True,
        cookie_refresh_headless=True,
    )

    assert result["created_comment_id"] == "C-2"
    assert result["cookie_refreshed"] is True
    assert refresh_calls == [{"headless": True}]


def test_load_phase00_ticket_candidates_filters_team_and_phase(tmp_path: Any) -> None:
    source_db_path = tmp_path / "source.db"
    with sqlite3.connect(source_db_path) as conn:
        conn.execute(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                name TEXT,
                status_phase TEXT,
                phase TEXT,
                problem_finder_team TEXT,
                team TEXT,
                creation_time TEXT
            )
            """
        )
        conn.executemany(
            """
            INSERT INTO octane_defects(
                defect_id, name, status_phase, phase, problem_finder_team, team, creation_time
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [
                ("2762063", "speech can not wakeup", "00-Draft", "00-Draft", "DTSV_China", "DTSV_China", "2026-07-03"),
                ("D-NEW", "new phase", "01-New", "01-New", "DTSV_China", "DTSV_China", "2026-07-04"),
                ("D-OTHER", "other team", "00-Draft", "00-Draft", "OtherTeam", "OtherTeam", "2026-07-05"),
            ],
        )

    candidates = load_phase00_ticket_candidates(source_db_path, team_name="DTSV_China")

    assert [(item.ticket_id, item.name, item.phase, item.team) for item in candidates] == [
        ("2762063", "speech can not wakeup", "00-Draft", "DTSV_China")
    ]


def test_run_duplicate_comment_agent_skips_successful_tickets_and_records_apply(tmp_path: Any) -> None:
    source_db_path = tmp_path / "source.db"
    state_db_path = tmp_path / "state.db"
    with sqlite3.connect(source_db_path) as conn:
        conn.execute(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                name TEXT,
                status_phase TEXT,
                problem_finder_team TEXT,
                creation_time TEXT
            )
            """
        )
        conn.executemany(
            """
            INSERT INTO octane_defects(defect_id, name, status_phase, problem_finder_team, creation_time)
            VALUES (?, ?, ?, ?, ?)
            """,
            [
                ("D-DONE", "done ticket", "00-Draft", "DTSV_China", "2026-07-03"),
                ("D-TODO", "todo ticket", "00-Draft", "DTSV_China", "2026-07-04"),
            ],
        )
    store = DuplicateCommentRunStore(state_db_path)
    store.record_success(
        ticket_id="D-DONE",
        ticket_name="done ticket",
        phase="00-Draft",
        search_id="search-done",
        comment_id="comment-done",
    )
    posted: list[str] = []

    summary = run_duplicate_comment_agent(
        source_db_path=source_db_path,
        state_db_path=state_db_path,
        team_name="DTSV_China",
        ticket_ids=("D-DONE", "D-TODO"),
        apply=True,
        post_comment=lambda ticket_id, ticket_name, apply: posted.append(ticket_id) or {
            "ticket_id": ticket_id,
            "ticket_name": ticket_name,
            "model_phase": "click_boost",
            "created_comment_id": "comment-todo",
        },
    )

    assert posted == ["D-TODO"]
    assert summary["processed"] == 1
    assert summary["skipped_existing"] == 1
    assert DuplicateCommentRunStore(state_db_path).already_succeeded("D-TODO") is True


def test_run_duplicate_comment_agent_force_reposts_successful_ticket(tmp_path: Any) -> None:
    source_db_path = tmp_path / "source.db"
    state_db_path = tmp_path / "state.db"
    with sqlite3.connect(source_db_path) as conn:
        conn.execute(
            """
            CREATE TABLE octane_defects (
                defect_id TEXT PRIMARY KEY,
                name TEXT,
                status_phase TEXT,
                problem_finder_team TEXT,
                creation_time TEXT
            )
            """
        )
        conn.execute(
            """
            INSERT INTO octane_defects(defect_id, name, status_phase, problem_finder_team, creation_time)
            VALUES ('D-DONE', 'done ticket', '00-Draft', 'DTSV_China', '2026-07-03')
            """
        )
    store = DuplicateCommentRunStore(state_db_path)
    store.record_success(
        ticket_id="D-DONE",
        ticket_name="done ticket",
        phase="00-Draft",
        search_id="old-search",
        comment_id="old-comment",
    )
    posted: list[str] = []

    summary = run_duplicate_comment_agent(
        source_db_path=source_db_path,
        state_db_path=state_db_path,
        team_name="DTSV_China",
        ticket_ids=("D-DONE",),
        apply=True,
        force=True,
        post_comment=lambda ticket_id, ticket_name, apply: posted.append(ticket_id) or {
            "ticket_id": ticket_id,
            "ticket_name": ticket_name,
            "created_comment_id": "new-comment",
        },
    )

    assert posted == ["D-DONE"]
    assert summary["processed"] == 1
    assert summary["skipped_existing"] == 0
    with sqlite3.connect(state_db_path) as conn:
        comment_id = conn.execute(
            "SELECT comment_id FROM duplicate_agent_comment_runs WHERE ticket_id='D-DONE'"
        ).fetchone()[0]
    assert comment_id == "new-comment"


def test_cli_runner_requires_ticket_id_without_batch_flag() -> None:
    try:
        analytics_cli.main(["run-duplicate-comment-agent"])
    except SystemExit as exc:
        assert str(exc) == "--ticket-id is required unless --allow-batch is set"
    else:
        raise AssertionError("expected SystemExit")
