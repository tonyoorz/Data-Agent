import re
import hashlib
import glob
import os
import sqlite3
import time
import logging
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

try:
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_similarity as sklearn_cosine_similarity
except Exception:  # pragma: no cover
    TfidfVectorizer = None
    sklearn_cosine_similarity = None

# ---------------------------------------------------------------------------
# Sentence-transformer embedding (preferred, semantic understanding)
# ---------------------------------------------------------------------------
_DEFAULT_EMBEDDING_MODEL_ID = "BAAI/bge-small-zh-v1.5"
_EMBEDDING_CACHE_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "cache", "embedding_models"
)


def _discover_local_embedding_model() -> Optional[str]:
    """Prefer a local model directory when available to avoid network dependency."""
    local_base = os.path.join(_EMBEDDING_CACHE_DIR, "modelscope", "BAAI")
    if not os.path.isdir(local_base):
        return None

    patterns = [
        os.path.join(local_base, "bge-small-zh-v1.5"),
        os.path.join(local_base, "bge-small-zh-v1___5"),
        os.path.join(local_base, "bge-small-zh-v1*"),
    ]
    for pattern in patterns:
        for candidate in sorted(glob.glob(pattern)):
            if os.path.isfile(os.path.join(candidate, "config.json")):
                return candidate
    return None


_DEFAULT_EMBEDDING_MODEL = os.getenv(
    "DUPLICATE_EMBEDDING_MODEL",
    _discover_local_embedding_model() or _DEFAULT_EMBEDDING_MODEL_ID,
)

try:
    from sentence_transformers import SentenceTransformer

    SENTENCE_TRANSFORMER_AVAILABLE = True
except ImportError:
    SentenceTransformer = None
    SENTENCE_TRANSFORMER_AVAILABLE = False

_st_model_instance = None


def _allow_remote_embedding_download() -> bool:
    value = str(os.getenv("DUPLICATE_ALLOW_REMOTE_EMBEDDING_DOWNLOAD") or "").strip().lower()
    return value in {"1", "true", "yes", "on"}


def _resolve_embedding_model_name() -> Optional[str]:
    configured = str(_DEFAULT_EMBEDDING_MODEL or "").strip()
    if not configured:
        return None

    if os.path.isfile(os.path.join(configured, "config.json")):
        return configured

    local_model = _discover_local_embedding_model()
    if local_model:
        return local_model

    if _allow_remote_embedding_download():
        return configured

    logger.info(
        "Skipping remote embedding model load for %s because no local model was found. "
        "Set DUPLICATE_ALLOW_REMOTE_EMBEDDING_DOWNLOAD=1 to enable remote downloads.",
        configured,
    )
    return None


def _get_st_model() -> Any:
    """Lazy-load the sentence-transformer model (singleton)."""
    global _st_model_instance
    if _st_model_instance is not None:
        return _st_model_instance
    if not SENTENCE_TRANSFORMER_AVAILABLE:
        return None

    model_name = _resolve_embedding_model_name()
    if not model_name:
        return None

    try:
        os.makedirs(_EMBEDDING_CACHE_DIR, exist_ok=True)
        _st_model_instance = SentenceTransformer(
            model_name, cache_folder=_EMBEDDING_CACHE_DIR
        )
        logger.info("Loaded embedding model: %s", model_name)
        return _st_model_instance
    except Exception as exc:
        logger.warning("Failed to load embedding model %s: %s", model_name, exc)
        return None


# ---------------------------------------------------------------------------
# SQLite embedding cache
# ---------------------------------------------------------------------------
_DEFAULT_EMBEDDING_DB = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "database", "ticket_embeddings.db"
)

_DDL = """
CREATE TABLE IF NOT EXISTS ticket_embeddings (
    ticket_id   TEXT PRIMARY KEY,
    text_hash   TEXT NOT NULL,
    embedding   BLOB NOT NULL,
    model_name  TEXT NOT NULL,
    updated_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_te_model ON ticket_embeddings(model_name);
"""


