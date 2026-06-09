from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import importlib
import json
import sqlite3
import shutil
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType

from backend.analytics.config import (
    get_full_picture_source_db_path,
    get_octane_base_url,
    get_octane_cookie_candidate_paths,
    get_octane_cookie_file_path,
    get_octane_login_candidate_paths,
    get_octane_login_file_path,
)


INCREMENTAL_DEFECT_OVERLAP_DAYS = 3
COMMENT_SYNC_TABLE = "octane_defect_comment_refresh_state"
SQLITE_IN_CLAUSE_BATCH_SIZE = 900


def _legacy_repo_candidates() -> tuple[Path, ...]:
    repo_root = Path(__file__).resolve().parents[2]
    return (
        repo_root.parent / "TPMDashbaord",
        repo_root.parent / "TPMDashboard",
    )


def resolve_legacy_repo_root() -> Path:
    for candidate in _legacy_repo_candidates():
        if candidate.exists() and candidate.is_dir():
            return candidate
    raise FileNotFoundError("Legacy TPMDashboard repository not found next to the current workspace")


@contextmanager
def _legacy_environment(legacy_root: Path):
    root_str = str(legacy_root)
    inserted = False
    if root_str not in sys.path:
        sys.path.insert(0, root_str)
        inserted = True

    overrides = {
        "octane_db": importlib.import_module("backend.analytics.legacy_octane_db"),
        "data_processor": importlib.import_module("backend.analytics.legacy_data_processor_stub"),
        "backfill_qgate_history_events": importlib.import_module("backend.analytics.legacy_backfill_qgate_history_events"),
    }
    original_modules: dict[str, ModuleType | None] = {}
    removed_modules: dict[str, ModuleType] = {}
    for module_name in (
        "downloaderqgate",
        "download",
        "download.octane_downloader",
        "download.testcase_downloader",
    ):
        existing = sys.modules.pop(module_name, None)
        if existing is not None:
            removed_modules[module_name] = existing

    try:
        for module_name, module in overrides.items():
            original_modules[module_name] = sys.modules.get(module_name)
            sys.modules[module_name] = module
        yield
    finally:
        for module_name in overrides:
            original = original_modules[module_name]
            if original is None:
                sys.modules.pop(module_name, None)
            else:
                sys.modules[module_name] = original
        for module_name, module in removed_modules.items():
            sys.modules[module_name] = module
        if inserted:
            try:
                sys.path.remove(root_str)
            except ValueError:
                pass


def _first_existing_legacy_candidate(paths: tuple[Path, ...], current_path: Path) -> Path | None:
    for path in paths:
        if path == current_path:
            continue
        if path.exists():
            return path
    return None


def _copy_if_needed(source: Path, target: Path) -> bool:
    if not source.exists() or source.resolve() == target.resolve():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.read_text(encoding="utf-8") == source.read_text(encoding="utf-8"):
        return False
    shutil.copy2(source, target)
    return True


def sync_octane_auth_from_legacy(*, sync_login: bool) -> dict[str, object]:
    current_cookie = get_octane_cookie_file_path()
    legacy_cookie = _first_existing_legacy_candidate(get_octane_cookie_candidate_paths(), current_cookie)
    cookie_synced = _copy_if_needed(legacy_cookie, current_cookie) if legacy_cookie is not None else False

    current_login = get_octane_login_file_path()
    legacy_login = _first_existing_legacy_candidate(get_octane_login_candidate_paths(), current_login)
    login_synced = _copy_if_needed(legacy_login, current_login) if sync_login and legacy_login is not None else False

    return {
        "cookie_synced": cookie_synced,
        "login_synced": login_synced,
        "cookie_source": str(legacy_cookie) if legacy_cookie is not None else None,
        "cookie_target": str(current_cookie),
        "login_source": str(legacy_login) if legacy_login is not None else None,
        "login_target": str(current_login),
    }


def _default_cookie_file() -> Path:
    current_cookie = get_octane_cookie_file_path()
    if current_cookie.exists():
        return current_cookie
    sync_octane_auth_from_legacy(sync_login=False)
    if current_cookie.exists():
        return current_cookie
    legacy_cookie = _first_existing_legacy_candidate(get_octane_cookie_candidate_paths(), current_cookie)
    return legacy_cookie if legacy_cookie is not None else current_cookie


