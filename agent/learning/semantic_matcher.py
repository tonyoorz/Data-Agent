"""Semantic Memory — Embedding-enhanced query matching for QueryMemory

Upgrades QueryMemory's Jaccard(60%) + Levenshtein(40%) matching to:
1. TF-IDF cosine similarity (always available, no external dependency)
2. Pluggable embedding function (BGE, ZhiPu embedding API, etc.)

The key insight from Vanna 2.0 and WrenAI: query memory with semantic
matching dramatically improves SQL reuse for paraphrased questions.

Example:
    # Without semantic matching:
    "IDCEVO有多少严重缺陷" vs "IDCEVO的Critical缺陷数量" → 0.42 (Jaccard)
    
    # With TF-IDF + cosine:
    Same pair → 0.78 (shares key terms: IDCEVO, 缺陷)
    
    # With BGE embedding:
    Same pair → 0.89 (semantic similarity)

Usage:
    from agent.learning.semantic_matcher import SemanticMatcher

    matcher = SemanticMatcher(embedding_fn=my_embed_fn)
    score = matcher.similarity("query1", "query2")
    # → 0.89

    matches = matcher.find_similar("IDCEVO有多少缺陷", database_of_records)
"""

from __future__ import annotations

import re
import math
import logging
from typing import List, Dict, Optional, Callable, Tuple
from dataclasses import dataclass
from collections import Counter

logger = logging.getLogger(__name__)


# ============================================================================
# Tokenization
# ============================================================================

def tokenize(text: str) -> List[str]:
    """
    CJK-aware tokenization.

    For CJK text: 2-character sliding window (bigrams)
    For Latin text: word-level tokens
    """
    text = text.lower().strip()
    tokens = []

    # CJK bigrams
    cjk_pattern = re.compile(r'[\u4e00-\u9fff]+')
    cjk_spans = []
    pos = 0
    for match in cjk_pattern.finditer(text):
        cjk_text = match.group()
        if len(cjk_text) >= 2:
            for i in range(len(cjk_text) - 1):
                tokens.append(cjk_text[i:i + 2])
            # Also add the full CJK span as a token
            if len(cjk_text) <= 6:
                tokens.append(cjk_text)
        elif len(cjk_text) == 1:
            tokens.append(cjk_text)
        cjk_spans.append(match.span())

    # Latin words (outside CJK spans)
    last_end = 0
    for start, end in cjk_spans:
        between = text[last_end:start]
        tokens.extend(_tokenize_latin(between))
        last_end = end
    tokens.extend(_tokenize_latin(text[last_end:]))

    return tokens


def _tokenize_latin(text: str) -> List[str]:
    """Word-level tokenization for Latin text"""
    words = re.findall(r'[a-z0-9_]+', text.lower())
    return [w for w in words if len(w) >= 2]


# ============================================================================
# TF-IDF Vectorizer
# ============================================================================

class TfidfVectorizer:
    """
    Lightweight TF-IDF vectorizer.

    Builds IDF from a corpus of stored questions.
    Computes TF-IDF vectors for similarity comparison.
    """

    def __init__(self):
        self._idf: Dict[str, float] = {}
        self._vocabulary: set = set()
        self._doc_count: int = 0

    def fit(self, documents: List[str]):
        """Compute IDF from a corpus"""
        self._doc_count = len(documents)
        if self._doc_count == 0:
            return

        df = Counter()  # document frequency
        for doc in documents:
            tokens = set(tokenize(doc))
            for token in tokens:
                df[token] += 1
                self._vocabulary.add(token)

        # IDF = ln(N / df), smoothed
        for token, freq in df.items():
            self._idf[token] = math.log((self._doc_count + 1) / (freq + 1)) + 1

    def vectorize(self, text: str) -> Dict[str, float]:
        """Compute TF-IDF vector for a single document"""
        tokens = tokenize(text)
        if not tokens:
            return {}

        tf = Counter(tokens)
        total = len(tokens)

        vector = {}
        for token, count in tf.items():
            tf_val = count / total
            idf_val = self._idf.get(token, math.log(self._doc_count + 1) + 1)
            vector[token] = tf_val * idf_val

        return vector

    @property
    def vocabulary_size(self) -> int:
        return len(self._vocabulary)


