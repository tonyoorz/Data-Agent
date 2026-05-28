#!/usr/bin/env python3
import json
import os
import re
import sqlite3
import sys
import time
from html import unescape
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = REPO_ROOT / 'backend'

for candidate in (str(REPO_ROOT), str(BACKEND_ROOT)):
    if candidate not in sys.path:
        sys.path.insert(0, candidate)

from backend.analytics.config import get_full_picture_source_db_path
from duplicate_issue_finder import extract_hints, get_or_build_index_with_metadata
from feedback_store import FeedbackStore
from progressive_reranker import get_progressive_reranker


_DEFECT_DF_CACHE: Dict[str, Dict[str, Any]] = {}


def _elapsed_ms(started_at: float) -> float:
    return round((time.perf_counter() - started_at) * 1000, 1)


def _strip_html(text: str) -> str:
    if not text:
        return ''
    clean = re.sub(r'<[^>]+>', ' ', text)
    clean = unescape(clean)
    clean = re.sub(r'\s+', ' ', clean)
    return clean.strip()


def _flatten_comments(value: Any) -> str:
    if value is None:
        return ''

    parsed = value
    if isinstance(parsed, str):
        raw = parsed.strip()
        if not raw:
            return ''
        try:
            parsed = json.loads(raw)
        except Exception:
            return _strip_html(raw)

    if isinstance(parsed, dict):
        parsed = [parsed]

    if isinstance(parsed, list):
        parts: List[str] = []
        for item in parsed:
            if isinstance(item, dict):
                text = _strip_html(str(item.get('text') or ''))
            else:
                text = _strip_html(str(item))
            if text:
                parts.append(text)
        return '\n'.join(parts)

    return _strip_html(str(parsed))


def _pick_scalar(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, dict):
        for key in ('name', 'id', 'value'):
            item = value.get(key)
            if isinstance(item, str) and item.strip():
                return item.strip()
        return None
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return None


def _extract_pu_from_version(version: Optional[str]) -> Optional[str]:
    if not version:
        return None
    match = re.search(r'(\d{2})[-/.](\d{2})', version)
    if not match:
        return None
    return f'{match.group(1)}-{match.group(2)}'


def _rows_from_defect_file(file_path: Path) -> List[Dict[str, Any]]:
    if not file_path.exists():
        return []
    with file_path.open('r', encoding='utf-8') as handle:
        data = json.load(handle)

    rows: List[Dict[str, Any]] = []
    for raw in data if isinstance(data, list) else []:
        if not isinstance(raw, dict):
            continue
        title = str(raw.get('name') or '').strip()
        description = _strip_html(str(raw.get('description') or ''))
        comments = _flatten_comments(raw.get('comments'))

        hint_text = ' '.join(
            [
                title,
                description[:1800],
                str(raw.get('software_version_udf') or ''),
                str(raw.get('detected_in_release') or ''),
            ]
        )
        hints = extract_hints(hint_text)

        project = _pick_scalar(raw.get('project')) or hints.project
        pu = _pick_scalar(raw.get('pu')) or _extract_pu_from_version(_pick_scalar(raw.get('software_version_udf'))) or hints.pu
        phase = _pick_scalar(raw.get('status_phase'))
        if not phase:
            phase_obj = raw.get('phase')
            if isinstance(phase_obj, dict):
                phase = _pick_scalar(phase_obj.get('name'))

        rows.append(
            {
                'id': str(raw.get('id') or '').strip(),
                'name': title,
                'description': description,
                'project': project,
                'pu': pu,
                'ecu': hints.ecu,
                'lead_model': hints.lead_model,
                'status_phase': phase,
                'comments': comments,
            }
        )
    return rows


def _resolve_data_dir(repo_root: Path) -> Path:
    configured = str(os.getenv('DUPSEARCH_DATA_DIR') or '').strip()
    if configured:
        return Path(configured)
    return repo_root / 'defect'


def _resolve_sqlite_path() -> Optional[Path]:
    configured = str(os.getenv('DUPSEARCH_SQLITE_PATH') or '').strip()
    if not configured:
        candidate = get_full_picture_source_db_path()
        if candidate.exists():
            return candidate
        return None
    return Path(configured)