class _EmbeddingCache:
    """Lightweight SQLite cache for pre-computed ticket embeddings."""

    def __init__(self, db_path: str = _DEFAULT_EMBEDDING_DB):
        self._db_path = db_path
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        conn = sqlite3.connect(db_path)
        conn.executescript(_DDL)
        conn.close()

    def _conn(self) -> sqlite3.Connection:
        return sqlite3.connect(self._db_path)

    @staticmethod
    def _text_hash(text: str) -> str:
        return hashlib.md5(text.encode("utf-8", errors="replace")).hexdigest()

    def get_many(
        self, ticket_ids: Sequence[str], model_name: str
    ) -> Dict[str, Tuple[str, np.ndarray]]:
        """Return {ticket_id: (text_hash, embedding_vector)} for cached tickets."""
        if not ticket_ids:
            return {}
        conn = self._conn()
        result: Dict[str, Tuple[str, np.ndarray]] = {}
        batch_size = 500
        for start in range(0, len(ticket_ids), batch_size):
            batch = ticket_ids[start : start + batch_size]
            placeholders = ",".join("?" for _ in batch)
            rows = conn.execute(
                f"SELECT ticket_id, text_hash, embedding FROM ticket_embeddings "
                f"WHERE model_name=? AND ticket_id IN ({placeholders})",
                [model_name] + list(batch),
            ).fetchall()
            for tid, thash, blob in rows:
                result[tid] = (thash, np.frombuffer(blob, dtype=np.float32))
        conn.close()
        return result

    def put_many(
        self,
        items: Sequence[Tuple[str, str, np.ndarray]],
        model_name: str,
    ) -> None:
        """Upsert (ticket_id, text_hash, embedding) rows."""
        if not items:
            return
        conn = self._conn()
        now = time.time()
        conn.executemany(
            "INSERT OR REPLACE INTO ticket_embeddings "
            "(ticket_id, text_hash, embedding, model_name, updated_at) "
            "VALUES (?, ?, ?, ?, ?)",
            [
                (tid, thash, vec.astype(np.float32).tobytes(), model_name, now)
                for tid, thash, vec in items
            ],
        )
        conn.commit()
        conn.close()


_embedding_cache_instance: Optional[_EmbeddingCache] = None


def _get_embedding_cache() -> _EmbeddingCache:
    global _embedding_cache_instance
    if _embedding_cache_instance is None:
        _embedding_cache_instance = _EmbeddingCache()
    return _embedding_cache_instance


DEFAULT_EXCLUDED_PHASE_PREFIXES = ("00-", "06-", "09-")
DEFAULT_TEXT_FIELDS = ("name", "description", "comments", "project", "pu", "ecu", "top_aida", "fv", "team", "fvp", "lead_model")


@dataclass(frozen=True)
class DuplicateSearchHints:
    project: Optional[str] = None
    pu: Optional[str] = None
    ecu: Optional[str] = None
    lead_model: Optional[str] = None


@dataclass(frozen=True)
class DuplicateCandidate:
    score_1_10: int
    similarity: float
    ticket_id: Optional[str]
    name: str
    project: Optional[str]
    pu: Optional[str]
    status_phase: Optional[str]
    snippet: str


def _normalize_project(value: Any) -> Optional[str]:
    text = _normalize_text(value).lower()
    return text or None


def _normalize_pu(value: Any) -> Optional[str]:
    text = _normalize_text(value).lower()
    if not text:
        return None
    text = text.replace("/", "-")
    match = re.search(r"\b(\d{2})-(\d{2})\b", text)
    if match:
        return f"{match.group(1)}-{match.group(2)}"
    return text


def _normalize_ecu(value: Any) -> Optional[str]:
    text = _normalize_text(value).lower()
    if not text:
        return None
    text = re.sub(r"\s+", "", text)
    return text.replace("/", "-")


def _normalize_lead_model(value: Any) -> Optional[str]:
    text = _normalize_text(value).lower()
    if not text:
        return None
    return re.sub(r"\s+", "", text)


def _hint_matches(candidate_value: Any, hint_value: Optional[str], normalizer) -> bool:
    if not hint_value:
        return True
    candidate_norm = normalizer(candidate_value)
    if not candidate_norm:
        return True
    hint_norm = normalizer(hint_value)
    if not hint_norm:
        return True
    return hint_norm in candidate_norm


def _hint_matches_strict(candidate_value: Any, hint_value: Optional[str], normalizer) -> bool:
    if not hint_value:
        return False
    candidate_norm = normalizer(candidate_value)
    hint_norm = normalizer(hint_value)
    if not candidate_norm or not hint_norm:
        return False
    return hint_norm in candidate_norm


