import re
import hashlib
import glob
import os
import pickle
import sqlite3
import time
import logging
from collections import Counter
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

try:
    import httpx
except Exception:  # pragma: no cover
    httpx = None

logger = logging.getLogger(__name__)

class _SparseMatrix:
    """Small pickle-safe sparse matrix used when scikit-learn is unavailable."""

    def __init__(self, rows: Sequence[Dict[int, float]], feature_count: int):
        self.rows = [dict(row) for row in rows]
        self.shape = (len(self.rows), int(feature_count))


class _FallbackTfidfVectorizer:
    """Dependency-free char n-gram TF-IDF fallback for offline deployments."""

    def __init__(
        self,
        *,
        analyzer: str = "char_wb",
        ngram_range: Tuple[int, int] = (3, 5),
        max_features: int = 200_000,
        lowercase: bool = True,
    ):
        if analyzer != "char_wb":
            raise ValueError("fallback TF-IDF supports only analyzer='char_wb'")
        self.ngram_range = ngram_range
        self.max_features = max(1, int(max_features))
        self.lowercase = bool(lowercase)
        self.vocabulary_: Dict[str, int] = {}
        self.idf_: np.ndarray = np.empty(0, dtype=np.float32)

    def _ngrams(self, value: Any) -> Counter[str]:
        text = str(value or "")
        if self.lowercase:
            text = text.lower()
        counts: Counter[str] = Counter()
        minimum, maximum = self.ngram_range
        for word in re.findall(r"\S+", text):
            padded = f" {word} "
            for size in range(minimum, maximum + 1):
                counts.update(
                    padded[index : index + size]
                    for index in range(max(0, len(padded) - size + 1))
                )
        return counts

    def _transform_counts(self, rows: Sequence[Counter[str]]) -> _SparseMatrix:
        transformed: List[Dict[int, float]] = []
        for counts in rows:
            weights: Dict[int, float] = {}
            for term, count in counts.items():
                index = self.vocabulary_.get(term)
                if index is None:
                    continue
                weights[index] = (1.0 + float(np.log(max(1, count)))) * float(self.idf_[index])
            norm = float(np.sqrt(sum(weight * weight for weight in weights.values())))
            if norm > 0:
                weights = {index: weight / norm for index, weight in weights.items()}
            transformed.append(weights)
        return _SparseMatrix(transformed, len(self.vocabulary_))

    def fit_transform(self, values: Sequence[Any]) -> _SparseMatrix:
        rows = [self._ngrams(value) for value in values]
        document_frequency: Counter[str] = Counter()
        for counts in rows:
            document_frequency.update(counts.keys())
        ranked_terms = sorted(
            document_frequency,
            key=lambda term: (-document_frequency[term], term),
        )[: self.max_features]
        self.vocabulary_ = {term: index for index, term in enumerate(ranked_terms)}
        document_count = max(1, len(rows))
        self.idf_ = np.asarray(
            [
                np.log((1.0 + document_count) / (1.0 + document_frequency[term])) + 1.0
                for term in ranked_terms
            ],
            dtype=np.float32,
        )
        return self._transform_counts(rows)

    def transform(self, values: Sequence[Any]) -> _SparseMatrix:
        return self._transform_counts([self._ngrams(value) for value in values])


def _fallback_cosine_similarity(left: _SparseMatrix, right: _SparseMatrix) -> np.ndarray:
    similarities = np.zeros((len(left.rows), len(right.rows)), dtype=np.float32)
    for left_index, left_row in enumerate(left.rows):
        for right_index, right_row in enumerate(right.rows):
            smaller, larger = (
                (left_row, right_row)
                if len(left_row) <= len(right_row)
                else (right_row, left_row)
            )
            similarities[left_index, right_index] = sum(
                weight * larger.get(feature, 0.0)
                for feature, weight in smaller.items()
            )
    return similarities