def _rows_from_octane_defects(sqlite_path: Path) -> List[Dict[str, Any]]:
    if not sqlite_path.exists():
        raise FileNotFoundError(f'SQLite database not found: {sqlite_path}')

    with sqlite3.connect(str(sqlite_path)) as connection:
        columns = {
            str(row[1]).strip().lower()
            for row in connection.execute("PRAGMA table_info(octane_defects)").fetchall()
        }
        comments_select = 'comments' if 'comments' in columns else "'' AS comments"
        query = f'''
        SELECT
            defect_id,
            name,
            description,
            {comments_select},
            project,
            pu,
            software_version,
            status_phase,
            assigned_ecu AS ecu,
            lead_model,
            detected_in_release
        FROM octane_defects
    '''
        df = pd.read_sql_query(query, connection)

    rows: List[Dict[str, Any]] = []
    for raw in df.to_dict(orient='records'):
        title = str(raw.get('name') or '').strip()
        description = _strip_html(str(raw.get('description') or ''))
        comments = _flatten_comments(raw.get('comments'))

        hint_text = ' '.join(
            [
                title,
                description[:1800],
                str(raw.get('software_version') or ''),
                str(raw.get('detected_in_release') or ''),
            ]
        )
        hints = extract_hints(hint_text)

        pu = _pick_scalar(raw.get('pu')) or _extract_pu_from_version(_pick_scalar(raw.get('software_version'))) or hints.pu

        rows.append(
            {
                'id': str(raw.get('defect_id') or '').strip(),
                'name': title,
                'description': description,
                'project': _pick_scalar(raw.get('project')) or hints.project,
                'pu': pu,
                'ecu': _pick_scalar(raw.get('ecu')) or hints.ecu,
                'lead_model': _pick_scalar(raw.get('lead_model')) or hints.lead_model,
                'status_phase': _pick_scalar(raw.get('status_phase')),
                'comments': comments,
            }
        )
    return rows


def _build_defect_df(repo_root: Path) -> pd.DataFrame:
    sqlite_path = _resolve_sqlite_path()
    if sqlite_path:
        rows = _rows_from_octane_defects(sqlite_path)
    else:
        defect_dir = _resolve_data_dir(repo_root)
        files = [defect_dir / '2026_defect.json', defect_dir / '2025_defect.json']

        rows: List[Dict[str, Any]] = []
        for file_path in files:
            rows.extend(_rows_from_defect_file(file_path))

    if not rows:
        return pd.DataFrame(columns=['id', 'name', 'description', 'comments', 'project', 'pu', 'status_phase'])

    df = pd.DataFrame(rows)
    df = df[df['id'].astype(str).str.len() > 0]
    df = df.drop_duplicates(subset=['id'], keep='first').reset_index(drop=True)
    return df


def _build_cache_key(repo_root: Path, df: pd.DataFrame) -> str:
    sqlite_path = _resolve_sqlite_path()
    if sqlite_path and sqlite_path.exists():
        return f"dupsearch-agent:sqlite:{len(df)}:{int(sqlite_path.stat().st_mtime)}"

    defect_dir = _resolve_data_dir(repo_root)
    files = [defect_dir / '2026_defect.json', defect_dir / '2025_defect.json']

    mtimes = []
    for file_path in files:
        if file_path.exists():
            mtimes.append(str(int(file_path.stat().st_mtime)))

    return f"dupsearch-agent:json:{len(df)}:{'-'.join(mtimes)}"


def _build_defect_source_signature(repo_root: Path) -> str:
    sqlite_path = _resolve_sqlite_path()
    if sqlite_path and sqlite_path.exists():
        stat = sqlite_path.stat()
        return f"sqlite:{sqlite_path.resolve()}:{stat.st_size}:{stat.st_mtime_ns}"

    defect_dir = _resolve_data_dir(repo_root)
    files = [defect_dir / '2026_defect.json', defect_dir / '2025_defect.json']
    parts: List[str] = []
    for file_path in files:
        if not file_path.exists():
            continue
        stat = file_path.stat()
        parts.append(f"{file_path.name}:{stat.st_size}:{stat.st_mtime_ns}")
    return f"json:{'|'.join(parts)}"


