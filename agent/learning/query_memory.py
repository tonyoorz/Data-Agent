"""
QueryMemory — 查询记忆引擎

存储成功的 NL→SQL 对，支持：
1. 相似问题检索（embedding + 关键词混合）
2. SQL 复用（高相似度直接复用）
3. 结果摘要缓存

灵感: WrenAI Memory Layer + 人类工作经验积累
"""

from __future__ import annotations

import json
import sqlite3
import hashlib
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, List, Dict, Any, Tuple


@dataclass
class QueryRecord:
    """一条查询记忆"""
    id: str = ""
    question: str = ""
    normalized_question: str = ""
    sql: str = ""
    intent: str = ""
    entities: Dict[str, Any] = field(default_factory=dict)
    result_summary: str = ""
    result_count: int = 0
    success: bool = True
    feedback: Optional[str] = None  # "up" | "down" | None
    feedback_note: str = ""
    created_at: str = ""
    usage_count: int = 0  # 被检索复用次数
    score: float = 1.0  # 综合评分（feedback + usage + recency）

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "question": self.question,
            "normalized_question": self.normalized_question,
            "sql": self.sql,
            "intent": self.intent,
            "entities": json.dumps(self.entities, ensure_ascii=False),
            "result_summary": self.result_summary,
            "result_count": self.result_count,
            "success": self.success,
            "feedback": self.feedback,
            "feedback_note": self.feedback_note,
            "created_at": self.created_at,
            "usage_count": self.usage_count,
            "score": self.score,
        }

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "QueryRecord":
        entities = json.loads(row["entities"]) if row["entities"] else {}
        return cls(
            id=row["id"],
            question=row["question"],
            normalized_question=row["normalized_question"],
            sql=row["sql"],
            intent=row["intent"],
            entities=entities,
            result_summary=row["result_summary"],
            result_count=row["result_count"],
            success=bool(row["success"]),
            feedback=row["feedback"],
            feedback_note=row["feedback_note"],
            created_at=row["created_at"],
            usage_count=row["usage_count"],
            score=row["score"],
        )


def _normalize_question(q: str) -> str:
    """归一化问题文本，用于相似度比较"""
    s = q.strip().lower()
    s = re.sub(r'\s+', ' ', s)
    s = re.sub(r'[，。？！,.?!;；]', '', s)
    return s


def _extract_keywords(q: str) -> set:
    """提取关键词用于快速检索"""
    s = _normalize_question(q)
    cjk_chars = set()
    eng_words = set()
    
    cjk_pattern = re.compile(r'[\u4e00-\u9fff]+')
    for match in cjk_pattern.finditer(s):
        text = match.group()
        if len(text) >= 2:
            for i in range(len(text) - 1):
                cjk_chars.add(text[i:i+2])
        cjk_chars.add(text)
    
    eng_pattern = re.compile(r'[a-z0-9_]+')
    for match in eng_pattern.finditer(s):
        word = match.group()
        if len(word) >= 2:
            eng_words.add(word)
    
    return cjk_chars | eng_words


def _jaccard_similarity(set_a: set, set_b: set) -> float:
    """Jaccard 相似度"""
    if not set_a or not set_b:
        return 0.0
    intersection = set_a & set_b
    union = set_a | set_b
    return len(intersection) / len(union)


def _edit_distance_ratio(a: str, b: str) -> float:
    """编辑距离相似度 (0-1, 1=完全相同)"""
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    
    m, n = len(a), len(b)
    if m > 200 or n > 200:
        return _jaccard_similarity(_extract_keywords(a), _extract_keywords(b))
    
    prev = list(range(n + 1))
    for i in range(1, m + 1):
        curr = [i] + [0] * n
        for j in range(1, n + 1):
            cost = 0 if a[i-1] == b[j-1] else 1
            curr[j] = min(
                curr[j-1] + 1,
                prev[j] + 1,
                prev[j-1] + cost
            )
        prev = curr
    
    distance = prev[n]
    return 1.0 - distance / max(m, n)