def _apply_hint_boost(similarity: float, meta: Dict[str, Any], hints: Optional[DuplicateSearchHints]) -> float:
    score = float(similarity)
    if not hints:
        return score

    if hints.project and _hint_matches_strict(meta.get("project"), hints.project, _normalize_project):
        score += 0.08
    if hints.pu and _hint_matches_strict(meta.get("pu"), hints.pu, _normalize_pu):
        score += 0.12
    if hints.ecu and _hint_matches_strict(meta.get("ecu"), hints.ecu, _normalize_ecu):
        score += 0.10
    if hints.lead_model and _hint_matches_strict(meta.get("lead_model"), hints.lead_model, _normalize_lead_model):
        score += 0.05

    return max(0.0, min(1.0, score))


# Known project names ordered longest-first so "idcevo" matches before "idc".
_PROJECT_KEYWORDS: List[Tuple[str, str]] = [
    ("idcevo", "idcevo"),
    ("idc evo", "idcevo"),
    ("idc-evo", "idcevo"),
    ("idevo", "idevo"),
    ("idc", "idc"),
    ("app", "app"),
    ("rsu", "rsu"),
]


def _strip_noise(text: str) -> str:
    """Remove punctuation / special chars that are NOT part of version tokens
    (digits, letters, slashes, hyphens, dots, underscores are kept)."""
    # Keep alphanumeric, space, and version-related separators
    return re.sub(r"[^\w\s/.\-]", " ", text)


def extract_hints(user_text: str) -> DuplicateSearchHints:
    if not user_text:
        return DuplicateSearchHints()

    # 1. Normalise: lowercase + strip noise characters
    text = _strip_noise(user_text.strip().lower())
    # collapse multiple spaces
    text = re.sub(r"\s+", " ", text).strip()

    # 2. Project – longest-match-first scan on the cleaned text
    project = None
    for keyword, canonical in _PROJECT_KEYWORDS:
        if keyword in text:
            project = canonical
            break

    # 3. PU – multi-strategy extraction
    pu = None
    # Strategy A: explicit "PU" prefix with flexible separators/whitespace
    m = re.search(
        r"\bpu\s*[:：=]?\s*(\d{2})\s*[/.\-]\s*(\d{2})\b",
        text, flags=re.IGNORECASE,
    )
    if m:
        pu = f"{m.group(1)}-{m.group(2)}"
    else:
        # Strategy B: bare NN/NN or NN-NN (2-digit pairs)
        m = re.search(r"\b(\d{2})\s*[/.\-]\s*(\d{2})\b", text)
        if m:
            pu = f"{m.group(1)}-{m.group(2)}"
        else:
            # Strategy C: freeform "PU" followed by an identifier like "EE", "HV"
            m = re.search(
                r"\bpu\s*[:：=]?\s*([a-z0-9][a-z0-9._\-]{0,15})\b",
                text, flags=re.IGNORECASE,
            )
            if m:
                pu = _normalize_pu(m.group(1).strip())

    ecu = None
    m = re.search(
        r"\becu\s*[:：=]?\s*([a-z0-9][a-z0-9._/\-]{1,31})\b",
        text,
        flags=re.IGNORECASE,
    )
    if m:
        ecu = _normalize_ecu(m.group(1).strip())

    lead_model = None
    m = re.search(
        r"\blead(?:\s|_)?model\s*[:：=]?\s*([a-z0-9][a-z0-9._/\-]{0,15})\b",
        text,
        flags=re.IGNORECASE,
    )
    if m:
        lead_model = _normalize_lead_model(m.group(1).strip())

    return DuplicateSearchHints(project=project, pu=pu, ecu=ecu, lead_model=lead_model)


def _normalize_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and pd.isna(value):
        return ""
    s = str(value)
    s = s.replace("\r", "\n")
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def _build_document(row: pd.Series, fields: Sequence[str]) -> str:
    parts: List[str] = []
    for f in fields:
        if f not in row:
            continue
        v = _normalize_text(row.get(f))
        if not v:
            continue
        parts.append(v)
    return "\n".join(parts)


def _to_score_1_10(similarity: float) -> int:
    try:
        sim = float(similarity)
    except Exception:
        return 1
    if sim < 0:
        sim = 0.0
    if sim > 1:
        sim = 1.0
    return max(1, min(10, int(round(sim * 9 + 1))))


def _phase_is_excluded(status_phase: Any, excluded_prefixes: Sequence[str]) -> bool:
    s = _normalize_text(status_phase).lower()
    if not s:
        return False
    for prefix in excluded_prefixes:
        p = str(prefix).lower()
        if s.startswith(p):
            return True
    return False


