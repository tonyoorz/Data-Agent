"""
OntologyEmbeddingResolver — embedding-based phrase matching for ontology terms.

Uses sentence-transformer (BGE) or remote embedding endpoints to compute
semantic similarity between user input and ontology vocabulary phrases.

Falls back to the existing string-based OntologyTermResolver when no
embedding backend is available.

Architecture:
    compile time:  all phrases → embeddings → in-memory matrix
    runtime:       user text → embedding → cosine sim → top-K matches
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any, Sequence

import numpy as np

from backend.analytics.ontology import OntologyCatalog, OntologyLoadError, load_ontology
from backend.analytics.ontology_term_resolver import OntologyTermResolver, TermMatch

logger = logging.getLogger(__name__)

# ─── Embedding backend configuration ───────────────────────────────────────

_DEFAULT_MODEL_ID = "BAAI/bge-small-zh-v1.5"
_EMBEDDING_CACHE_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "cache", "embedding_models"
)
_REMOTE_EMBEDDING_URL = os.getenv("ONTOLOGY_REMOTE_EMBEDDING_URL", "").strip()
_REMOTE_EMBEDDING_MODEL = os.getenv("ONTOLOGY_REMOTE_EMBEDDING_MODEL", "qwen3-embedding-8b").strip()
_REMOTE_EMBEDDING_AUTH = os.getenv("ONTOLOGY_REMOTE_EMBEDDING_AUTH", "").strip()
_SIMILARITY_THRESHOLD = float(os.getenv("ONTOLOGY_EMBEDDING_THRESHOLD", "0.75"))
_TOP_K = int(os.getenv("ONTOLOGY_EMBEDDING_TOP_K", "10"))

# Lazy-loaded model instance
_st_model_instance: Any = None


def _discover_local_model() -> str | None:
    """Find local BGE model directory to avoid network dependency."""
    import glob

    local_base = os.path.join(_EMBEDDING_CACHE_DIR, "modelscope", "BAAI")
    if not os.path.isdir(local_base):
        return None
    for pattern in [
        os.path.join(local_base, "bge-small-zh-v1.5"),
        os.path.join(local_base, "bge-small-zh-v1___5"),
        os.path.join(local_base, "bge-small-zh-v1*"),
    ]:
        for candidate in sorted(glob.glob(pattern)):
            if os.path.isfile(os.path.join(candidate, "config.json")):
                return candidate
    return None


def _get_model_name() -> str:
    return os.getenv(
        "ONTOLOGY_EMBEDDING_MODEL",
        _discover_local_model() or _DEFAULT_MODEL_ID,
    )


def _load_sentence_transformer():
    """Load sentence-transformer model (lazy, singleton)."""
    global _st_model_instance
    if _st_model_instance is not None:
        return _st_model_instance
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        logger.warning("sentence-transformers not installed; embedding resolver will use remote or fall back")
        return None
    model_name = _get_model_name()
    try:
        _st_model_instance = SentenceTransformer(
            model_name,
            cache_folder=_EMBEDDING_CACHE_DIR,
            device="cpu",
        )
        logger.info("Loaded embedding model: %s", model_name)
        return _st_model_instance
    except Exception as exc:
        logger.warning("Failed to load embedding model %s: %s", model_name, exc)
        return None


def _remote_embed(texts: Sequence[str]) -> np.ndarray | None:
    """Call remote embedding API for batch encoding."""
    if not _REMOTE_EMBEDDING_URL or not texts:
        return None
    try:
        import httpx
    except ImportError:
        return None

    headers = {"Content-Type": "application/json"}
    if _REMOTE_EMBEDDING_AUTH:
        headers["Authorization"] = _REMOTE_EMBEDDING_AUTH

    payload = {"model": _REMOTE_EMBEDDING_MODEL, "input": list(texts)}
    try:
        resp = httpx.post(
            _REMOTE_EMBEDDING_URL,
            json=payload,
            headers=headers,
            timeout=30.0,
        )
        resp.raise_for_status()
        data = resp.json()
        embeddings = []
        for item in data.get("data", []):
            embeddings.append(item["embedding"])
        if embeddings:
            return np.array(embeddings, dtype=np.float32)
    except Exception as exc:
        logger.warning("Remote embedding failed: %s", exc)
    return None


def encode_texts(texts: list[str]) -> np.ndarray | None:
    """Encode a batch of texts into embeddings.

    Tries: local sentence-transformer → remote API → None (fallback).
    """
    if not texts:
        return np.array([], dtype=np.float32)

    # Try local model first
    model = _load_sentence_transformer()
    if model is not None:
        try:
            vecs = model.encode(texts, show_progress_bar=False, normalize_embeddings=True)
            return np.array(vecs, dtype=np.float32)
        except Exception as exc:
            logger.warning("Local embedding encode failed: %s", exc)

    # Try remote
    result = _remote_embed(texts)
    if result is not None:
        return result

    return None


# ─── Data structures ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class EmbeddingTermMatch:
    """A semantic match between user text and an ontology term."""

    term_id: str
    phrase: str
    kind: str
    resolution: dict[str, Any]
    similarity: float  # cosine similarity in [0, 1]
    matched_text: str  # the user text segment that matched


@dataclass
class EmbeddingIndex:
    """Pre-computed embedding index for all ontology phrases."""

    phrases: list[str]  # aligned with rows of `embeddings`
    term_ids: list[str]  # aligned term ids
    kinds: list[str]  # aligned term kinds
    resolutions: list[dict]  # aligned resolutions
    embeddings: np.ndarray | None = None  # shape (N, D) or None
    fingerprint: str = ""

    @property
    def is_ready(self) -> bool:
        return self.embeddings is not None and len(self.phrases) > 0


# ─── Resolver ──────────────────────────────────────────────────────────────


class OntologyEmbeddingResolver:
    """Resolve free-text to ontology terms using embedding similarity.

    Falls back to string-based OntologyTermResolver when embeddings
    are unavailable.
    """

    def __init__(self, catalog: OntologyCatalog | None = None):
        try:
            self._catalog = catalog or load_ontology()
        except OntologyLoadError:
            self._catalog = None

        self._string_resolver = OntologyTermResolver(self._catalog)
        self._index: EmbeddingIndex | None = None
        self._index_fingerprint: str = ""

    # ── Index management ────────────────────────────────────────────────

    @property
    def catalog_fingerprint(self) -> str:
        if self._catalog is None:
            return ""
        return self._catalog.fingerprint

    def _build_index(self) -> EmbeddingIndex:
        """Build embedding index from all ontology phrases."""
        if self._catalog is None:
            return EmbeddingIndex(phrases=[], term_ids=[], kinds=[], resolutions=[])

        terms = self._catalog.bundle.get("terms", [])
        phrases: list[str] = []
        term_ids: list[str] = []
        kinds: list[str] = []
        resolutions: list[dict] = []

        for term in terms:
            gov = term.get("governance", {})
            if gov.get("status") not in (None, "approved"):
                continue
            for phrase in term.get("phrases", []):
                if not phrase.strip():
                    continue
                phrases.append(phrase)
                term_ids.append(term.get("id", ""))
                kinds.append(term.get("kind", "synonym"))
                resolutions.append(term.get("resolution", {}))

        # Also add entity aliases and labels
        for entity in self._catalog.bundle.get("entities", []):
            eid = entity.get("id", "")
            labels = entity.get("labels", {})
            for lang, label in labels.items():
                if label and label not in phrases:
                    phrases.append(label)
                    term_ids.append(eid)
                    kinds.append("entity_label")
                    resolutions.append({"entityId": eid})
            for alias in entity.get("aliases", []):
                if alias and alias not in phrases:
                    phrases.append(alias)
                    term_ids.append(eid)
                    kinds.append("entity_alias")
                    resolutions.append({"entityId": eid})

        # Also add metric labels
        for metric in self._catalog.bundle.get("metrics", []):
            mid = metric.get("id", "")
            labels = metric.get("labels", {})
            for lang, label in labels.items():
                if label and label not in phrases:
                    phrases.append(label)
                    term_ids.append(mid)
                    kinds.append("metric_label")
                    resolutions.append({"metricId": mid})

        # Compute embeddings
        embeddings = encode_texts(phrases) if phrases else None

        # Fingerprint for cache invalidation
        fp_source = f"{self.catalog_fingerprint}:{len(phrases)}"
        fingerprint = hashlib.sha256(fp_source.encode()).hexdigest()[:16]

        return EmbeddingIndex(
            phrases=phrases,
            term_ids=term_ids,
            kinds=kinds,
            resolutions=resolutions,
            embeddings=embeddings,
            fingerprint=fingerprint,
        )

    @property
    def index(self) -> EmbeddingIndex:
        """Lazily build and cache the embedding index."""
        if self._index is None or self._index.fingerprint != self._index_fingerprint:
            self._index = self._build_index()
            self._index_fingerprint = self._index.fingerprint
            if self._index.is_ready:
                logger.info(
                    "OntologyEmbeddingResolver: indexed %d phrases (dim=%d)",
                    len(self._index.phrases),
                    self._index.embeddings.shape[1] if self._index.embeddings is not None else 0,
                )
            else:
                logger.info(
                    "OntologyEmbeddingResolver: %d phrases indexed (no embedding backend, will fall back)",
                    len(self._index.phrases),
                )
        return self._index

    # ── Core resolve ────────────────────────────────────────────────────

    def resolve(self, text: str, *, top_k: int = _TOP_K) -> list[EmbeddingTermMatch]:
        """Resolve user text to ontology terms via embedding similarity.

        Args:
            text: User's natural language query
            top_k: Maximum number of matches to return

        Returns:
            List of EmbeddingTermMatch sorted by similarity descending.
        """
        if not text.strip():
            return []

        idx = self.index
        if not idx.is_ready:
            # Cannot do embedding matching — the string resolver handles it
            return []

        # Embed user text
        user_vec = encode_texts([text])
        if user_vec is None or len(user_vec) == 0:
            return []

        user_emb = user_vec[0]  # shape (D,)
        phrase_embs = idx.embeddings  # shape (N, D)

        # Cosine similarity (embeddings are already normalized if from BGE)
        similarities = phrase_embs @ user_emb  # shape (N,)

        # Filter by threshold and take top-K
        mask = similarities >= _SIMILARITY_THRESHOLD
        if not mask.any():
            return []

        top_indices = np.argsort(similarities)[::-1][:top_k]

        results: list[EmbeddingTermMatch] = []
        for i in top_indices:
            if similarities[i] < _SIMILARITY_THRESHOLD:
                break
            results.append(EmbeddingTermMatch(
                term_id=idx.term_ids[i],
                phrase=idx.phrases[i],
                kind=idx.kinds[i],
                resolution=idx.resolutions[i],
                similarity=round(float(similarities[i]), 4),
                matched_text=text,
            ))

        return results

    # ── Hybrid resolve: embedding + string ─────────────────────────────

    def resolve_hybrid(self, text: str, *, top_k: int = _TOP_K) -> list[EmbeddingTermMatch | TermMatch]:
        """Combine embedding matches with string matches.

        String matches are always included (high precision).
        Embedding matches fill in semantic near-misses.
        """
        # String matches first (high precision)
        string_matches = self._string_resolver.resolve(text)

        # Embedding matches
        emb_matches = self.resolve(text, top_k=top_k * 2)

        # Merge: deduplicate by term_id, prefer string matches (higher precision)
        seen_ids: set[str] = {m.term_id for m in string_matches}
        merged: list[EmbeddingTermMatch | TermMatch] = list(string_matches)

        for em in emb_matches:
            if em.term_id not in seen_ids:
                merged.append(em)
                seen_ids.add(em.term_id)

        # Sort: string matches by position, embedding matches by similarity
        # Keep string matches first (they have exact position info)
        string_part = [m for m in merged if isinstance(m, TermMatch)]
        emb_part = [m for m in merged if isinstance(m, EmbeddingTermMatch)]
        string_part.sort(key=lambda m: (m.start, -m.score))
        emb_part.sort(key=lambda m: -m.similarity)

        return (string_part + emb_part)[:top_k]

    # ── Typed accessors ─────────────────────────────────────────────────

    def resolve_metric(self, text: str) -> str | None:
        """Best metricId from hybrid resolve."""
        for m in self.resolve_hybrid(text):
            mid = m.resolution.get("metricId")
            if mid:
                return mid
        return None

    def resolve_dimension(self, text: str) -> str | None:
        """Best dimensionId from hybrid resolve."""
        for m in self.resolve_hybrid(text):
            dim_id = m.resolution.get("dimensionId")
            if dim_id:
                return dim_id
        return None

    def resolve_entity(self, text: str) -> str | None:
        """Best entityId from hybrid resolve."""
        for m in self.resolve_hybrid(text):
            eid = m.resolution.get("entityId")
            if eid:
                return eid
        return None

    # ── Utility ─────────────────────────────────────────────────────────

    @property
    def is_embedding_active(self) -> bool:
        """True if embedding backend is available and index is built."""
        return self.index.is_ready

    @property
    def phrase_count(self) -> int:
        return len(self.index.phrases)

    def summary(self) -> dict[str, Any]:
        idx = self.index
        return {
            "embedding_active": idx.is_ready,
            "phrases_indexed": len(idx.phrases),
            "embedding_dim": int(idx.embeddings.shape[1]) if idx.is_ready else 0,
            "fingerprint": idx.fingerprint,
            "similarity_threshold": _SIMILARITY_THRESHOLD,
        }