try:
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_similarity as sklearn_cosine_similarity
except Exception:  # pragma: no cover
    TfidfVectorizer = _FallbackTfidfVectorizer
    sklearn_cosine_similarity = _fallback_cosine_similarity

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
_REMOTE_EMBEDDING_URL = os.getenv("DUPLICATE_REMOTE_EMBEDDING_URL", "").strip()
_REMOTE_EMBEDDING_MODEL = os.getenv("DUPLICATE_REMOTE_EMBEDDING_MODEL", "qwen3-embedding-8b").strip()
_REMOTE_EMBEDDING_AUTHORIZATION = os.getenv("DUPLICATE_REMOTE_EMBEDDING_AUTHORIZATION", "").strip()
_REMOTE_EMBEDDING_TIMEOUT_SECONDS = float(
    os.getenv("DUPLICATE_REMOTE_EMBEDDING_TIMEOUT_SECONDS", "15").strip() or "15"
)
_RRF_K = 60

def _retrieval_weights_for_query(query: str) -> Tuple[float, float]:
    text = _normalize_text(query).lower()
    if not text:
        return 1.0, 1.0

    identifier_score = 0
    if re.search(r"\b\d{4}[-/]\d{2}[-/]\d{2}\b", text):
        identifier_score += 2
    if re.search(r"\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b", text):
        identifier_score += 1
    if re.search(r"\b[a-z][a-z0-9_.-]{1,40}\s*=\s*[^\s]+", text):
        identifier_score += 2
    if re.search(r"\b(?:dtc|trace|logs?|exception|timeout|payload|coredump)\b", text):
        identifier_score += 1
    if re.search(r"\b\d{2}\s*[/.-]\s*\d{2}\b|\b\d{2}w\d{2}(?:\.\d+)?\b", text):
        identifier_score += 1

    if identifier_score >= 2:
        return 0.75, 2.0
    return 1.0, 1.0

try:
    from sentence_transformers import SentenceTransformer

    SENTENCE_TRANSFORMER_AVAILABLE = True
except Exception:
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


def _get_remote_embedding_config() -> Optional[Dict[str, Any]]:
    if not httpx or not _REMOTE_EMBEDDING_URL or not _REMOTE_EMBEDDING_AUTHORIZATION or not _REMOTE_EMBEDDING_MODEL:
        return None
    return {
        "url": _REMOTE_EMBEDDING_URL,
        "authorization": _REMOTE_EMBEDDING_AUTHORIZATION,
        "model": _REMOTE_EMBEDDING_MODEL,
        "timeout": _REMOTE_EMBEDDING_TIMEOUT_SECONDS,
    }


def _extract_remote_embeddings(payload: Any) -> List[np.ndarray]:
    if not isinstance(payload, dict):
        raise RuntimeError("remote embedding response is not a JSON object")

    candidates = payload.get("data")
    if isinstance(candidates, list):
        vectors: List[np.ndarray] = []
        for item in candidates:
            if isinstance(item, dict) and isinstance(item.get("embedding"), list):
                vectors.append(np.asarray(item["embedding"], dtype=np.float32))
        if vectors:
            return vectors
    if isinstance(candidates, dict) and isinstance(candidates.get("embedding"), list):
        return [np.asarray(candidates["embedding"], dtype=np.float32)]
    if isinstance(payload.get("embedding"), list):
        return [np.asarray(payload["embedding"], dtype=np.float32)]

    raise RuntimeError("remote embedding response does not contain embeddings")


def _encode_remote_embeddings(texts: Sequence[str], model_name: Optional[str] = None) -> np.ndarray:
    config = _get_remote_embedding_config()
    if not config:
        raise RuntimeError("remote embedding is not configured")
    if not texts:
        return np.empty((0, 0), dtype=np.float32)

    vectors: List[np.ndarray] = []
    with httpx.Client(timeout=float(config["timeout"])) as client:
        for text in texts:
            response = client.post(
                str(config["url"]),
                headers={
                    "accept": "application/json",
                    "Authorization": str(config["authorization"]),
                    "Content-Type": "application/json",
                },
                json={
                    "model": model_name or str(config["model"]),
                    "input": str(text),
                },
            )
            response.raise_for_status()
            batch_vectors = _extract_remote_embeddings(response.json())
            if len(batch_vectors) != 1:
                raise RuntimeError("remote embedding returned an unexpected batch size")
            vectors.append(batch_vectors[0])

    return np.vstack(vectors).astype(np.float32)


