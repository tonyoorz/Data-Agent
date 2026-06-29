import importlib.util
from pathlib import Path

import pandas as pd

from backend import duplicate_issue_finder


def _load_duplicate_search_bridge_module():
    module_path = Path(__file__).resolve().parents[2] / "scripts" / "duplicate_search_bridge.py"
    spec = importlib.util.spec_from_file_location("duplicate_search_bridge_test", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_index_cache_hit_does_not_rebuild_when_filtered_row_count_changes():
    duplicate_issue_finder._INDEX_CACHE.clear()

    df = pd.DataFrame(
        [
            {
                "id": "1",
                "name": "kept row",
                "description": "kept row description",
                "project": "IDCEVO",
                "pu": "27-07",
                "status_phase": "03-In Analysis_Medium",
            },
            {
                "id": "2",
                "name": "filtered row",
                "description": "filtered row description",
                "project": "IDCEVO",
                "pu": "27-07",
                "status_phase": "09-Closed",
            },
        ]
    )

    first_index, first_metadata = duplicate_issue_finder.get_or_build_index_with_metadata(
        cache_key="same-key",
        df=df,
    )
    second_index, second_metadata = duplicate_issue_finder.get_or_build_index_with_metadata(
        cache_key="same-key",
        df=df,
    )

    assert first_metadata["index_rebuilt"] is True
    assert first_index.ready is True
    assert second_index is first_index
    assert second_metadata["index_cache_hit"] is True
    assert second_metadata["index_rebuilt"] is False


def test_disk_snapshot_reuses_built_index_after_memory_cache_is_cleared(monkeypatch, tmp_path):
    duplicate_issue_finder._INDEX_CACHE.clear()
    monkeypatch.setattr(duplicate_issue_finder, "_INDEX_SNAPSHOT_DIR", str(tmp_path / "snapshots"))

    df = pd.DataFrame(
        [
            {
                "id": "1",
                "name": "kept row",
                "description": "kept row description",
                "project": "IDCEVO",
                "pu": "27-07",
                "status_phase": "03-In Analysis_Medium",
            }
        ]
    )

    first_index, first_metadata = duplicate_issue_finder.get_or_build_index_with_metadata(
        cache_key="snapshot-key",
        df=df,
    )

    assert first_index.ready is True
    assert first_metadata["index_rebuilt"] is True
    assert first_metadata["index_disk_cache_hit"] is False

    duplicate_issue_finder._INDEX_CACHE.clear()

    def fail_build_from_df(self, _df):
        raise AssertionError("build_from_df should not be called when a disk snapshot is available")

    monkeypatch.setattr(duplicate_issue_finder.DuplicateIssueIndex, "build_from_df", fail_build_from_df)

    second_index, second_metadata = duplicate_issue_finder.get_or_build_index_with_metadata(
        cache_key="snapshot-key",
        df=df,
    )

    assert second_index.ready is True
    assert second_metadata["index_cache_hit"] is False
    assert second_metadata["index_disk_cache_hit"] is True
    assert second_metadata["index_rebuilt"] is True


def test_search_reuses_loaded_defect_df_when_source_is_unchanged(monkeypatch, tmp_path):
    bridge = _load_duplicate_search_bridge_module()

    load_calls = []
    df = pd.DataFrame(
        [
            {
                "id": "1",
                "name": "carplay cannot connect",
                "description": "carplay cannot connect after boot",
                "project": "IDCEVO",
                "pu": "27-07",
                "status_phase": "03-In Analysis_Medium",
            }
        ]
    )

    class FakeIndex:
        ready = True

        def search_with_metadata(self, query, hints=None, top_k=10, reranker=None, feedback_db_path=None):
            return [], {"model_phase": "baseline"}

    class FakeFeedbackStore:
        def __init__(self, db_path=None):
            self.db_path = db_path

        @staticmethod
        def query_hash(value):
            return value

        def count_feedback(self):
            return 0

    def fake_build_defect_df(repo_root):
        load_calls.append(str(repo_root))
        return df.copy()

    monkeypatch.setattr(bridge, "_build_defect_df", fake_build_defect_df)
    monkeypatch.setattr(bridge, "_build_cache_key", lambda repo_root, loaded_df: "stable-key")
    monkeypatch.setattr(
        bridge,
        "get_or_build_index_with_metadata",
        lambda cache_key, df, **kwargs: (FakeIndex(), {"index_cache_hit": True, "index_rebuilt": False, "index_row_count": len(df)}),
    )
    monkeypatch.setattr(bridge, "extract_hints", lambda query: object())
    monkeypatch.setattr(bridge, "get_progressive_reranker", lambda db_path=None: object())
    monkeypatch.setattr(bridge, "FeedbackStore", FakeFeedbackStore)
    monkeypatch.setattr(bridge, "BACKEND_ROOT", tmp_path)

    first = bridge._search({"query": "carplay can not connect", "top_k": 5}, tmp_path)
    second = bridge._search({"query": "carplay can not connect", "top_k": 5}, tmp_path)

    assert first["success"] is True
    assert second["success"] is True
    assert load_calls == [str(tmp_path)]
    assert second["result"]["timings"]["index_cache_hit"] is True


def test_search_uses_prepared_index_manifest_without_loading_defect_df(monkeypatch, tmp_path):
    bridge = _load_duplicate_search_bridge_module()
    repo_root = tmp_path / "repo"
    source_db = repo_root / "database" / "source" / "qgate_raw.db"
    source_db.parent.mkdir(parents=True, exist_ok=True)
    source_db.write_text("source", encoding="utf-8")

    manifest_path = tmp_path / "duplicate_search_manifest.json"
    source_signature = f"sqlite:{source_db.resolve()}:{source_db.stat().st_size}:{source_db.stat().st_mtime_ns}"
    manifest_path.write_text(
        """
        {
          "source_signature": "%s",
          "cache_key": "prepared-key",
          "dataset_size": 42
        }
        """ % source_signature.replace("\\", "\\\\"),
        encoding="utf-8",
    )

    class FakeIndex:
        ready = True

        def search_with_metadata(self, query, hints=None, top_k=10, reranker=None, feedback_db_path=None):
            return [], {"model_phase": "baseline"}

    class FakeFeedbackStore:
        def __init__(self, db_path=None):
            self.db_path = db_path

        @staticmethod
        def query_hash(value):
            return value

        def count_feedback(self):
            return 0

    def fail_build_defect_df(_repo_root):
        raise AssertionError("prepared manifest search should not load the defect DataFrame")

    def fake_get_or_build_index_with_metadata(cache_key, df, build_if_missing=True):
        assert cache_key == "prepared-key"
        assert df.empty
        assert build_if_missing is False
        return FakeIndex(), {
            "index_cache_hit": False,
            "index_disk_cache_hit": True,
            "index_rebuilt": True,
            "index_row_count": 42,
        }

    monkeypatch.setattr(bridge, "REPO_ROOT", repo_root)
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(repo_root / "database"))
    monkeypatch.delenv("DUPSEARCH_SQLITE_PATH", raising=False)
    monkeypatch.delenv("VIZION_FULL_PICTURE_SOURCE_DB_PATH", raising=False)
    monkeypatch.setattr(bridge, "_prepared_index_manifest_path", lambda: manifest_path)
    monkeypatch.setattr(bridge, "_build_defect_df", fail_build_defect_df)
    monkeypatch.setattr(bridge, "get_or_build_index_with_metadata", fake_get_or_build_index_with_metadata)
    monkeypatch.setattr(bridge, "extract_hints", lambda query: object())
    monkeypatch.setattr(bridge, "get_progressive_reranker", lambda db_path=None: object())
    monkeypatch.setattr(bridge, "FeedbackStore", FakeFeedbackStore)
    monkeypatch.setattr(bridge, "BACKEND_ROOT", tmp_path)

    result = bridge._search({"query": "carplay can not connect", "top_k": 5}, repo_root)

    assert result["success"] is True
    assert result["result"]["dataset_size"] == 42
    assert result["result"]["timings"]["prepared_index_manifest_hit"] is True
    assert result["result"]["timings"]["load_defect_df_cache_hit"] is True