def _safe_snippet(text: Any, max_len: int = 240) -> str:
    s = _normalize_text(text)
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) <= max_len:
        return s
    return s[: max_len - 1] + "…"


def _candidate_snippet(meta: Dict[str, Any]) -> str:
    return _safe_snippet(meta.get("description") or meta.get("comments") or "")


class DuplicateIssueIndex:
    def __init__(
        self,
        excluded_phase_prefixes: Sequence[str] = DEFAULT_EXCLUDED_PHASE_PREFIXES,
        text_fields: Sequence[str] = DEFAULT_TEXT_FIELDS,
    ):
        self.excluded_phase_prefixes = tuple(excluded_phase_prefixes)
        self.text_fields = tuple(text_fields)
        # TF-IDF backend (fallback)
        self._vectorizer = None
        self._matrix = None
        # Embedding backend (preferred)
        self._embedding_matrix: Optional[np.ndarray] = None
        self._use_embeddings = False
        # Shared
        self._meta: List[Dict[str, Any]] = []
        self._documents: List[str] = []
        self._built_at = 0.0
        self._row_count = 0

    @property
    def ready(self) -> bool:
        if self._use_embeddings and self._embedding_matrix is not None and self._meta:
            return True
        return bool(self._vectorizer is not None and self._matrix is not None and self._meta)

    def build_from_df(self, df: pd.DataFrame) -> "DuplicateIssueIndex":
        if df is None or not isinstance(df, pd.DataFrame) or df.empty:
            self._vectorizer = None
            self._matrix = None
            self._embedding_matrix = None
            self._use_embeddings = False
            self._meta = []
            self._documents = []
            self._built_at = time.time()
            self._row_count = 0
            return self

        work = df.copy()
        if "status_phase" in work.columns:
            mask = ~work["status_phase"].apply(lambda x: _phase_is_excluded(x, self.excluded_phase_prefixes))
            work = work[mask]

        work = work.reset_index(drop=True)
        self._row_count = len(work)

        documents = [_build_document(work.iloc[i], self.text_fields) for i in range(len(work))]
        documents = [d if d else _normalize_text(work.iloc[i].get("name") if "name" in work.columns else "") for i, d in enumerate(documents)]
        self._documents = documents

        self._meta = []
        for i in range(len(work)):
            row = work.iloc[i]
            self._meta.append(
                {
                    "ticket_id": _normalize_text(row.get("id")) or _normalize_text(row.get("defect_id")) or None,
                    "name": _normalize_text(row.get("name")) or _normalize_text(row.get("title")) or "",
                    "project": _normalize_text(row.get("project")) or None,
                    "pu": _normalize_text(row.get("pu")) or None,
                    "ecu": _normalize_text(row.get("ecu")) or None,
                    "lead_model": _normalize_text(row.get("lead_model")) or None,
                    "status_phase": _normalize_text(row.get("status_phase")) or None,
                    "description": _normalize_text(row.get("description")) or "",
                    "comments": _normalize_text(row.get("comments")) or "",
                }
            )

        # --- Try sentence-transformer embeddings first ---
        st_model = _get_st_model()
        if st_model is not None:
            try:
                self._build_embedding_index(st_model, documents)
                logger.info(
                    "Built embedding index: %d tickets, model=%s",
                    len(documents), _DEFAULT_EMBEDDING_MODEL,
                )
                self._built_at = time.time()
                return self
            except Exception as exc:
                logger.warning("Embedding index build failed, falling back to TF-IDF: %s", exc)

        # --- Fallback: TF-IDF ---
        self._embedding_matrix = None
        self._use_embeddings = False

        if TfidfVectorizer is None or sklearn_cosine_similarity is None:
            self._vectorizer = None
            self._matrix = None
            self._built_at = time.time()
            return self

        vectorizer = TfidfVectorizer(
            analyzer="char_wb",
            ngram_range=(3, 5),
            max_features=200_000,
            lowercase=True,
        )
        self._matrix = vectorizer.fit_transform(documents)
        self._vectorizer = vectorizer
        self._built_at = time.time()
        return self

    def _build_embedding_index(self, st_model: Any, documents: List[str]) -> None:
        """Build numpy embedding matrix with SQLite cache for incremental updates."""
        cache = _get_embedding_cache()
        model_name = _DEFAULT_EMBEDDING_MODEL

        # Gather ticket IDs and text hashes
        ticket_ids = [m.get("ticket_id") or f"__idx_{i}" for i, m in enumerate(self._meta)]
        text_hashes = [_EmbeddingCache._text_hash(doc) for doc in documents]

        # Load cached embeddings
        cached = cache.get_many(ticket_ids, model_name)

        # Find which tickets need (re-)encoding
        to_encode_indices: List[int] = []
        for i, tid in enumerate(ticket_ids):
            entry = cached.get(tid)
            if entry is None or entry[0] != text_hashes[i]:
                to_encode_indices.append(i)

        # Encode missing/stale tickets
        if to_encode_indices:
            texts_to_encode = [documents[i] for i in to_encode_indices]
            new_vecs = st_model.encode(
                texts_to_encode, batch_size=64, show_progress_bar=False, normalize_embeddings=True,
            )
            # Persist to cache
            items = [
                (ticket_ids[i], text_hashes[i], new_vecs[j])
                for j, i in enumerate(to_encode_indices)
            ]
            cache.put_many(items, model_name)
            # Merge into cached dict
            for j, i in enumerate(to_encode_indices):
                cached[ticket_ids[i]] = (text_hashes[i], new_vecs[j])
            logger.info(
                "Embedding cache: %d cached, %d newly encoded",
                len(ticket_ids) - len(to_encode_indices), len(to_encode_indices),
            )

        # Assemble matrix in original order
        vecs = [cached[tid][1] for tid in ticket_ids]
        self._embedding_matrix = np.vstack(vecs).astype(np.float32)
        self._use_embeddings = True

    def _coarse_search(self, query: str, hints: Optional[DuplicateSearchHints], top_k: int) -> List[DuplicateCandidate]:
        q = _normalize_text(query)
        if not q:
            return []
        if not self.ready:
            return self._keyword_fallback(q, hints=hints, top_k=top_k)

        try:
            if self._use_embeddings and self._embedding_matrix is not None:
                sims = self._embedding_search(q)
            else:
                qv = self._vectorizer.transform([q])
                sims = sklearn_cosine_similarity(self._matrix, qv).reshape(-1)
        except Exception as e:
            logger.warning(f"duplicate search failed, fallback to keyword: {e}")
            return self._keyword_fallback(q, hints=hints, top_k=top_k)

        ranked: List[Tuple[int, float]] = []
        for idx, raw_sim in enumerate(sims):
            meta = self._meta[idx]
            if hints:
                if hints.project and not _hint_matches(meta.get("project"), hints.project, _normalize_project):
                    continue
                if hints.pu and not _hint_matches(meta.get("pu"), hints.pu, _normalize_pu):
                    continue
            ranked.append((idx, _apply_hint_boost(float(raw_sim), meta, hints)))

        ranked.sort(key=lambda x: float(x[1]), reverse=True)
        return self._ranked_to_candidates(ranked, top_k=top_k)

    def _ranked_to_candidates(self, ranked: Sequence[Tuple[int, float]], top_k: int) -> List[DuplicateCandidate]:
        candidates: List[DuplicateCandidate] = []
        for idx, sim in ranked[: max(1, int(top_k))]:
            meta = self._meta[idx]
            candidates.append(
                DuplicateCandidate(
                    score_1_10=_to_score_1_10(float(sim)),
                    similarity=float(sim),
                    ticket_id=meta.get("ticket_id"),
                    name=meta.get("name") or "",
                    project=meta.get("project"),
                    pu=meta.get("pu"),
                    status_phase=meta.get("status_phase"),
                    snippet=_candidate_snippet(meta),
                )
            )
            if len(candidates) >= top_k:
                break
        return candidates

    def search_with_metadata(
        self,
        query: str,
        hints: Optional[DuplicateSearchHints] = None,
        top_k: int = 10,
        reranker: Optional[Any] = None,
        feedback_db_path: Optional[str] = None,
    ) -> Tuple[List[DuplicateCandidate], Dict[str, Any]]:
        candidates = self._coarse_search(query, hints=hints, top_k=max(int(top_k), 50))
        metadata: Dict[str, Any] = {
            "model_phase": "baseline",
            "feedback_count": 0,
        }
        active_reranker = reranker
        if active_reranker is None and feedback_db_path is not None:
            try:
                from progressive_reranker import get_progressive_reranker

                active_reranker = get_progressive_reranker(db_path=feedback_db_path)
            except Exception:
                active_reranker = None
        if active_reranker is not None:
            try:
                candidates = active_reranker.rerank(
                    query,
                    candidates,
                    hints=hints,
                    index=self,
                    top_k=top_k,
                )
                metadata["model_phase"] = str(getattr(active_reranker, "model_phase", "baseline") or "baseline")
                metadata["feedback_count"] = int(getattr(active_reranker, "feedback_count", 0) or 0)
                return candidates[: max(1, int(top_k))], metadata
            except Exception:
                pass
        return candidates[: max(1, int(top_k))], metadata

    def search(self, query: str, hints: Optional[DuplicateSearchHints] = None, top_k: int = 10) -> List[DuplicateCandidate]:
        candidates, _ = self.search_with_metadata(query, hints=hints, top_k=top_k)
        return candidates

    def _embedding_search(self, query_text: str) -> np.ndarray:
        """Encode query and compute cosine similarity against the embedding matrix."""
        st_model = _get_st_model()
        if st_model is None:
            raise RuntimeError("sentence-transformer model not available")
        qvec = st_model.encode(
            [query_text], normalize_embeddings=True, show_progress_bar=False,
        ).astype(np.float32)
        # dot product on L2-normalised vectors == cosine similarity
        return (self._embedding_matrix @ qvec.T).reshape(-1)

    def _keyword_fallback(self, query: str, hints: Optional[DuplicateSearchHints], top_k: int) -> List[DuplicateCandidate]:
        query_l = query.lower()
        scored: List[Tuple[int, float]] = []
        for i, meta in enumerate(self._meta):
            hay = (
                f"{meta.get('name','')}\n"
                f"{meta.get('description','')}\n"
                f"{meta.get('comments','')}\n"
                f"{meta.get('project','')}\n"
                f"{meta.get('pu','')}\n"
                f"{meta.get('ecu','')}\n"
                f"{meta.get('lead_model','')}"
            ).lower()
            if hints:
                if hints.project and not _hint_matches(meta.get("project"), hints.project, _normalize_project):
                    continue
                if hints.pu and not _hint_matches(meta.get("pu"), hints.pu, _normalize_pu):
                    continue
            score = 0
            for token in re.findall(r"[a-z0-9_./-]{3,}", query_l):
                if token in hay:
                    score += 1
            sim = 0.0 if not score else min(1.0, score / 8.0)
            scored.append((i, _apply_hint_boost(sim, meta, hints)))

        scored.sort(key=lambda x: x[1], reverse=True)
        candidates: List[DuplicateCandidate] = []
        for idx, sim in scored[: max(1, int(top_k))]:
            meta = self._meta[idx]
            candidates.append(
                DuplicateCandidate(
                    score_1_10=_to_score_1_10(sim),
                    similarity=sim,
                    ticket_id=meta.get("ticket_id"),
                    name=meta.get("name") or "",
                    project=meta.get("project"),
                    pu=meta.get("pu"),
                    status_phase=meta.get("status_phase"),
                    snippet=_candidate_snippet(meta),
                )
            )
        return candidates