# ---------------------------------------------------------------------------
# SQLite embedding cache
# ---------------------------------------------------------------------------
_DEFAULT_EMBEDDING_DB = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "database", "ticket_embeddings.db"
)
_INDEX_SNAPSHOT_DIR = os.getenv(
    "DUPLICATE_INDEX_SNAPSHOT_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache", "index_snapshots"),
)
_INDEX_SNAPSHOT_VERSION = "v2"

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
DEFAULT_TEXT_FIELDS = ("name", "description", "search_comments", "comments", "project", "pu", "ecu", "top_aida", "fv", "team", "fvp", "lead_model")


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
    evidence_snippets: List[str]
    ranking_signals: Dict[str, Any]


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


def _normalize_evidence_snippets(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, float) and pd.isna(value):
        return []
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        snippets = [_normalize_text(item) for item in value]
        return [snippet for snippet in snippets if snippet]
    text = _normalize_text(value)
    return [text] if text else []


def _has_field(source: Any, field_name: str) -> bool:
    if isinstance(source, pd.Series):
        return field_name in source.index
    if isinstance(source, dict):
        return field_name in source
    return False


def _searchable_comment_text(source: Any) -> str:
    if _has_field(source, "search_comments"):
        return _normalize_text(source.get("search_comments"))
    return _normalize_text(source.get("comments"))


def _build_document(row: pd.Series, fields: Sequence[str]) -> str:
    parts: List[str] = []
    include_search_comments = "search_comments" in fields
    search_comments = _searchable_comment_text(row)
    comments = _normalize_text(row.get("comments"))
    for f in fields:
        if f == "search_comments":
            v = search_comments
        elif f == "comments":
            if include_search_comments:
                continue
            v = comments
        else:
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


def _rank_bonus(rank: Any, *, strong_rank: int, weak_rank: int) -> float:
    try:
        value = int(rank)
    except Exception:
        return 0.0
    if value <= strong_rank:
        return 0.8
    if value <= weak_rank:
        return 0.35
    return 0.0