def refresh_octane_cookie(*, prefer_legacy: bool, sync_login: bool, headless: bool) -> dict[str, object]:
    if prefer_legacy:
        try:
            return _refresh_octane_cookie_via_legacy(sync_login=sync_login, headless=headless)
        except FileNotFoundError:
            pass
    return _refresh_octane_cookie_locally(sync_login=sync_login, headless=headless)


def _legacy_playwright_supports_headless(script_path: Path) -> bool:
    try:
        script_text = script_path.read_text(encoding="utf-8")
    except OSError:
        return True

    return "--headless" in script_text


def _refresh_octane_cookie_via_legacy(*, sync_login: bool, headless: bool) -> dict[str, object]:
    legacy_root = resolve_legacy_repo_root()
    script_path = legacy_root / "playwright_cookie_manager.py"
    argv = [sys.executable, str(script_path), "--refresh"]
    if headless and _legacy_playwright_supports_headless(script_path):
        argv.append("--headless")
    result = subprocess.run(
        argv,
        cwd=legacy_root,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Legacy Playwright cookie refresh failed with exit code {result.returncode}")
    sync_summary = sync_octane_auth_from_legacy(sync_login=sync_login)
    return {
        "cookie_refreshed": True,
        "mode": "legacy-playwright",
        "headless_requested": bool(headless),
        **sync_summary,
    }


def _refresh_octane_cookie_locally(*, sync_login: bool, headless: bool) -> dict[str, object]:
    from backend.analytics.ingest.playwright_cookie_manager import refresh_cookie_file

    cookie_file = get_octane_cookie_file_path()
    refresh_cookie_file(
        base_url=get_octane_base_url(),
        cookie_file=cookie_file,
        headless=headless,
    )
    sync_summary = sync_octane_auth_from_legacy(sync_login=sync_login)
    return {
        "cookie_refreshed": True,
        "mode": "local-playwright",
        "cookie_file": str(cookie_file),
        **sync_summary,
    }


def run_legacy_qgate_source(
    *,
    teams: tuple[str, ...],
    years: tuple[int, ...],
    include_history: bool,
    include_comments: bool,
    save_files: bool,
    cookie_file: str | None,
) -> dict[str, object]:
    legacy_root = resolve_legacy_repo_root()
    target_db_path = get_full_picture_source_db_path()
    effective_cookie_file = Path(cookie_file) if cookie_file else _default_cookie_file()
    argv = [
        "--auth-method",
        "cookie",
        "--cookie-file",
        str(effective_cookie_file),
        "--teams",
        ",".join(teams),
        "--defect-years",
        ",".join(str(year) for year in years),
        "--save-db",
        "--qgate-db-path",
        str(target_db_path),
        "--sync-history-events",
    ]
    if not include_history:
        argv.append("--skip-history")
    if not include_comments:
        argv.append("--skip-comments")
    if not save_files:
        argv.append("--skip-file-output")

    with _legacy_environment(legacy_root):
        module = importlib.import_module("downloaderqgate")
        module.main(argv)

    return {
        "bridge": "qgate",
        "source_db_path": str(target_db_path),
        "teams": list(teams),
        "years": list(years),
        "include_history": include_history,
        "include_comments": include_comments,
        "save_files": save_files,
        "cookie_file": str(effective_cookie_file),
    }


def _parse_iso_datetime(value: object) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _load_incremental_defect_windows_by_team_year(
    *,
    source_db_path: Path,
    teams: tuple[str, ...],
    years: tuple[int, ...],
    overlap_days: int = INCREMENTAL_DEFECT_OVERLAP_DAYS,
    today: date | datetime | None = None,
) -> dict[tuple[str, int], dict[str, str]]:
    normalized_today = today.date() if isinstance(today, datetime) else (today or datetime.now(timezone.utc).date())
    end_date = normalized_today.isoformat()
    watermarks: dict[tuple[str, int], datetime] = {}

    if source_db_path.exists() and teams and years:
        placeholders_teams = ", ".join("?" for _ in teams)
        placeholders_years = ", ".join("?" for _ in years)
        query = f"""
            SELECT
                CAST(problem_finder_team AS TEXT) AS team,
                CAST(year AS INTEGER) AS defect_year,
                MAX(COALESCE(NULLIF(TRIM(CAST(last_modified AS TEXT)), ''), NULLIF(TRIM(CAST(fetched_at AS TEXT)), ''))) AS watermark
            FROM octane_defects
            WHERE CAST(problem_finder_team AS TEXT) IN ({placeholders_teams})
              AND CAST(year AS INTEGER) IN ({placeholders_years})
            GROUP BY CAST(problem_finder_team AS TEXT), CAST(year AS INTEGER)
        """
        conn = sqlite3.connect(str(source_db_path))
        try:
            rows = conn.execute(query, [*teams, *years]).fetchall()
        except sqlite3.Error:
            rows = []
        finally:
            conn.close()

        for team_name, defect_year, watermark in rows:
            parsed = _parse_iso_datetime(watermark)
            if parsed is not None:
                watermarks[(str(team_name or "").strip(), int(defect_year))] = parsed

    windows: dict[tuple[str, int], dict[str, str]] = {}
    for team in teams:
        for year in years:
            watermark = watermarks.get((team, year))
            if watermark is None:
                windows[(team, year)] = {
                    "start_date": f"{year}-01-01",
                    "end_date": end_date,
                    "mode": "full",
                }
                continue
            start_date = (watermark.date() - timedelta(days=max(0, int(overlap_days)))).isoformat()
            windows[(team, year)] = {
                "start_date": start_date,
                "end_date": end_date,
                "mode": "incremental",
            }
    return windows


def _build_incremental_defect_query(*, team_id: str, year: int, start_date: str, end_date: str) -> str:
    return (
        f'"(problem_finder_team_udf={{id=\'{team_id}\'}};'
        f"creation_time>='{year}-01-01T00:00:00Z';"
        f"creation_time<='{year}-12-31T23:59:59Z';"
        f"last_modified>='{start_date}T00:00:00Z';"
        f"last_modified<='{end_date}T23:59:59Z')\""
    )


def _iter_batched(values: list[str], size: int = SQLITE_IN_CLAUSE_BATCH_SIZE):
    for index in range(0, len(values), max(1, int(size))):
        yield values[index:index + max(1, int(size))]


def _ensure_comment_sync_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {COMMENT_SYNC_TABLE} (
            defect_id TEXT PRIMARY KEY,
            last_defect_modified TEXT NOT NULL,
            last_synced_at TEXT NOT NULL
        )
        """
    )


def _load_comment_sync_watermarks(*, source_db_path: Path, defect_ids: list[str]) -> dict[str, datetime]:
    normalized_ids = [str(value or "").strip() for value in defect_ids if str(value or "").strip()]
    if not normalized_ids or not source_db_path.exists():
        return {}

    watermarks: dict[str, datetime] = {}
    conn = sqlite3.connect(str(source_db_path))
    try:
        _ensure_comment_sync_table(conn)
        for batch in _iter_batched(normalized_ids):
            placeholders = ", ".join("?" for _ in batch)
            rows = conn.execute(
                f"""
                SELECT defect_id, last_defect_modified
                FROM {COMMENT_SYNC_TABLE}
                WHERE defect_id IN ({placeholders})
                """,
                batch,
            ).fetchall()
            for defect_id, watermark in rows:
                parsed = _parse_iso_datetime(watermark)
                if parsed is not None:
                    watermarks[str(defect_id or "").strip()] = parsed
    except sqlite3.Error:
        return {}
    finally:
        conn.close()

    return watermarks


def _load_existing_comments_by_defect_id(*, source_db_path: Path, defect_ids: list[str]) -> dict[str, list[dict[str, object]]]:
    normalized_ids = [str(value or "").strip() for value in defect_ids if str(value or "").strip()]
    if not normalized_ids or not source_db_path.exists():
        return {}

    comments_by_defect: dict[str, list[dict[str, object]]] = {}
    conn = sqlite3.connect(str(source_db_path))
    try:
        for batch in _iter_batched(normalized_ids):
            placeholders = ", ".join("?" for _ in batch)
            rows = conn.execute(
                f"""
                SELECT defect_id, comments
                FROM octane_defects
                WHERE defect_id IN ({placeholders})
                """,
                batch,
            ).fetchall()
            for defect_id, raw_comments in rows:
                normalized_id = str(defect_id or "").strip()
                if not normalized_id:
                    continue
                parsed_comments: list[dict[str, object]] = []
                text_value = str(raw_comments or "").strip()
                if text_value:
                    try:
                        loaded = json.loads(text_value)
                    except json.JSONDecodeError:
                        loaded = []
                    if isinstance(loaded, list):
                        parsed_comments = [item for item in loaded if isinstance(item, dict)]
                comments_by_defect[normalized_id] = parsed_comments
    except sqlite3.Error:
        return {}
    finally:
        conn.close()

    return comments_by_defect


def _hydrate_existing_comments_for_defects(*, source_db_path: Path, defects: list[dict[str, object]]) -> None:
    defect_ids = [str(row.get("id") or "").strip() for row in defects if isinstance(row, dict)]
    existing = _load_existing_comments_by_defect_id(source_db_path=source_db_path, defect_ids=defect_ids)
    if not existing:
        return
    for defect in defects:
        defect_id = str(defect.get("id") or "").strip()
        if defect_id in existing:
            defect["comments"] = existing[defect_id]


def _partition_defects_for_incremental_comment_refresh(*, source_db_path: Path, defects: list[dict[str, object]]) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    defect_ids = [str(row.get("id") or "").strip() for row in defects if isinstance(row, dict)]
    watermarks = _load_comment_sync_watermarks(source_db_path=source_db_path, defect_ids=defect_ids)
    refresh_targets: list[dict[str, object]] = []
    reuse_targets: list[dict[str, object]] = []

    for defect in defects:
        defect_id = str(defect.get("id") or "").strip()
        if not defect_id:
            refresh_targets.append(defect)
            continue
        source_watermark = _parse_iso_datetime(defect.get("last_modified")) or _parse_iso_datetime(defect.get("creation_time"))
        synced_watermark = watermarks.get(defect_id)
        if synced_watermark is None or source_watermark is None or source_watermark > synced_watermark:
            refresh_targets.append(defect)
        else:
            reuse_targets.append(defect)

    return refresh_targets, reuse_targets


def _upsert_comment_sync_watermarks(*, source_db_path: Path, defects: list[dict[str, object]], fetched_at: str) -> None:
    if not defects:
        return
    rows: list[tuple[str, str, str]] = []
    for defect in defects:
        defect_id = str(defect.get("id") or "").strip()
        if not defect_id:
            continue
        source_watermark = _parse_iso_datetime(defect.get("last_modified")) or _parse_iso_datetime(defect.get("creation_time"))
        source_text = (source_watermark or _parse_iso_datetime(fetched_at) or datetime.now(timezone.utc)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        rows.append((defect_id, source_text, fetched_at))
    if not rows:
        return

    conn = sqlite3.connect(str(source_db_path))
    try:
        _ensure_comment_sync_table(conn)
        conn.executemany(
            f"""
            INSERT INTO {COMMENT_SYNC_TABLE}(defect_id, last_defect_modified, last_synced_at)
            VALUES (?, ?, ?)
            ON CONFLICT(defect_id) DO UPDATE SET
                last_defect_modified=excluded.last_defect_modified,
                last_synced_at=excluded.last_synced_at
            """,
            rows,
        )
        conn.commit()
    except sqlite3.Error:
        return
    finally:
        conn.close()


def _merge_legacy_comments_into_defects(*, module: ModuleType, session: object, defects: list[dict[str, object]], max_workers: int = 6) -> None:
    defect_ids = [str(item.get("id") or "").strip() for item in defects if str(item.get("id") or "").strip()]
    if not defect_ids:
        return
    comments = module.d6.fetch_comments_for_defects(
        session,
        defect_ids,
        batch_size=50,
        max_workers=max(1, max_workers),
    )
    if not comments:
        return

    comments_by_defect: dict[str, list[dict[str, object]]] = {}
    html_to_text = getattr(module.d6, "_html_to_text", lambda value: value)
    for comment in comments:
        if not isinstance(comment, dict):
            continue
        owner = comment.get("owner_work_item") or {}
        defect_id = str(owner.get("id", "") if isinstance(owner, dict) else comment.get("defect_id", "")).strip()
        if not defect_id:
            continue
        author_raw = comment.get("author")
        author_name = (
            author_raw.get("full_name") or author_raw.get("name")
            if isinstance(author_raw, dict)
            else str(author_raw or "")
        )
        comments_by_defect.setdefault(defect_id, []).append(
            {
                "id": str(comment.get("id", "")),
                "author": author_name,
                "text": html_to_text(comment.get("text", "")),
                "creation_time": comment.get("creation_time", ""),
                "last_modified": comment.get("last_modified", ""),
            }
        )

    for defect in defects:
        defect_id = str(defect.get("id", "")).strip()
        if defect_id in comments_by_defect:
            defect["comments"] = comments_by_defect[defect_id]


def run_legacy_qgate_defect_source_incremental(
    *,
    teams: tuple[str, ...],
    years: tuple[int, ...],
    include_comments: bool,
    save_files: bool,
    cookie_file: str | None,
    overlap_days: int = INCREMENTAL_DEFECT_OVERLAP_DAYS,
) -> dict[str, object]:
    legacy_root = resolve_legacy_repo_root()
    target_db_path = get_full_picture_source_db_path()
    effective_cookie_file = Path(cookie_file) if cookie_file else _default_cookie_file()
    defect_windows = _load_incremental_defect_windows_by_team_year(
        source_db_path=target_db_path,
        teams=teams,
        years=years,
        overlap_days=overlap_days,
    )
    fetched_at = _utc_now_iso()
    team_summaries: list[dict[str, object]] = []
    refreshed_defect_ids_by_team: dict[str, set[str]] = {team: set() for team in teams}

    with _legacy_environment(legacy_root):
        module = importlib.import_module("downloaderqgate")
        session = module.d6.get_authenticated_session("cookie", cookie_file_path=str(effective_cookie_file))
        if not session:
            raise RuntimeError("Failed to authenticate legacy Octane session for incremental defect refresh")
        store = None
        try:
            team_name_to_id = module.fetch_team_name_to_id(session)
            store = module.initialize_qgate_store(str(target_db_path), defer_history_events=True)
            defect_dir = legacy_root / "qgate" / "defect"
            if save_files:
                defect_dir.mkdir(parents=True, exist_ok=True)

            for team in teams:
                team_id = team_name_to_id.get(team)
                team_slug = module.slugify_team_name(team)
                year_summaries: list[dict[str, object]] = []
                refreshed_defects = 0

                if not team_id:
                    team_summaries.append(
                        {
                            "team": team,
                            "refreshed_defects": 0,
                            "year_summaries": year_summaries,
                        }
                    )
                    continue

                for year in years:
                    window = defect_windows[(team, year)]
                    query = _build_incremental_defect_query(
                        team_id=team_id,
                        year=year,
                        start_date=str(window["start_date"]),
                        end_date=str(window["end_date"]),
                    )
                    defect_rows = list(
                        module.d6.fetch_octane_data_parallel(
                            session,
                            module.d6.EP_DEFECT,
                            module.d6.DEFAULT_F_DEFECT_MAIN,
                            query,
                            order_by="creation_time",
                            limit_per_page=200,
                            max_workers=10,
                        )
                        or []
                    )
                    refreshed_comment_targets = 0
                    reused_comment_targets = 0
                    if include_comments and defect_rows:
                        refresh_comment_rows, reuse_comment_rows = _partition_defects_for_incremental_comment_refresh(
                            source_db_path=target_db_path,
                            defects=defect_rows,
                        )
                        refreshed_comment_targets = len(refresh_comment_rows)
                        reused_comment_targets = len(reuse_comment_rows)

                        if refresh_comment_rows:
                            _merge_legacy_comments_into_defects(module=module, session=session, defects=refresh_comment_rows)
                            missing_comment_rows = [
                                row
                                for row in refresh_comment_rows
                                if "comments" not in row
                            ]
                            if missing_comment_rows:
                                _hydrate_existing_comments_for_defects(
                                    source_db_path=target_db_path,
                                    defects=missing_comment_rows,
                                )
                            _upsert_comment_sync_watermarks(
                                source_db_path=target_db_path,
                                defects=refresh_comment_rows,
                                fetched_at=fetched_at,
                            )

                        if reuse_comment_rows:
                            _hydrate_existing_comments_for_defects(
                                source_db_path=target_db_path,
                                defects=reuse_comment_rows,
                            )

                    rows_by_year: dict[int, list[dict[str, object]]] = {}
                    for row in defect_rows:
                        if not isinstance(row, dict):
                            continue
                        row_year = int(row.get("year") or year)
                        rows_by_year.setdefault(row_year, []).append(row)

                    saved_count = 0
                    for bucket_year, bucket_rows in sorted(rows_by_year.items()):
                        if not bucket_rows:
                            continue
                        ids = module.save_defect_batch(
                            bucket_rows,
                            team=team,
                            year_str=str(bucket_year),
                            team_slug=team_slug,
                            defect_dir=str(defect_dir),
                            save_csv=False,
                            save_excel=False,
                            save_files=save_files,
                            store=store,
                            fetched_at=fetched_at,
                        )
                        refreshed_defect_ids_by_team.setdefault(team, set()).update(
                            str(defect_id).strip()
                            for defect_id in ids
                            if str(defect_id).strip()
                        )
                        saved_count += len(ids)

                    refreshed_defects += saved_count
                    year_summaries.append(
                        {
                            "year": year,
                            "mode": str(window["mode"]),
                            "start_date": str(window["start_date"]),
                            "end_date": str(window["end_date"]),
                            "refreshed_defects": saved_count,
                            "comments_refreshed": refreshed_comment_targets,
                            "comments_reused": reused_comment_targets,
                        }
                    )

                team_summaries.append(
                    {
                        "team": team,
                        "refreshed_defects": refreshed_defects,
                        "year_summaries": year_summaries,
                    }
                )
        finally:
            if store is not None:
                store.close()
            try:
                session.close()
            except Exception:
                pass

    return {
        "bridge": "qgate-defect-incremental",
        "source_db_path": str(target_db_path),
        "teams": list(teams),
        "years": list(years),
        "include_comments": include_comments,
        "save_files": save_files,
        "cookie_file": str(effective_cookie_file),
        "fetched_at": fetched_at,
        "team_summaries": team_summaries,
        "refreshed_defect_ids_by_team": {
            team: sorted(defect_ids)
            for team, defect_ids in refreshed_defect_ids_by_team.items()
        },
    }


def _load_stale_history_ids_by_team(
    *,
    source_db_path: Path,
    teams: tuple[str, ...],
    years: tuple[int, ...],
    refreshed_after: str,
) -> dict[str, list[str]]:
    placeholders_teams = ", ".join("?" for _ in teams)
    placeholders_years = ", ".join("?" for _ in years)
    query = f"""
        WITH latest_history AS (
            SELECT defect_id, MAX(fetched_at) AS latest_fetched_at
            FROM octane_defect_history_events
            GROUP BY defect_id
        )
        SELECT CAST(d.problem_finder_team AS TEXT) AS team, CAST(d.defect_id AS TEXT) AS defect_id
        FROM octane_defects d
        LEFT JOIN latest_history h ON h.defect_id = d.defect_id
        WHERE CAST(d.problem_finder_team AS TEXT) IN ({placeholders_teams})
          AND CAST(d.year AS INTEGER) IN ({placeholders_years})
          AND (h.latest_fetched_at IS NULL OR h.latest_fetched_at < ?)
        ORDER BY CAST(d.problem_finder_team AS TEXT), CAST(d.defect_id AS TEXT)
    """
    params: list[object] = [*teams, *years, refreshed_after]
    conn = sqlite3.connect(str(source_db_path))
    try:
        rows = conn.execute(query, params).fetchall()
    finally:
        conn.close()

    grouped: dict[str, list[str]] = {team: [] for team in teams}
    for team_name, defect_id in rows:
        normalized_team = str(team_name or "").strip()
        normalized_defect_id = str(defect_id or "").strip()
        if normalized_team in grouped and normalized_defect_id:
            grouped[normalized_team].append(normalized_defect_id)
    return grouped


def _load_incremental_history_ids_by_team(
    *,
    source_db_path: Path,
    teams: tuple[str, ...],
    years: tuple[int, ...],
) -> dict[str, list[str]]:
    placeholders_teams = ", ".join("?" for _ in teams)
    placeholders_years = ", ".join("?" for _ in years)
    query = f"""
        WITH latest_history AS (
            SELECT defect_id, MAX(fetched_at) AS latest_fetched_at
            FROM octane_defect_history_events
            GROUP BY defect_id
        )
        SELECT CAST(d.problem_finder_team AS TEXT) AS team, CAST(d.defect_id AS TEXT) AS defect_id
        FROM octane_defects d
        LEFT JOIN latest_history h ON h.defect_id = d.defect_id
        WHERE CAST(d.problem_finder_team AS TEXT) IN ({placeholders_teams})
          AND CAST(d.year AS INTEGER) IN ({placeholders_years})
          AND (
              h.latest_fetched_at IS NULL
              OR COALESCE(NULLIF(TRIM(CAST(d.last_modified AS TEXT)), ''), '') > COALESCE(h.latest_fetched_at, '')
          )
        ORDER BY CAST(d.problem_finder_team AS TEXT), CAST(d.defect_id AS TEXT)
    """
    params: list[object] = [*teams, *years]
    conn = sqlite3.connect(str(source_db_path))
    try:
        rows = conn.execute(query, params).fetchall()
    finally:
        conn.close()

    grouped: dict[str, list[str]] = {team: [] for team in teams}
    for team_name, defect_id in rows:
        normalized_team = str(team_name or "").strip()
        normalized_defect_id = str(defect_id or "").strip()
        if normalized_team in grouped and normalized_defect_id:
            grouped[normalized_team].append(normalized_defect_id)
    return grouped


def _resume_legacy_qgate_history_source_for_ids(
    *,
    teams: tuple[str, ...],
    years: tuple[int, ...],
    history_max_workers: int,
    save_files: bool,
    cookie_file: str | None,
    defect_ids_by_team: dict[str, list[str]],
    bridge_name: str,
    extra_summary: dict[str, object] | None = None,
) -> dict[str, object]:
    legacy_root = resolve_legacy_repo_root()
    target_db_path = get_full_picture_source_db_path()
    effective_cookie_file = Path(cookie_file) if cookie_file else _default_cookie_file()

    summary_rows: list[dict[str, object]] = []
    with _legacy_environment(legacy_root):
        module = importlib.import_module("downloaderqgate")
        session = module.d6.get_authenticated_session("cookie", cookie_file_path=str(effective_cookie_file))
        if not session:
            raise RuntimeError("Failed to authenticate legacy Octane session for history resume")
        store = None
        try:
            store = module.initialize_qgate_store(str(target_db_path), defer_history_events=False)
            history_dir = legacy_root / "qgate" / "history"
            for team in teams:
                defect_ids = defect_ids_by_team.get(team) or []
                if not defect_ids:
                    summary_rows.append(
                        {
                            "team": team,
                            "queued_defects": 0,
                            "processed_defects": 0,
                            "failed_defects": 0,
                        }
                    )
                    continue
                processed_ids, error_ids = module.save_qgate_histories(
                    defect_ids=defect_ids,
                    session=session,
                    max_workers=history_max_workers,
                    history_dir=str(history_dir),
                    team=team,
                    store=store,
                    save_files=save_files,
                    save_csv=False,
                )
                summary_rows.append(
                    {
                        "team": team,
                        "queued_defects": len(defect_ids),
                        "processed_defects": len(processed_ids),
                        "failed_defects": len(error_ids),
                    }
                )
        finally:
            if store is not None:
                store.close()
            try:
                session.close()
            except Exception:
                pass

    summary: dict[str, object] = {
        "bridge": bridge_name,
        "source_db_path": str(target_db_path),
        "teams": list(teams),
        "years": list(years),
        "history_max_workers": history_max_workers,
        "save_files": save_files,
        "cookie_file": str(effective_cookie_file),
        "team_summaries": summary_rows,
    }
    if extra_summary:
        summary.update(extra_summary)
    return summary


def resume_legacy_qgate_history_source(
    *,
    teams: tuple[str, ...],
    years: tuple[int, ...],
    history_max_workers: int,
    refreshed_after: str,
    save_files: bool,
    cookie_file: str | None,
) -> dict[str, object]:
    target_db_path = get_full_picture_source_db_path()
    stale_ids_by_team = _load_stale_history_ids_by_team(
        source_db_path=target_db_path,
        teams=teams,
        years=years,
        refreshed_after=refreshed_after,
    )

    return _resume_legacy_qgate_history_source_for_ids(
        teams=teams,
        years=years,
        history_max_workers=history_max_workers,
        save_files=save_files,
        cookie_file=cookie_file,
        defect_ids_by_team=stale_ids_by_team,
        bridge_name="qgate-history-resume",
        extra_summary={"refreshed_after": refreshed_after},
    )


def resume_incremental_legacy_qgate_history_source(
    *,
    teams: tuple[str, ...],
    years: tuple[int, ...],
    history_max_workers: int,
    save_files: bool,
    cookie_file: str | None,
    defect_ids_by_team: dict[str, list[str]] | None = None,
) -> dict[str, object]:
    target_db_path = get_full_picture_source_db_path()
    incremental_ids_by_team = defect_ids_by_team or _load_incremental_history_ids_by_team(
        source_db_path=target_db_path,
        teams=teams,
        years=years,
    )

    return _resume_legacy_qgate_history_source_for_ids(
        teams=teams,
        years=years,
        history_max_workers=history_max_workers,
        save_files=save_files,
        cookie_file=cookie_file,
        defect_ids_by_team=incremental_ids_by_team,
        bridge_name="qgate-history-incremental",
    )


def refresh_legacy_qgate_source_incremental(
    *,
    teams: tuple[str, ...],
    years: tuple[int, ...],
    include_comments: bool,
    history_max_workers: int,
    save_files: bool,
    cookie_file: str | None,
) -> dict[str, object]:
    defect_summary = run_legacy_qgate_defect_source_incremental(
        teams=teams,
        years=years,
        include_comments=include_comments,
        save_files=save_files,
        cookie_file=cookie_file,
    )
    history_summary = resume_incremental_legacy_qgate_history_source(
        teams=teams,
        years=years,
        history_max_workers=history_max_workers,
        save_files=save_files,
        cookie_file=cookie_file,
        defect_ids_by_team=defect_summary.get("refreshed_defect_ids_by_team"),
    )

    return {
        "bridge": "qgate-incremental",
        "source_db_path": defect_summary["source_db_path"],
        "teams": list(teams),
        "years": list(years),
        "include_comments": include_comments,
        "history_max_workers": history_max_workers,
        "save_files": save_files,
        "cookie_file": history_summary["cookie_file"],
        "defect_refresh": defect_summary,
        "history_resume": history_summary,
        "team_summaries": history_summary["team_summaries"],
    }


def run_legacy_testcase_source(
    *,
    team_name: str,
    release_name: str | None,
    page_limit: int | None,
    workers: int | None,
    workitems_fallback_max: int | None,
    workitems_fallback_workers: int | None,
    save_files: bool,
    cookie_file: str | None,
) -> dict[str, object]:
    legacy_root = resolve_legacy_repo_root()
    target_db_path = get_full_picture_source_db_path()
    effective_cookie_file = Path(cookie_file) if cookie_file else _default_cookie_file()
    argv = [
        "testcase_downloader.py",
        "--auth-method",
        "cookie",
        "--cookie-file",
        str(effective_cookie_file),
        "--dtsv-all",
        "--team-name",
        team_name,
        "--save-db",
        "--db-path",
        str(target_db_path),
    ]
    if release_name:
        argv.extend(["--release-name", release_name])
    if page_limit is not None:
        argv.extend(["--page-limit", str(page_limit)])
    if workers is not None:
        argv.extend(["--workers", str(workers)])
    if workitems_fallback_max is not None:
        argv.extend(["--workitems-fallback-max", str(workitems_fallback_max)])
    if workitems_fallback_workers is not None:
        argv.extend(["--workitems-fallback-workers", str(workitems_fallback_workers)])
    if not save_files:
        argv.extend(["--output-dir", str(target_db_path.parent / "legacy_testcase_exports")])

    original_argv = sys.argv[:]
    try:
        with _legacy_environment(legacy_root):
            sys.argv = argv
            module = importlib.import_module("download.testcase_downloader")
            module.main()
    finally:
        sys.argv = original_argv

    return {
        "bridge": "testcase",
        "source_db_path": str(target_db_path),
        "team_name": team_name,
        "release_name": release_name,
        "page_limit": page_limit,
        "workers": workers,
        "workitems_fallback_max": workitems_fallback_max,
        "workitems_fallback_workers": workitems_fallback_workers,
        "save_files": save_files,
        "cookie_file": str(effective_cookie_file),
    }