_INDEX_CACHE: Dict[str, DuplicateIssueIndex] = {}


def get_or_build_index_with_metadata(
    cache_key: str,
    df: pd.DataFrame,
    excluded_phase_prefixes: Sequence[str] = DEFAULT_EXCLUDED_PHASE_PREFIXES,
) -> Tuple[DuplicateIssueIndex, Dict[str, Any]]:
    idx = _INDEX_CACHE.get(cache_key)
    cache_hit = bool(
        idx is not None
        and idx.ready
        and tuple(getattr(idx, "excluded_phase_prefixes", ())) == tuple(excluded_phase_prefixes)
    )
    needs_rebuild = not cache_hit

    if idx is None:
        idx = DuplicateIssueIndex(excluded_phase_prefixes=excluded_phase_prefixes)
        _INDEX_CACHE[cache_key] = idx

    if needs_rebuild:
        idx.build_from_df(df if isinstance(df, pd.DataFrame) else pd.DataFrame())

    return idx, {
        "cache_key": cache_key,
        "index_cache_hit": cache_hit,
        "index_rebuilt": needs_rebuild,
        "index_row_count": int(idx._row_count or 0),
    }


def get_or_build_index(cache_key: str, df: pd.DataFrame, excluded_phase_prefixes: Sequence[str] = DEFAULT_EXCLUDED_PHASE_PREFIXES) -> DuplicateIssueIndex:
    idx, _ = get_or_build_index_with_metadata(
        cache_key=cache_key,
        df=df,
        excluded_phase_prefixes=excluded_phase_prefixes,
    )
    return idx