def _get_cached_defect_df(repo_root: Path) -> tuple[pd.DataFrame, str, bool]:
    source_signature = _build_defect_source_signature(repo_root)
    cached = _DEFECT_DF_CACHE.get(source_signature)
    if cached is not None:
        return cached['df'], cached['cache_key'], True

    df = _build_defect_df(repo_root)
    cache_key = _build_cache_key(repo_root, df)
    _DEFECT_DF_CACHE.clear()
    _DEFECT_DF_CACHE[source_signature] = {
        'df': df,
        'cache_key': cache_key,
    }
    return df, cache_key, False


def _search(payload: Dict[str, Any], repo_root: Path) -> Dict[str, Any]:
    started_at = time.perf_counter()
    query = str(payload.get('query') or '').strip()
    if not query:
        return {'success': False, 'error': 'query is required'}

    top_k = int(payload.get('top_k') or 8)
    top_k = max(1, min(20, top_k))

    feedback_db_path = str(payload.get('feedback_db_path') or '').strip()
    if not feedback_db_path:
        feedback_db_path = str(BACKEND_ROOT / 'database' / 'duplicate_feedback.db')

    load_df_started_at = time.perf_counter()
    df, cache_key, defect_df_cache_hit = _get_cached_defect_df(repo_root)
    load_defect_df_ms = _elapsed_ms(load_df_started_at)

    index_started_at = time.perf_counter()
    index, index_metadata = get_or_build_index_with_metadata(cache_key=cache_key, df=df)
    get_or_build_index_ms = _elapsed_ms(index_started_at)

    hints_started_at = time.perf_counter()
    hints = extract_hints(query)
    extract_hints_ms = _elapsed_ms(hints_started_at)

    search_started_at = time.perf_counter()
    reranker = get_progressive_reranker(db_path=feedback_db_path)
    candidates, metadata = index.search_with_metadata(
        query,
        hints=hints,
        top_k=top_k,
        reranker=reranker,
        feedback_db_path=feedback_db_path,
    )
    search_with_metadata_ms = _elapsed_ms(search_started_at)

    result_items: List[Dict[str, Any]] = []
    for candidate in candidates:
        result_items.append(
            {
                'score1to10': int(getattr(candidate, 'score_1_10', 1) or 1),
                'similarity': float(getattr(candidate, 'similarity', 0.0) or 0.0),
                'ticketId': str(getattr(candidate, 'ticket_id', '') or ''),
                'name': str(getattr(candidate, 'name', '') or ''),
                'project': getattr(candidate, 'project', None),
                'pu': getattr(candidate, 'pu', None),
                'statusPhase': getattr(candidate, 'status_phase', None),
                'snippet': str(getattr(candidate, 'snippet', '') or ''),
            }
        )

    feedback_started_at = time.perf_counter()
    store = FeedbackStore(db_path=feedback_db_path)
    search_id = FeedbackStore.query_hash(f'dupsearch-agent:{query}:{time.time()}')
    feedback_count = store.count_feedback()
    feedback_count_ms = _elapsed_ms(feedback_started_at)

    timings = {
        'total_ms': _elapsed_ms(started_at),
        'load_defect_df_ms': load_defect_df_ms,
        'load_defect_df_cache_hit': defect_df_cache_hit,
        'get_or_build_index_ms': get_or_build_index_ms,
        'extract_hints_ms': extract_hints_ms,
        'search_with_metadata_ms': search_with_metadata_ms,
        'feedback_count_ms': feedback_count_ms,
        'index_cache_hit': bool(index_metadata.get('index_cache_hit')),
        'index_rebuilt': bool(index_metadata.get('index_rebuilt')),
        'index_row_count': int(index_metadata.get('index_row_count') or len(df)),
    }

    return {
        'success': True,
        'result': {
            'searchId': search_id,
            'queryText': query,
            'candidates': result_items,
            'modelPhase': metadata.get('model_phase', 'baseline'),
            'feedbackCount': feedback_count,
            'dataset_size': int(len(df)),
            'timings': timings,
        },
    }


