"""
FeedbackStore — 用户反馈存储与权重管理

功能：
1. 存储用户对查询结果的 👍/👎 反馈
2. 基于反馈调整 SQL 候选排序权重
3. 反馈笔记存储（用户给出的具体修正意见）
4. 反馈统计与报告
"""

from __future__ import annotations

import json
import sqlite3
import hashlib
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, List, Dict, Any


@dataclass
class FeedbackRecord:
    """一条用户反馈"""
    id: str = ""
    query_memory_id: str = ""
    feedback_type: str = ""  # "up" | "down"
    note: str = ""
    question: str = ""
    sql: str = ""
    correction: str = ""
    created_at: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "query_memory_id": self.query_memory_id,
            "feedback_type": self.feedback_type,
            "note": self.note,
            "question": self.question,
            "sql": self.sql,
            "correction": self.correction,
            "created_at": self.created_at,
        }


class FeedbackStore:
    """
    反馈存储引擎
    
    - SQLite 存储
    - 与 QueryMemory 通过 record_id 关联
    - 提供权重调整建议
    """

    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or ":memory:"
        self._persistent_conn: Optional[sqlite3.Connection] = None
        if self.db_path == ":memory:":
            self._persistent_conn = sqlite3.connect(":memory:")
            self._persistent_conn.row_factory = sqlite3.Row
        self._init_db()

    def _get_conn(self) -> sqlite3.Connection:
        if self._persistent_conn is not None:
            return self._persistent_conn
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _close_if_file(self, conn: sqlite3.Connection):
        if self._persistent_conn is None:
            conn.close()

    def _init_db(self):
        conn = self._get_conn()
        conn.execute("""
            CREATE TABLE IF NOT EXISTS feedback (
                id TEXT PRIMARY KEY,
                query_memory_id TEXT NOT NULL,
                feedback_type TEXT NOT NULL,
                note TEXT DEFAULT '',
                question TEXT DEFAULT '',
                sql TEXT DEFAULT '',
                correction TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                FOREIGN KEY (query_memory_id) REFERENCES query_memory(id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_feedback_memory ON feedback(query_memory_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_feedback_type ON feedback(feedback_type)")
        conn.commit()
        self._close_if_file(conn)

    def record(
        self,
        query_memory_id: str,
        feedback_type: str,
        note: str = "",
        question: str = "",
        sql: str = "",
        correction: str = "",
    ) -> str:
        if feedback_type not in ("up", "down"):
            raise ValueError(f"feedback_type must be 'up' or 'down'")

        fid = hashlib.md5(
            f"{query_memory_id}::{feedback_type}::{datetime.now().isoformat()}".encode()
        ).hexdigest()[:16]
        
        now = datetime.now().isoformat()
        
        conn = self._get_conn()
        conn.execute("""
            INSERT INTO feedback (id, query_memory_id, feedback_type, note, question, sql, correction, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (fid, query_memory_id, feedback_type, note, question, sql, correction, now))
        
        # Also update QueryMemory table
        if feedback_type == "up":
            conn.execute(
                "UPDATE query_memory SET feedback = 'up', score = score + 1.0 WHERE id = ?",
                (query_memory_id,)
            )
        else:
            conn.execute(
                "UPDATE query_memory SET feedback = 'down', score = score - 0.5 WHERE id = ?",
                (query_memory_id,)
            )
        
        conn.commit()
        self._close_if_file(conn)
        return fid

    def get_by_query(self, query_memory_id: str) -> List[FeedbackRecord]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM feedback WHERE query_memory_id = ? ORDER BY created_at DESC",
            (query_memory_id,)
        ).fetchall()
        self._close_if_file(conn)
        return [self._row_to_record(r) for r in rows]

    def get_recent(self, limit: int = 20) -> List[FeedbackRecord]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?",
            (limit,)
        ).fetchall()
        self._close_if_file(conn)
        return [self._row_to_record(r) for r in rows]

    def get_statistics(self) -> Dict[str, Any]:
        conn = self._get_conn()
        total = conn.execute("SELECT COUNT(*) as c FROM feedback").fetchone()["c"]
        up = conn.execute("SELECT COUNT(*) as c FROM feedback WHERE feedback_type = 'up'").fetchone()["c"]
        down = conn.execute("SELECT COUNT(*) as c FROM feedback WHERE feedback_type = 'down'").fetchone()["c"]
        
        negative_notes = conn.execute(
            "SELECT question, note, correction FROM feedback WHERE feedback_type = 'down' AND note != '' ORDER BY created_at DESC LIMIT 10"
        ).fetchall()
        self._close_if_file(conn)
        
        return {
            "total": total,
            "thumbs_up": up,
            "thumbs_down": down,
            "satisfaction_rate": up / total if total > 0 else 0,
            "negative_notes": [
                {"question": r["question"], "note": r["note"], "correction": r["correction"]}
                for r in negative_notes
            ],
        }

    def get_weight_adjustments(self) -> Dict[str, float]:
        conn = self._get_conn()
        rows = conn.execute("""
            SELECT qm.intent, 
                   SUM(CASE WHEN f.feedback_type = 'up' THEN 1 ELSE 0 END) as up_count,
                   SUM(CASE WHEN f.feedback_type = 'down' THEN 1 ELSE 0 END) as down_count
            FROM feedback f
            JOIN query_memory qm ON f.query_memory_id = qm.id
            GROUP BY qm.intent
        """).fetchall()
        self._close_if_file(conn)
        
        adjustments = {}
        for row in rows:
            intent = row["intent"] or "unknown"
            up, down = row["up_count"], row["down_count"]
            total = up + down
            
            if total < 2:
                continue
            
            satisfaction = up / total
            if satisfaction >= 0.8:
                adjustments[intent] = 0.1
            elif satisfaction <= 0.4:
                adjustments[intent] = -0.2
        
        return adjustments

    def _row_to_record(self, row: sqlite3.Row) -> FeedbackRecord:
        return FeedbackRecord(
            id=row["id"],
            query_memory_id=row["query_memory_id"],
            feedback_type=row["feedback_type"],
            note=row["note"],
            question=row["question"],
            sql=row["sql"],
            correction=row["correction"],
            created_at=row["created_at"],
        )