def test_resolve_sqlite_path_prefers_local_source_copy(monkeypatch, tmp_path):
    bridge = _load_duplicate_search_bridge_module()
    local_repo_root = tmp_path / "repo"
    local_source_db = local_repo_root / "database" / "source" / "qgate_raw.db"

    local_source_db.parent.mkdir(parents=True, exist_ok=True)
    local_source_db.touch()

    monkeypatch.delenv("DUPSEARCH_SQLITE_PATH", raising=False)
    monkeypatch.delenv("VIZION_FULL_PICTURE_SOURCE_DB_PATH", raising=False)
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(local_repo_root / "database"))
    monkeypatch.setattr(bridge, "REPO_ROOT", local_repo_root)

    resolved = bridge._resolve_sqlite_path()

    assert resolved == local_source_db


def test_resolve_sqlite_path_does_not_fallback_to_sibling_repo(monkeypatch, tmp_path):
    bridge = _load_duplicate_search_bridge_module()
    local_repo_root = tmp_path / "repo"
    sibling_source_db = tmp_path / "TPMDashbaord" / "qgate" / "qgate_data.db"

    sibling_source_db.parent.mkdir(parents=True, exist_ok=True)
    sibling_source_db.touch()

    monkeypatch.delenv("DUPSEARCH_SQLITE_PATH", raising=False)
    monkeypatch.delenv("VIZION_FULL_PICTURE_SOURCE_DB_PATH", raising=False)
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(local_repo_root / "database"))
    monkeypatch.setattr(bridge, "REPO_ROOT", local_repo_root)

    resolved = bridge._resolve_sqlite_path()

    assert resolved is None


def test_resolve_sqlite_path_respects_explicit_dupsearch_override(monkeypatch, tmp_path):
    bridge = _load_duplicate_search_bridge_module()
    configured_sqlite = tmp_path / "custom" / "custom_qgate.db"
    configured_sqlite.parent.mkdir(parents=True, exist_ok=True)
    configured_sqlite.touch()

    monkeypatch.setenv("DUPSEARCH_SQLITE_PATH", str(configured_sqlite))
    monkeypatch.setenv("VIZION_DATABASE_ROOT", str(tmp_path / "database"))

    resolved = bridge._resolve_sqlite_path()

    assert resolved == configured_sqlite


def test_duplicate_search_bridge_configures_utf8_stdio_for_windows_cli(monkeypatch):
    bridge = _load_duplicate_search_bridge_module()
    calls = []

    class FakeStream:
        def __init__(self, name):
            self.name = name

        def reconfigure(self, **kwargs):
            calls.append((self.name, kwargs))

    monkeypatch.setattr(bridge.sys, "stdout", FakeStream("stdout"))
    monkeypatch.setattr(bridge.sys, "stderr", FakeStream("stderr"))

    bridge._configure_utf8_stdio()

    assert calls == [
        ("stdout", {"encoding": "utf-8", "errors": "replace"}),
        ("stderr", {"encoding": "utf-8", "errors": "replace"}),
    ]