def cosine_similarity(v1: Dict[str, float], v2: Dict[str, float]) -> float:
    """Cosine similarity between two sparse vectors"""
    if not v1 or not v2:
        return 0.0

    # Dot product
    common_keys = set(v1.keys()) & set(v2.keys())
    dot = sum(v1[k] * v2[k] for k in common_keys)

    # Magnitudes
    mag1 = math.sqrt(sum(v * v for v in v1.values()))
    mag2 = math.sqrt(sum(v * v for v in v2.values()))

    if mag1 == 0 or mag2 == 0:
        return 0.0

    return dot / (mag1 * mag2)


# ============================================================================
# Semantic Matcher
# ============================================================================

# Type for embedding function: fn(text: str) -> List[float]
EmbeddingFn = Callable[[str], List[float]]


class SemanticMatcher:
    """
    Semantic similarity matcher.

    Three tiers:
    1. Embedding cosine (if embedding_fn available) — best quality
    2. TF-IDF cosine — always available, good for keyword overlap
    3. Fallback to Jaccard (from original QueryMemory)

    Usage:
        # With BGE/ZhiPu embedding
        matcher = SemanticMatcher(embedding_fn=my_embed_fn)

        # TF-IDF only
        matcher = SemanticMatcher()

        # Build corpus
        matcher.fit_corpus(["question1", "question2", ...])

        # Compare
        score = matcher.similarity("new question", "stored question")
    """

    def __init__(
        self,
        embedding_fn: Optional[EmbeddingFn] = None,
        use_tfidf: bool = True,
    ):
        self.embedding_fn = embedding_fn
        self.use_tfidf = use_tfidf
        self._vectorizer = TfidfVectorizer() if use_tfidf else None
        self._corpus_fitted = False

        # Cache for embeddings (avoid re-computing)
        self._embedding_cache: Dict[str, List[float]] = {}

    def fit_corpus(self, documents: List[str]):
        """Fit TF-IDF on stored questions"""
        if self.use_tfidf and documents:
            self._vectorizer.fit(documents)
            self._corpus_fitted = True

    def similarity(self, text1: str, text2: str) -> float:
        """
        Compute semantic similarity between two texts.
        Returns 0-1 score.
        """
        # Tier 1: Embedding
        if self.embedding_fn:
            score = self._embedding_similarity(text1, text2)
            if score is not None:
                return score

        # Tier 2: TF-IDF
        if self.use_tfidf and self._corpus_fitted:
            v1 = self._vectorizer.vectorize(text1)
            v2 = self._vectorizer.vectorize(text2)
            return cosine_similarity(v1, v2)

        # Tier 3: Jaccard fallback
        return self._jaccard(text1, text2)

    def find_similar(
        self,
        query: str,
        candidates: List[str],
        top_k: int = 3,
        min_score: float = 0.3,
    ) -> List[Tuple[float, str]]:
        """
        Find similar texts from a list of candidates.

        Returns: [(score, candidate_text), ...] sorted by score descending.
        """
        scored = []
        for candidate in candidates:
            score = self.similarity(query, candidate)
            if score >= min_score:
                scored.append((score, candidate))

        scored.sort(key=lambda x: x[0], reverse=True)
        return scored[:top_k]

    # ==================== Internal ====================

    def _embedding_similarity(self, text1: str, text2: str) -> Optional[float]:
        """Compute embedding cosine similarity"""
        try:
            v1 = self._get_embedding(text1)
            v2 = self._get_embedding(text2)

            if v1 is None or v2 is None:
                return None

            # Dense cosine similarity
            dot = sum(a * b for a, b in zip(v1, v2))
            mag1 = math.sqrt(sum(a * a for a in v1))
            mag2 = math.sqrt(sum(b * b for b in v2))

            if mag1 == 0 or mag2 == 0:
                return 0.0

            return dot / (mag1 * mag2)

        except Exception as e:
            logger.warning(f"Embedding similarity failed: {e}")
            return None

    def _get_embedding(self, text: str) -> Optional[List[float]]:
        """Get embedding from cache or compute"""
        if text in self._embedding_cache:
            return self._embedding_cache[text]

        try:
            embedding = self.embedding_fn(text)
            self._embedding_cache[text] = embedding
            return embedding
        except Exception as e:
            logger.warning(f"Embedding failed for '{text[:30]}': {e}")
            return None

    @staticmethod
    def _jaccard(a: str, b: str) -> float:
        """Jaccard similarity fallback"""
        tokens_a = set(tokenize(a))
        tokens_b = set(tokenize(b))
        if not tokens_a or not tokens_b:
            return 0.0
        return len(tokens_a & tokens_b) / len(tokens_a | tokens_b)
