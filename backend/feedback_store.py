import hashlib
import json
import os
import sqlite3
import threading
import time
from typing import Any, Dict, Iterable, List, Optional, Sequence

_DEFAULT_DB_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "database", "ticket_embeddings.db"
)

_FEEDBACK_DDL = """
CREATE TABLE IF NOT EXISTS feedback_records (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    query_text  TEXT NOT NULL,
    query_hash  TEXT NOT NULL,
    ticket_id   TEXT NOT NULL,
    signal      TEXT NOT NULL,
    base_score  REAL,
    rank_pos    INTEGER,
    user_id     TEXT,
    is_valid    INTEGER DEFAULT 1,
    created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fb_query ON feedback_records(query_hash);
CREATE INDEX IF NOT EXISTS idx_fb_ticket ON feedback_records(ticket_id);
CREATE INDEX IF NOT EXISTS idx_fb_user_time ON feedback_records(user_id, created_at);

CREATE TABLE IF NOT EXISTS reranker_models (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    phase           TEXT NOT NULL,
    model_blob      BLOB,
    metrics         TEXT,
    feedback_count  INTEGER,
    created_at      REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS adapter_weights (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    weight_matrix   BLOB NOT NULL,
    bias_vector     BLOB,
    loss_history    TEXT,
    train_pairs     INTEGER,
    ndcg_score      REAL,
    created_at      REAL NOT NULL
);
"""


class TrainingScheduler:
    FEATURE_THRESHOLD = 50
    ADAPTER_THRESHOLD = 200
    RETRAIN_INTERVAL = 20

    def __init__(self, store: Optional["FeedbackStore"] = None) -> None:
        self._store = store

    def current_phase(self, total_feedback: Optional[int] = None) -> str:
        if total_feedback is None:
            total_feedback = self._store.count_feedback() if self._store else 0
        if int(total_feedback) >= self.ADAPTER_THRESHOLD:
            return "adapter"
        if int(total_feedback) >= self.FEATURE_THRESHOLD:
            return "feature"
        return "click_boost"

    def should_retrain(self, total_feedback: int, last_train_count: int) -> bool:
        return int(total_feedback) - int(last_train_count) >= self.RETRAIN_INTERVAL


class FeedbackGuard:
    def __init__(self, max_feedback_per_hour: int = 50, flip_window_seconds: int = 300):
        self.max_feedback_per_hour = max_feedback_per_hour
        self.flip_window_seconds = flip_window_seconds