def calibrate_duplicate_confidence(
    *,
    similarity: float,
    ranking_signals: Optional[Dict[str, Any]] = None,
    evidence_snippets: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    """Convert retrieval/rerank signals into a user-facing duplicate confidence.

    This is a deterministic calibration layer, not a probability model. It keeps
    the useful 1-10 gradient while avoiding the misleading raw linear mapping
    from cosine/RRF-derived similarity to business confidence.
    """
    try:
        sim = max(0.0, min(1.0, float(similarity)))
    except Exception:
        sim = 0.0
    signals = ranking_signals or {}
    evidence = [str(item or "").strip() for item in list(evidence_snippets or []) if str(item or "").strip()]

    confidence = 1.0 + (sim * 6.0)
    confidence += _rank_bonus(signals.get("dense_rank"), strong_rank=5, weak_rank=20)
    confidence += _rank_bonus(signals.get("sparse_rank"), strong_rank=5, weak_rank=20)
    if signals.get("dense_rank") is not None and signals.get("sparse_rank") is not None:
        confidence += 0.5
    if evidence:
        confidence += 0.7

    score = max(1, min(10, int(round(confidence))))
    if score >= 8:
        label = "high"
    elif score >= 6:
        label = "medium"
    elif score >= 4:
        label = "low"
    else:
        label = "review"
    return {"score": score, "label": label}


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


def _first_evidence_snippet(meta: Dict[str, Any]) -> str:
    snippets = _normalize_evidence_snippets(meta.get("evidence_snippets"))
    return snippets[0] if snippets else ""


def _candidate_snippet(meta: Dict[str, Any]) -> str:
    return _safe_snippet(
        meta.get("description")
        or _first_evidence_snippet(meta)
        or _searchable_comment_text(meta)
        or ""
    )


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
        self._embedding_backend: Optional[str] = None
        self._embedding_model_name: Optional[str] = None
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
            self._embedding_backend = None
            self._embedding_model_name = None
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
            meta = {
                "ticket_id": _normalize_text(row.get("id")) or _normalize_text(row.get("defect_id")) or None,
                "name": _normalize_text(row.get("name")) or _normalize_text(row.get("title")) or "",
                "project": _normalize_text(row.get("project")) or None,
                "pu": _normalize_text(row.get("pu")) or None,
                "ecu": _normalize_text(row.get("ecu")) or None,
                "lead_model": _normalize_text(row.get("lead_model")) or None,
                "status_phase": _normalize_text(row.get("status_phase")) or None,
                "description": _normalize_text(row.get("description")) or "",
                "comments": _normalize_text(row.get("comments")) or "",
                "evidence_snippets": _normalize_evidence_snippets(row.get("evidence_snippets")),
            }
            if "search_comments" in work.columns:
                meta["search_comments"] = _normalize_text(row.get("search_comments"))
            self._meta.append(meta)

        embedding_built = False

        # --- Try sentence-transformer embeddings first ---
        st_model = _get_st_model()
        if st_model is not None:
            try:
                model_name = _resolve_embedding_model_name() or _DEFAULT_EMBEDDING_MODEL
                self._build_embedding_index(
                    documents,
                    model_name=model_name,
                    encoder=lambda values: st_model.encode(
                        list(values),
                        batch_size=64,
                        show_progress_bar=False,
                        normalize_embeddings=True,
                    ),
                    backend_name="local",
                )
                logger.info(
                    "Built embedding index: %d tickets, model=%s",
                    len(documents), model_name,
                )
                embedding_built = True
            except Exception as exc:
                logger.warning("Embedding index build failed, continuing with sparse retrieval only: %s", exc)

        remote_config = _get_remote_embedding_config()
        if not embedding_built and remote_config is not None:
            try:
                model_name = str(remote_config["model"])
                self._build_embedding_index(
                    documents,
                    model_name=model_name,
                    encoder=lambda values: _encode_remote_embeddings(values, model_name=model_name),
                    backend_name="remote",
                )
                logger.info(
                    "Built remote embedding index: %d tickets, model=%s",
                    len(documents), model_name,
                )
                embedding_built = True
            except Exception as exc:
                logger.warning("Remote embedding index build failed, continuing with sparse retrieval only: %s", exc)

        # --- Sparse index for hybrid retrieval (and fallback when embeddings are unavailable) ---
        if not embedding_built:
            self._embedding_matrix = None
            self._use_embeddings = False
            self._embedding_backend = None
            self._embedding_model_name = None

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

    def _build_embedding_index(
        self,
        documents: List[str],
        model_name: str,
        encoder: Any,
        backend_name: str,
    ) -> None:
        """Build numpy embedding matrix with SQLite cache for incremental updates."""
        cache = _get_embedding_cache()

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
            new_vecs = encoder(texts_to_encode)
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
        self._embedding_backend = backend_name
        self._embedding_model_name = model_name

    def _coarse_search(self, query: str, hints: Optional[DuplicateSearchHints], top_k: int) -> List[DuplicateCandidate]:
        q = _normalize_text(query)
        if not q:
            return []
        if not self.ready:
            return self._keyword_fallback(q, hints=hints, top_k=top_k)

        try:
            dense_ranked: List[Tuple[int, float]] = []
            sparse_ranked: List[Tuple[int, float]] = []

            if self._use_embeddings and self._embedding_matrix is not None:
                dense_ranked = self._rank_similarities(self._embedding_search(q), hints=hints)
            if self._vectorizer is not None and self._matrix is not None:
                qv = self._vectorizer.transform([q])
                sparse_sims = sklearn_cosine_similarity(self._matrix, qv).reshape(-1)
                sparse_ranked = self._rank_similarities(sparse_sims, hints=hints)
        except Exception as e:
            logger.warning(f"duplicate search failed, fallback to keyword: {e}")
            return self._keyword_fallback(q, hints=hints, top_k=top_k)

        rank_signals: Dict[int, Dict[str, Any]] = {}
        if dense_ranked and sparse_ranked:
            dense_weight, sparse_weight = _retrieval_weights_for_query(q)
            rank_signals = self._build_rank_signals(
                dense_ranked,
                sparse_ranked,
                dense_weight=dense_weight,
                sparse_weight=sparse_weight,
                top_k=max(50, int(top_k) * 5),
            )
            ranked = self._fuse_ranked_lists_rrf(
                dense_ranked,
                sparse_ranked,
                top_k=max(50, int(top_k) * 5),
                dense_weight=dense_weight,
                sparse_weight=sparse_weight,
            )
        elif dense_ranked:
            ranked = dense_ranked
        elif sparse_ranked:
            ranked = sparse_ranked
        else:
            return self._keyword_fallback(q, hints=hints, top_k=top_k)

        return self._ranked_to_candidates(ranked, top_k=top_k, rank_signals=rank_signals)

    def _rank_similarities(
        self,
        similarities: Sequence[float],
        hints: Optional[DuplicateSearchHints],
    ) -> List[Tuple[int, float]]:
        ranked: List[Tuple[int, float]] = []
        for idx, raw_sim in enumerate(similarities):
            meta = self._meta[idx]
            if hints:
                if hints.project and not _hint_matches(meta.get("project"), hints.project, _normalize_project):
                    continue
                if hints.pu and not _hint_matches(meta.get("pu"), hints.pu, _normalize_pu):
                    continue
            ranked.append((idx, _apply_hint_boost(float(raw_sim), meta, hints)))
        ranked.sort(key=lambda item: float(item[1]), reverse=True)
        return ranked

    def _fuse_ranked_lists_rrf(
        self,
        dense_ranked: Sequence[Tuple[int, float]],
        sparse_ranked: Sequence[Tuple[int, float]],
        top_k: int,
        rrf_k: int = _RRF_K,
        dense_weight: float = 1.0,
        sparse_weight: float = 1.0,
    ) -> List[Tuple[int, float]]:
        fused_scores: Dict[int, float] = {}
        best_similarity: Dict[int, float] = {}

        for ranked, weight in ((dense_ranked, dense_weight), (sparse_ranked, sparse_weight)):
            for rank, (idx, similarity) in enumerate(ranked[: max(1, int(top_k))], start=1):
                fused_scores[idx] = fused_scores.get(idx, 0.0) + (float(weight) / float(rrf_k + rank))
                best_similarity[idx] = max(best_similarity.get(idx, float("-inf")), float(similarity))

        ranked_indices = sorted(
            fused_scores.items(),
            key=lambda item: (float(item[1]), float(best_similarity.get(item[0], 0.0))),
            reverse=True,
        )
        return [
            (idx, float(best_similarity.get(idx, 0.0)))
            for idx, _ in ranked_indices[: max(1, int(top_k))]
        ]

    def _build_rank_signals(
        self,
        dense_ranked: Sequence[Tuple[int, float]],
        sparse_ranked: Sequence[Tuple[int, float]],
        dense_weight: float,
        sparse_weight: float,
        top_k: int,
    ) -> Dict[int, Dict[str, Any]]:
        signals: Dict[int, Dict[str, Any]] = {}
        limit = max(1, int(top_k))
        for source_name, ranked in (("dense", dense_ranked), ("sparse", sparse_ranked)):
            for rank, (idx, score) in enumerate(ranked[:limit], start=1):
                current = signals.setdefault(
                    idx,
                    {
                        "dense_rank": None,
                        "dense_score": None,
                        "sparse_rank": None,
                        "sparse_score": None,
                        "dense_weight": float(dense_weight),
                        "sparse_weight": float(sparse_weight),
                    },
                )
                current[f"{source_name}_rank"] = int(rank)
                current[f"{source_name}_score"] = float(score)
        return signals

    def _ranked_to_candidates(
        self,
        ranked: Sequence[Tuple[int, float]],
        top_k: int,
        rank_signals: Optional[Dict[int, Dict[str, Any]]] = None,
    ) -> List[DuplicateCandidate]:
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
                    evidence_snippets=_normalize_evidence_snippets(meta.get("evidence_snippets")),
                    ranking_signals=dict((rank_signals or {}).get(idx) or {}),
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
        if self._embedding_backend == "remote":
            if not self._embedding_model_name:
                raise RuntimeError("remote embedding model is not configured")
            qvec = _encode_remote_embeddings([query_text], model_name=self._embedding_model_name)
        else:
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
            comment_text = _searchable_comment_text(meta)
            hay = (
                f"{meta.get('name','')}\n"
                f"{meta.get('description','')}\n"
                f"{comment_text}\n"
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
                    evidence_snippets=_normalize_evidence_snippets(meta.get("evidence_snippets")),
                    ranking_signals={},
                )
            )
        return candidates

    def snapshot_state(self) -> Dict[str, Any]:
        return {
            "snapshot_version": _INDEX_SNAPSHOT_VERSION,
            "excluded_phase_prefixes": tuple(self.excluded_phase_prefixes),
            "text_fields": tuple(self.text_fields),
            "vectorizer": self._vectorizer,
            "matrix": self._matrix,
            "embedding_matrix": self._embedding_matrix,
            "use_embeddings": bool(self._use_embeddings),
            "embedding_backend": self._embedding_backend,
            "embedding_model_name": self._embedding_model_name,
            "meta": list(self._meta),
            "documents": list(self._documents),
            "built_at": float(self._built_at),
            "row_count": int(self._row_count),
        }

    def load_snapshot_state(self, state: Dict[str, Any]) -> "DuplicateIssueIndex":
        self.excluded_phase_prefixes = tuple(state.get("excluded_phase_prefixes") or self.excluded_phase_prefixes)
        self.text_fields = tuple(state.get("text_fields") or self.text_fields)
        self._vectorizer = state.get("vectorizer")
        self._matrix = state.get("matrix")
        self._embedding_matrix = state.get("embedding_matrix")
        self._use_embeddings = bool(state.get("use_embeddings"))
        self._embedding_backend = state.get("embedding_backend")
        self._embedding_model_name = state.get("embedding_model_name")
        self._meta = list(state.get("meta") or [])
        self._documents = list(state.get("documents") or [])
        self._built_at = float(state.get("built_at") or time.time())
        self._row_count = int(state.get("row_count") or len(self._meta))
        return self


