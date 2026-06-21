"""Tests for Semantic Matcher and enhanced QueryMemory"""

import os
import sys
import pytest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.learning.semantic_matcher import (
    SemanticMatcher, TfidfVectorizer, tokenize, cosine_similarity,
)
from agent.learning.query_memory import QueryMemory, QueryRecord


# ============================================================================
# Tokenization Tests
# ============================================================================

class TestTokenize:

    def test_cjk_bigrams(self):
        tokens = tokenize("缺陷数量")
        assert "缺陷" in tokens
        assert "陷数" in tokens
        assert "数量" in tokens

    def test_english_words(self):
        tokens = tokenize("IDCEVO critical defects")
        assert "idcevo" in tokens
        assert "critical" in tokens
        assert "defects" in tokens

    def test_mixed(self):
        tokens = tokenize("IDCEVO有多少Critical缺陷")
        assert "idcevo" in tokens
        assert "critical" in tokens
        assert "缺陷" in tokens

    def test_empty(self):
        assert tokenize("") == []


# ============================================================================
# TF-IDF Tests
# ============================================================================

class TestTfidf:

    def test_fit_and_vectorize(self):
        vec = TfidfVectorizer()
        vec.fit(["IDCEVO有多少缺陷", "MGU的缺陷数量", "各项目缺陷分布"])
        assert vec.vocabulary_size > 0

        v1 = vec.vectorize("IDCEVO有多少缺陷")
        assert len(v1) > 0
        assert "缺陷" in v1

    def test_cosine_identical(self):
        vec = TfidfVectorizer()
        vec.fit(["IDCEVO有多少缺陷", "MGU的缺陷数量"])

        v1 = vec.vectorize("IDCEVO有多少缺陷")
        v2 = vec.vectorize("IDCEVO有多少缺陷")
        assert cosine_similarity(v1, v2) == pytest.approx(1.0, abs=0.01)

    def test_cosine_different(self):
        vec = TfidfVectorizer()
        vec.fit(["IDCEVO有多少缺陷", "MGU的缺陷数量"])

        v1 = vec.vectorize("IDCEVO有多少缺陷")
        v2 = vec.vectorize("完全不同的话")
        assert cosine_similarity(v1, v2) < 0.3


# ============================================================================
# SemanticMatcher Tests
# ============================================================================

class TestSemanticMatcher:

    def test_tfidf_similarity(self):
        matcher = SemanticMatcher()
        matcher.fit_corpus([
            "IDCEVO有多少Critical缺陷",
            "MGU的缺陷数量",
            "各项目缺陷分布",
            "严重程度排名",
        ])

        score = matcher.similarity(
            "IDCEVO有多少Critical缺陷",
            "IDCEVO的Critical缺陷有多少个"
        )
        assert score > 0.5  # Should be quite similar

    def test_different_questions(self):
        matcher = SemanticMatcher()
        matcher.fit_corpus([
            "IDCEVO有多少缺陷",
            "MGU的缺陷数量",
        ])

        score = matcher.similarity(
            "IDCEVO有多少缺陷",
            "天气怎么样"
        )
        assert score < 0.2

    def test_find_similar(self):
        matcher = SemanticMatcher()
        corpus = [
            "IDCEVO有多少Critical缺陷",
            "各项目的缺陷数量排名",
            "缺陷按严重程度分布",
            "最近有什么新缺陷",
        ]
        matcher.fit_corpus(corpus)

        results = matcher.find_similar(
            "IDCEVO的Critical问题数量",
            corpus,
            top_k=2,
            min_score=0.15,
        )
        assert len(results) >= 1
        assert "IDCEVO" in results[0][1]
        assert results[0][0] > 0.15

    def test_jaccard_fallback(self):
        """Without fitting, falls back to Jaccard"""
        matcher = SemanticMatcher(use_tfidf=False)
        score = matcher.similarity("IDCEVO缺陷", "IDCEVO缺陷")
        assert score == pytest.approx(1.0, abs=0.01)

    def test_mock_embedding_fn(self):
        """Test with a mock embedding function"""
        def mock_embed(text):
            # Simple character-level embedding
            vec = [0.0] * 128
            for ch in text:
                vec[ord(ch) % 128] += 1.0
            # Normalize
            mag = sum(v * v for v in vec) ** 0.5
            return [v / mag for v in vec] if mag > 0 else vec

        matcher = SemanticMatcher(embedding_fn=mock_embed)
        score = matcher.similarity("IDCEVO缺陷", "IDCEVO缺陷")
        assert score > 0.9

        score2 = matcher.similarity("IDCEVO缺陷", "完全不同")
        assert score2 < score


# ============================================================================
# QueryMemory Integration Tests
# ============================================================================

class TestQueryMemorySemantic:

    def test_record_and_retrieve(self):
        """Record queries and retrieve similar"""
        mem = QueryMemory(db_path=":memory:")

        # Record some queries
        mem.record(
            question="IDCEVO有多少Critical缺陷",
            sql="SELECT COUNT(*) FROM octane_defects WHERE project='IDCEVO' AND severity='Critical'",
            intent="count",
        )
        mem.record(
            question="各项目缺陷数量排名",
            sql="SELECT project, COUNT(*) FROM octane_defects GROUP BY project ORDER BY COUNT(*) DESC",
            intent="ranking",
        )

        # Retrieve similar
        results = mem.retrieve_similar("IDCEVO的Critical缺陷有多少个")
        assert len(results) >= 1
        assert "IDCEVO" in results[0].question or "Critical" in results[0].question

    def test_semantic_better_than_keyword(self):
        """Semantic matching should find more paraphrases than keyword-only"""
        mem = QueryMemory(db_path=":memory:")

        mem.record(
            question="IDCEVO项目缺陷趋势",
            sql="SELECT ...",
            intent="trend",
        )

        # Paraphrased question
        results = mem.retrieve_similar("IDCEVO的缺陷变化趋势", min_similarity=0.2)
        assert len(results) >= 1

    def test_statistics(self):
        mem = QueryMemory(db_path=":memory:")
        mem.record("测试问题1", "SELECT 1", "count")
        mem.record("测试问题2", "SELECT 2", "ranking")

        stats = mem.get_statistics()
        assert stats["total_records"] == 2
        assert stats["successful"] == 2

    def test_feedback(self):
        mem = QueryMemory(db_path=":memory:")
        rid = mem.record("测试问题", "SELECT 1", "count")
        mem.record_feedback(rid, "up", "很好")
        
        record = mem.get_by_id(rid)
        assert record.feedback == "up"
        assert record.score > 1.0
