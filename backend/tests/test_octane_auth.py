from __future__ import annotations

from pathlib import Path

from backend.analytics.config import (
    get_octane_base_url,
    get_octane_cookie_candidate_paths,
    get_octane_cookie_file_path,
    get_octane_login_file_path,
    resolve_octane_cookie_file_path,
    resolve_octane_login_file_path,
)
from backend.analytics.ingest.auth import build_cookie_session, load_cookie_header


def test_config_defaults_octane_auth_files_to_repo_root(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("VIZION_REPO_ROOT_OVERRIDE", str(tmp_path))

    assert get_octane_cookie_file_path() == tmp_path / "cookie.txt"
    assert get_octane_login_file_path() == tmp_path / "login_info.txt"
    assert get_octane_base_url() == "https://octane-prod.bmwgroup.net"


def test_build_cookie_session_sets_header_and_cookie_jar(tmp_path: Path) -> None:
    cookie_file = tmp_path / "cookie.txt"
    cookie_file.write_text("A=1; B=2", encoding="utf-8")

    session = build_cookie_session(cookie_file)

    assert load_cookie_header(cookie_file) == "A=1; B=2"
    assert session.headers["Cookie"] == "A=1; B=2"
    assert session.cookies.get("A") == "1"
    assert session.cookies.get("B") == "2"


def test_resolve_octane_auth_files_fall_back_to_legacy_repo(monkeypatch, tmp_path: Path) -> None:
    workspace_root = tmp_path / "vizion-lab"
    workspace_root.mkdir(parents=True)
    legacy_root = tmp_path / "TPMDashbaord"
    legacy_root.mkdir(parents=True)
    (legacy_root / "cookie.txt").write_text("LEGACY_COOKIE=1", encoding="utf-8")
    (legacy_root / "login_info.txt").write_text('{"username": "q1", "password": "pw"}', encoding="utf-8")

    monkeypatch.setenv("VIZION_REPO_ROOT_OVERRIDE", str(workspace_root))

    assert get_octane_cookie_file_path() == workspace_root / "cookie.txt"
    assert get_octane_login_file_path() == workspace_root / "login_info.txt"
    assert get_octane_cookie_candidate_paths()[0] == workspace_root / "cookie.txt"
    assert resolve_octane_cookie_file_path() == legacy_root / "cookie.txt"
    assert resolve_octane_login_file_path() == legacy_root / "login_info.txt"