_INDEX_CACHE: Dict[str, DuplicateIssueIndex] = {}


def _build_index_snapshot_path(
    cache_key: str,
    excluded_phase_prefixes: Sequence[str],
    text_fields: Sequence[str],
) -> str:
    identity = "|".join(
        [
            _INDEX_SNAPSHOT_VERSION,
            str(cache_key),
            ",".join(excluded_phase_prefixes),
            ",".join(text_fields),
            str(_DEFAULT_EMBEDDING_MODEL or ""),
            str(_REMOTE_EMBEDDING_URL or ""),
            str(_REMOTE_EMBEDDING_MODEL or ""),
        ]
    )
    file_name = f"{hashlib.md5(identity.encode('utf-8', errors='replace')).hexdigest()}.pkl"
    return os.path.join(_INDEX_SNAPSHOT_DIR, file_name)


def _load_index_snapshot(snapshot_path: str) -> Optional[Dict[str, Any]]:
    if not snapshot_path or not os.path.isfile(snapshot_path):
        return None
    try:
        with open(snapshot_path, "rb") as handle:
            state = pickle.load(handle)
    except Exception as exc:
        logger.warning("Failed to load duplicate index snapshot %s: %s", snapshot_path, exc)
        return None
    if not isinstance(state, dict):
        return None
    if str(state.get("snapshot_version") or "") != _INDEX_SNAPSHOT_VERSION:
        return None
    return state


