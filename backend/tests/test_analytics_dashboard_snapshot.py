import pytest

from pathlib import Path

from backend.analytics.dashboard_snapshot import (
    activate_snapshot_version,
    get_summary_cache,
    normalize_summary_cache_key,
    record_snapshot_refresh,
    reset_summary_cache,
    read_active_snapshot_state,
)


def test_record_snapshot_refresh_and_activate_snapshot_version(tmp_path: Path):
    hot_db_path = tmp_path / "database" / "hot" / "vizion_serving.db"

    record_snapshot_refresh(
        hot_db_path,
        snapshot_version="snapshot-20260528-1",
        source_db_path="C:/data/qgate_raw.db",
        source_db_mtime="2026-05-28T00:00:00Z",
        refresh_status="ready",
        last_error=None,
    )
    activate_snapshot_version(hot_db_path, "snapshot-20260528-1")

    state = read_active_snapshot_state(hot_db_path)

    assert state["active_snapshot_version"] == "snapshot-20260528-1"
    assert state["refresh_status"] == "ready"
    assert state["source_db_path"] == "C:/data/qgate_raw.db"
    assert state["source_db_mtime"] == "2026-05-28T00:00:00Z"
    assert state["last_error"] is None
    assert state["last_success_at"]


def test_activate_snapshot_version_switches_active_pointer_without_rewriting_state(tmp_path: Path):
    hot_db_path = tmp_path / "database" / "hot" / "vizion_serving.db"

    record_snapshot_refresh(
        hot_db_path,
        snapshot_version="snapshot-a",
        source_db_path="C:/data/qgate_raw_a.db",
        source_db_mtime="2026-05-28T00:00:00Z",
        refresh_status="ready",
        last_error=None,
    )
    record_snapshot_refresh(
        hot_db_path,
        snapshot_version="snapshot-b",
        source_db_path="C:/data/qgate_raw_b.db",
        source_db_mtime="2026-05-29T00:00:00Z",
        refresh_status="ready",
        last_error=None,
    )

    activate_snapshot_version(hot_db_path, "snapshot-a")
    first_state = read_active_snapshot_state(hot_db_path)
    activate_snapshot_version(hot_db_path, "snapshot-b")
    second_state = read_active_snapshot_state(hot_db_path)

    assert first_state["active_snapshot_version"] == "snapshot-a"
    assert first_state["source_db_path"] == "C:/data/qgate_raw_a.db"
    assert second_state["active_snapshot_version"] == "snapshot-b"
    assert second_state["source_db_path"] == "C:/data/qgate_raw_b.db"
    assert second_state["source_db_mtime"] == "2026-05-29T00:00:00Z"


def test_read_active_snapshot_state_returns_missing_payload_without_active_version(tmp_path: Path):
    hot_db_path = tmp_path / "database" / "hot" / "vizion_serving.db"

    state = read_active_snapshot_state(hot_db_path)

    assert state == {
        "active_snapshot_version": "",
        "refresh_status": "missing",
    }


def test_record_failed_refresh_preserves_last_success_timestamp(tmp_path: Path):
    hot_db_path = tmp_path / "database" / "hot" / "vizion_serving.db"

    record_snapshot_refresh(
        hot_db_path,
        snapshot_version="snapshot-a",
        source_db_path="C:/data/qgate_raw_a.db",
        source_db_mtime="2026-05-28T00:00:00Z",
        refresh_status="ready",
        last_error=None,
    )
    activate_snapshot_version(hot_db_path, "snapshot-a")
    ready_state = read_active_snapshot_state(hot_db_path)

    record_snapshot_refresh(
        hot_db_path,
        snapshot_version="snapshot-a",
        source_db_path="C:/data/qgate_raw_a.db",
        source_db_mtime="2026-05-28T00:00:00Z",
        refresh_status="failed",
        last_error="network timeout",
    )
    failed_state = read_active_snapshot_state(hot_db_path)

    assert failed_state["refresh_status"] == "failed"
    assert failed_state["last_error"] == "network timeout"
    assert failed_state["last_success_at"] == ready_state["last_success_at"]


def test_activate_snapshot_version_requires_existing_snapshot_state(tmp_path: Path):
    hot_db_path = tmp_path / "database" / "hot" / "vizion_serving.db"

    with pytest.raises(ValueError, match="Unknown snapshot version"):
        activate_snapshot_version(hot_db_path, "missing-snapshot")


def test_summary_cache_normalizes_filter_order():
    reset_summary_cache()
    cache = get_summary_cache()
    key_a = normalize_summary_cache_key(
        snapshot_version="snapshot-1",
        filters={"years": ["2026"], "projects": ["IDCEVO", "MGU"]},
    )
    key_b = normalize_summary_cache_key(
        snapshot_version="snapshot-1",
        filters={"projects": ["MGU", "IDCEVO"], "years": ["2026"]},
    )

    cache[key_a] = {"overview": {"ticket_count": 1}}

    assert key_a == key_b
    assert cache[key_b]["overview"]["ticket_count"] == 1


def test_summary_cache_key_preserves_non_string_falsy_values():
    key_with_falsy_values = normalize_summary_cache_key(
        snapshot_version="snapshot-1",
        filters={"page": [0], "includeResolved": [False]},
    )
    key_without_values = normalize_summary_cache_key(
        snapshot_version="snapshot-1",
        filters={"page": [], "includeResolved": []},
    )

    assert key_with_falsy_values != key_without_values