class FeedbackStore:
    VALID_SIGNALS = {"positive", "negative", "click"}

    def __init__(
        self,
        db_path: str = _DEFAULT_DB_PATH,
        max_feedback_per_hour: int = 50,
        flip_window_seconds: int = 300,
    ) -> None:
        self.db_path = db_path
        self.scheduler = TrainingScheduler()
        self.guard = FeedbackGuard(
            max_feedback_per_hour=max_feedback_per_hour,
            flip_window_seconds=flip_window_seconds,
        )
        self._lock = threading.Lock()
        db_dir = os.path.dirname(self.db_path)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)
        self._ensure_schema()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_schema(self) -> None:
        conn = self._conn()
        conn.executescript(_FEEDBACK_DDL)
        conn.commit()
        conn.close()

    @staticmethod
    def query_hash(query_text: str) -> str:
        text = (query_text or "").strip()
        return hashlib.md5(text.encode("utf-8", errors="replace")).hexdigest()

    def count_feedback(self, valid_only: bool = True) -> int:
        conn = self._conn()
        where = " WHERE is_valid=1" if valid_only else ""
        row = conn.execute(f"SELECT COUNT(*) AS cnt FROM feedback_records{where}").fetchone()
        conn.close()
        return int(row["cnt"] if row else 0)

    def current_phase(self) -> str:
        return self.scheduler.current_phase(self.count_feedback())

    def submit_feedback(
        self,
        query_text: str,
        ticket_id: str,
        signal: str,
        user_id: Optional[str] = None,
        base_score: Optional[float] = None,
        rank_pos: Optional[int] = None,
    ) -> Dict[str, Any]:
        normalized_signal = str(signal or "").strip().lower()
        if normalized_signal not in self.VALID_SIGNALS:
            return {"accepted": False, "reason": "invalid_signal"}
        if not str(query_text or "").strip() or not str(ticket_id or "").strip():
            return {"accepted": False, "reason": "missing_required_fields"}

        now = time.time()
        with self._lock:
            conn = self._conn()
            if user_id:
                recent_count = conn.execute(
                    "SELECT COUNT(*) AS cnt FROM feedback_records WHERE user_id=? AND created_at>?",
                    (user_id, now - 3600),
                ).fetchone()
                if recent_count and int(recent_count["cnt"]) >= self.guard.max_feedback_per_hour:
                    conn.close()
                    return {"accepted": False, "reason": "rate_limit"}

            query_hash = self.query_hash(query_text)
            replaced_id = None
            if user_id:
                previous = conn.execute(
                    """
                    SELECT id, signal FROM feedback_records
                    WHERE query_hash=? AND ticket_id=? AND user_id=? AND created_at>? AND is_valid=1
                    ORDER BY created_at DESC LIMIT 1
                    """,
                    (
                        query_hash,
                        ticket_id,
                        user_id,
                        now - self.guard.flip_window_seconds,
                    ),
                ).fetchone()
                if previous and str(previous["signal"]).lower() != normalized_signal:
                    conn.execute(
                        "UPDATE feedback_records SET is_valid=0 WHERE id=?",
                        (int(previous["id"]),),
                    )
                    replaced_id = int(previous["id"])

            conn.execute(
                """
                INSERT INTO feedback_records
                (query_text, query_hash, ticket_id, signal, base_score, rank_pos, user_id, is_valid, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
                """,
                (
                    str(query_text).strip(),
                    query_hash,
                    str(ticket_id).strip(),
                    normalized_signal,
                    None if base_score is None else float(base_score),
                    None if rank_pos is None else int(rank_pos),
                    user_id,
                    now,
                ),
            )
            conn.commit()
            conn.close()

        return {
            "accepted": True,
            "reason": "ok",
            "replaced_feedback_id": replaced_id,
            "feedback_count": self.count_feedback(),
            "model_phase": self.current_phase(),
        }

    def list_feedback(
        self,
        query_text: Optional[str] = None,
        ticket_id: Optional[str] = None,
        valid_only: bool = True,
    ) -> List[Dict[str, Any]]:
        clauses: List[str] = []
        params: List[Any] = []
        if query_text is not None:
            clauses.append("query_hash=?")
            params.append(self.query_hash(query_text))
        if ticket_id is not None:
            clauses.append("ticket_id=?")
            params.append(ticket_id)
        if valid_only:
            clauses.append("is_valid=1")
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        conn = self._conn()
        rows = conn.execute(
            f"SELECT * FROM feedback_records{where} ORDER BY created_at ASC",
            params,
        ).fetchall()
        conn.close()
        return [dict(row) for row in rows]

    def get_training_examples(self) -> List[Dict[str, Any]]:
        return self.list_feedback(valid_only=True)

    def get_ticket_feedback_stats(self, ticket_ids: Sequence[str]) -> Dict[str, Dict[str, Any]]:
        requested = [ticket_id for ticket_id in ticket_ids if ticket_id]
        if not requested:
            return {}
        conn = self._conn()
        placeholders = ",".join("?" for _ in requested)
        rows = conn.execute(
            f"""
            SELECT ticket_id, signal, COUNT(*) AS cnt
            FROM feedback_records
            WHERE is_valid=1 AND ticket_id IN ({placeholders})
            GROUP BY ticket_id, signal
            """,
            requested,
        ).fetchall()
        conn.close()

        stats: Dict[str, Dict[str, Any]] = {}
        for ticket_id in requested:
            stats[ticket_id] = {
                "positive": 0,
                "negative": 0,
                "click": 0,
                "positive_rate": 0.0,
                "weighted_positive_rate": 0.0,
            }
        for row in rows:
            ticket_id = row["ticket_id"]
            signal = row["signal"]
            stats.setdefault(ticket_id, {
                "positive": 0,
                "negative": 0,
                "click": 0,
                "positive_rate": 0.0,
                "weighted_positive_rate": 0.0,
            })
            stats[ticket_id][signal] = int(row["cnt"])

        for ticket_id, item in stats.items():
            positive = int(item.get("positive", 0))
            negative = int(item.get("negative", 0))
            click = int(item.get("click", 0))
            denominator = positive + negative + click + 1
            weighted_positive = positive + (0.3 * click)
            item["positive_rate"] = float(positive) / float(denominator)
            item["weighted_positive_rate"] = float(weighted_positive) / float(denominator)
        return stats

    def save_model_snapshot(
        self,
        phase: str,
        model_blob: Optional[bytes],
        metrics: Optional[Dict[str, Any]],
        feedback_count: int,
    ) -> None:
        conn = self._conn()
        conn.execute(
            "INSERT INTO reranker_models (phase, model_blob, metrics, feedback_count, created_at) VALUES (?, ?, ?, ?, ?)",
            (
                phase,
                sqlite3.Binary(model_blob) if model_blob is not None else None,
                json.dumps(metrics or {}, ensure_ascii=False),
                int(feedback_count),
                time.time(),
            ),
        )
        conn.commit()
        conn.close()

    def load_latest_model_snapshot(self, phase: Optional[str] = None) -> Optional[Dict[str, Any]]:
        conn = self._conn()
        if phase:
            row = conn.execute(
                "SELECT * FROM reranker_models WHERE phase=? ORDER BY id DESC LIMIT 1",
                (phase,),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT * FROM reranker_models ORDER BY id DESC LIMIT 1"
            ).fetchone()
        conn.close()
        if not row:
            return None
        result = dict(row)
        result["metrics"] = json.loads(result.get("metrics") or "{}")
        return result

    def save_adapter_weights(
        self,
        weight_matrix: bytes,
        bias_vector: Optional[bytes],
        loss_history: Iterable[float],
        train_pairs: int,
        ndcg_score: float,
    ) -> None:
        conn = self._conn()
        conn.execute(
            "INSERT INTO adapter_weights (weight_matrix, bias_vector, loss_history, train_pairs, ndcg_score, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (
                sqlite3.Binary(weight_matrix),
                sqlite3.Binary(bias_vector) if bias_vector is not None else None,
                json.dumps(list(loss_history)),
                int(train_pairs),
                float(ndcg_score),
                time.time(),
            ),
        )
        conn.commit()
        conn.close()

    # ── Monitor helpers ──

    def get_total_feedback_count(self) -> int:
        return self.count_feedback(valid_only=True)

    def get_feedback_count_by_signal(self, signal: str) -> int:
        conn = self._conn()
        row = conn.execute(
            "SELECT COUNT(*) AS cnt FROM feedback_records WHERE is_valid=1 AND signal=?",
            (signal,),
        ).fetchone()
        conn.close()
        return int(row["cnt"] if row else 0)

    def get_recent_feedback(self, limit: int = 20) -> List[Dict[str, Any]]:
        conn = self._conn()
        rows = conn.execute(
            "SELECT created_at, query_text, ticket_id, signal, user_id FROM feedback_records WHERE is_valid=1 ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        conn.close()
        import datetime as _dt
        result = []
        for r in rows:
            d = dict(r)
            ts = d.get("created_at")
            if isinstance(ts, (int, float)):
                d["created_at"] = _dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")
            q = str(d.get("query_text") or "")
            if len(q) > 60:
                d["query_text"] = q[:57] + "..."
            result.append(d)
        return result

    def get_model_snapshots(self, limit: int = 5) -> List[Dict[str, Any]]:
        conn = self._conn()
        rows = conn.execute(
            "SELECT phase, feedback_count, metrics, created_at FROM reranker_models ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        conn.close()
        import datetime as _dt
        result = []
        for r in rows:
            d = dict(r)
            ts = d.get("created_at")
            if isinstance(ts, (int, float)):
                d["created_at"] = _dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")
            result.append(d)
        return result


__all__ = [
    "FeedbackStore",
    "FeedbackGuard",
    "TrainingScheduler",
]