def _save_index_snapshot(snapshot_path: str, index: DuplicateIssueIndex) -> None:
    if not snapshot_path:
        return
    try:
        os.makedirs(os.path.dirname(snapshot_path), exist_ok=True)
        with open(snapshot_path, "wb") as handle:
            pickle.dump(index.snapshot_state(), handle, protocol=pickle.HIGHEST_PROTOCOL)
    except Exception as exc:
        logger.warning("Failed to save duplicate index snapshot %s: %s", snapshot_path, exc)


def get_or_build_index_with_metadata(
    cache_key: str,
    df: pd.DataFrame,
    excluded_phase_prefixes: Sequence[str] = DEFAULT_EXCLUDED_PHASE_PREFIXES,
    build_if_missing: bool = True,
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

    snapshot_path = _build_index_snapshot_path(
        cache_key=cache_key,
        excluded_phase_prefixes=excluded_phase_prefixes,
        text_fields=getattr(idx, "text_fields", DEFAULT_TEXT_FIELDS),
    )
    disk_cache_hit = False

    if needs_rebuild:
        snapshot_state = _load_index_snapshot(snapshot_path)
        if snapshot_state is not None:
            idx.load_snapshot_state(snapshot_state)
            disk_cache_hit = True
        else:
            if build_if_missing:
                idx.build_from_df(df if isinstance(df, pd.DataFrame) else pd.DataFrame())
                _save_index_snapshot(snapshot_path, idx)

    return idx, {
        "cache_key": cache_key,
        "index_cache_hit": cache_hit,
        "index_disk_cache_hit": disk_cache_hit,
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