def _warmup(payload: Dict[str, Any], repo_root: Path) -> Dict[str, Any]:
    started_at = time.perf_counter()

    load_df_started_at = time.perf_counter()
    df, cache_key, defect_df_cache_hit = _get_cached_defect_df(repo_root)
    load_defect_df_ms = _elapsed_ms(load_df_started_at)

    index_started_at = time.perf_counter()
    index, index_metadata = get_or_build_index_with_metadata(cache_key=cache_key, df=df)
    get_or_build_index_ms = _elapsed_ms(index_started_at)

    return {
        'success': True,
        'result': {
            'dataset_size': int(len(df)),
            'index_ready': bool(getattr(index, 'ready', False)),
            'timings': {
                'total_ms': _elapsed_ms(started_at),
                'load_defect_df_ms': load_defect_df_ms,
                'load_defect_df_cache_hit': defect_df_cache_hit,
                'get_or_build_index_ms': get_or_build_index_ms,
                'index_cache_hit': bool(index_metadata.get('index_cache_hit')),
                'index_rebuilt': bool(index_metadata.get('index_rebuilt')),
                'index_row_count': int(index_metadata.get('index_row_count') or len(df)),
            },
        },
    }


def _feedback(payload: Dict[str, Any], repo_root: Path) -> Dict[str, Any]:
    query_text = str(payload.get('query_text') or '').strip()
    ticket_id = str(payload.get('ticket_id') or '').strip()
    signal = str(payload.get('signal') or '').strip().lower()

    if not query_text or not ticket_id or not signal:
        return {'success': False, 'error': 'query_text/ticket_id/signal are required'}

    if signal not in {'positive', 'negative', 'click'}:
        return {'success': False, 'error': 'signal must be one of positive/negative/click'}

    feedback_db_path = str(payload.get('feedback_db_path') or '').strip()
    if not feedback_db_path:
        feedback_db_path = str(BACKEND_ROOT / 'database' / 'duplicate_feedback.db')

    store = FeedbackStore(db_path=feedback_db_path)
    result = store.submit_feedback(
        query_text=query_text,
        ticket_id=ticket_id,
        signal=signal,
        user_id=payload.get('user_id'),
        base_score=payload.get('base_score'),
        rank_pos=payload.get('rank_pos'),
    )

    if not result.get('accepted'):
        return {
            'success': False,
            'error': result.get('reason') or 'feedback rejected',
            'result': result,
        }

    result['feedback_count'] = store.count_feedback()
    return {'success': True, 'result': result}


def _handle_payload(payload: Dict[str, Any], repo_root: Path) -> Dict[str, Any]:
    action = str(payload.get('action') or 'search').strip().lower()

    try:
        if action == 'warmup':
            return _warmup(payload, repo_root)
        if action == 'feedback':
            return _feedback(payload, repo_root)
        return _search(payload, repo_root)
    except Exception as exc:
        return {'success': False, 'error': str(exc)}


def run_server(
    input_stream: Any = sys.stdin,
    output_stream: Any = sys.stdout,
    repo_root: Path = REPO_ROOT,
) -> None:
    for raw_line in input_stream:
        line = str(raw_line or '').strip()
        if not line:
            continue

        try:
            payload = json.loads(line)
        except Exception:
            payload = {}

        result = _handle_payload(payload, repo_root)
        output_stream.write(json.dumps(result, ensure_ascii=False))
        output_stream.write('\n')
        output_stream.flush()


def main() -> None:
    repo_root = REPO_ROOT
    if '--server' in sys.argv[1:]:
        run_server(repo_root=repo_root)
        return

    try:
        payload = json.loads(sys.stdin.read() or '{}')
    except Exception:
        payload = {}

    result = _handle_payload(payload, repo_root)
    sys.stdout.write(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