class QueryMemory:
    """
    查询记忆引擎
    
    - SQLite 存储（轻量、无外部依赖）
    - 关键词索引 + Jaccard/编辑距离混合相似度
    - 支持注入 BGE embedding 搜索函数
    - 评分 = recency + usage + feedback + similarity
    """

    def __init__(
        self,
        db_path: Optional[str] = None,
        embedding_search_fn: Optional[Any] = None,
    ):
        self.db_path = db_path or ":memory:"
        self.embedding_search_fn = embedding_search_fn
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
        """Close connection only if using file-based DB (not persistent in-memory)"""
        if self._persistent_conn is None:
            conn.close()

    def _init_db(self):
        conn = self._get_conn()
        conn.execute("""
            CREATE TABLE IF NOT EXISTS query_memory (
                id TEXT PRIMARY KEY,
                question TEXT NOT NULL,
                normalized_question TEXT NOT NULL,
                sql TEXT NOT NULL,
                intent TEXT DEFAULT '',
                entities TEXT DEFAULT '{}',
                result_summary TEXT DEFAULT '',
                result_count INTEGER DEFAULT 0,
                success INTEGER DEFAULT 1,
                feedback TEXT,
                feedback_note TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                usage_count INTEGER DEFAULT 0,
                score REAL DEFAULT 1.0
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_normalized ON query_memory(normalized_question)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_intent ON query_memory(intent)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_score ON query_memory(score DESC)")
        conn.commit()
        self._close_if_file(conn)

    def _make_id(self, question: str, sql: str) -> str:
        raw = f"{question}::{sql}"
        return hashlib.md5(raw.encode()).hexdigest()[:16]

    def record(
        self,
        question: str,
        sql: str,
        intent: str = "",
        entities: Optional[dict] = None,
        result_summary: str = "",
        result_count: int = 0,
        success: bool = True,
    ) -> str:
        record_id = self._make_id(question, sql)
        now = datetime.now().isoformat()
        normalized = _normalize_question(question)
        
        conn = self._get_conn()
        existing = conn.execute(
            "SELECT id, usage_count FROM query_memory WHERE id = ?",
            (record_id,)
        ).fetchone()
        
        if existing:
            conn.execute(
                "UPDATE query_memory SET usage_count = usage_count + 1, score = score + 0.1 WHERE id = ?",
                (record_id,)
            )
            conn.commit()
            self._close_if_file(conn)
            return record_id
        
        conn.execute("""
            INSERT INTO query_memory 
            (id, question, normalized_question, sql, intent, entities,
             result_summary, result_count, success, feedback, feedback_note,
             created_at, usage_count, score)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', ?, 0, ?)
        """, (
            record_id, question, normalized, sql, intent,
            json.dumps(entities or {}, ensure_ascii=False),
            result_summary, result_count, 1 if success else 0,
            now, 1.0 if success else 0.5
        ))
        conn.commit()
        self._close_if_file(conn)
        return record_id

    def record_feedback(
        self,
        record_id: str,
        feedback: str,
        note: str = "",
    ):
        if feedback not in ("up", "down"):
            raise ValueError(f"feedback must be 'up' or 'down', got: {feedback}")
        
        conn = self._get_conn()
        row = conn.execute(
            "SELECT score FROM query_memory WHERE id = ?", (record_id,)
        ).fetchone()
        
        if not row:
            self._close_if_file(conn)
            return False
        
        new_score = row["score"]
        if feedback == "up":
            new_score += 1.0
        else:
            new_score -= 0.5
        
        conn.execute(
            "UPDATE query_memory SET feedback = ?, feedback_note = ?, score = ? WHERE id = ?",
            (feedback, note, new_score, record_id)
        )
        conn.commit()
        self._close_if_file(conn)
        return True

    def retrieve_similar(
        self,
        question: str,
        top_k: int = 3,
        min_similarity: float = 0.3,
    ) -> List[QueryRecord]:
        normalized = _normalize_question(question)
        query_keywords = _extract_keywords(question)
        
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM query_memory WHERE success = 1 ORDER BY score DESC LIMIT 500"
        ).fetchall()
        self._close_if_file(conn)
        
        if not rows:
            return []
        
        scored: List[Tuple[float, QueryRecord]] = []
        
        for row in rows:
            record = QueryRecord.from_row(row)
            rec_keywords = _extract_keywords(record.normalized_question)
            kw_sim = _jaccard_similarity(query_keywords, rec_keywords)
            ed_sim = _edit_distance_ratio(normalized, record.normalized_question)
            hybrid_sim = kw_sim * 0.6 + ed_sim * 0.4
            
            if normalized in record.normalized_question or record.normalized_question in normalized:
                hybrid_sim = max(hybrid_sim, 0.7)
            
            if record.feedback == "up":
                hybrid_sim += 0.05
            elif record.feedback == "down":
                hybrid_sim -= 0.1
            
            if hybrid_sim >= min_similarity:
                scored.append((hybrid_sim, record))
        
        scored.sort(key=lambda x: x[0], reverse=True)
        return [r for _, r in scored[:top_k]]

    def get_by_id(self, record_id: str) -> Optional[QueryRecord]:
        conn = self._get_conn()
        row = conn.execute(
            "SELECT * FROM query_memory WHERE id = ?", (record_id,)
        ).fetchone()
        self._close_if_file(conn)
        return QueryRecord.from_row(row) if row else None

    def get_recent(self, limit: int = 10) -> List[QueryRecord]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM query_memory ORDER BY created_at DESC LIMIT ?",
            (limit,)
        ).fetchall()
        self._close_if_file(conn)
        return [QueryRecord.from_row(r) for r in rows]

    def get_statistics(self) -> Dict[str, Any]:
        conn = self._get_conn()
        total = conn.execute("SELECT COUNT(*) as c FROM query_memory").fetchone()["c"]
        success = conn.execute("SELECT COUNT(*) as c FROM query_memory WHERE success = 1").fetchone()["c"]
        up = conn.execute("SELECT COUNT(*) as c FROM query_memory WHERE feedback = 'up'").fetchone()["c"]
        down = conn.execute("SELECT COUNT(*) as c FROM query_memory WHERE feedback = 'down'").fetchone()["c"]
        avg_score = conn.execute("SELECT AVG(score) as s FROM query_memory").fetchone()["s"]
        self._close_if_file(conn)
        
        return {
            "total_records": total,
            "successful": success,
            "success_rate": success / total if total > 0 else 0,
            "thumbs_up": up,
            "thumbs_down": down,
            "avg_score": avg_score or 0,
        }

    def clear(self):
        conn = self._get_conn()
        conn.execute("DELETE FROM query_memory")
        conn.commit()
        self._close_if_file(conn)

    def export_examples(self, limit: int = 50) -> List[dict]:
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM query_memory WHERE success = 1 AND score >= 1.0 ORDER BY score DESC, usage_count DESC LIMIT ?",
            (limit,)
        ).fetchall()
        self._close_if_file(conn)
        
        examples = []
        for row in rows:
            record = QueryRecord.from_row(row)
            examples.append({
                "question": record.question,
                "sql": record.sql,
                "intent": record.intent,
                "entities": record.entities,
            })
        return examples
