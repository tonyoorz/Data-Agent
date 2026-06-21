"""Tests for Phase 4 - Learning & Interpretation"""

import sys
import os
import tempfile

import pytest

# Ensure project root is importable
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from agent.learning.query_memory import (
    QueryMemory, QueryRecord, _normalize_question, _extract_keywords,
    _jaccard_similarity, _edit_distance_ratio,
)
from agent.learning.feedback_store import FeedbackStore, FeedbackRecord
from agent.interpret.storyteller import DataStoryteller, StoryResult, StoryType


# ========== QueryMemory Tests ==========

class TestNormalization:
    def test_normalize_lowercase(self):
        assert _normalize_question("IDCEVO Critical") == "idcevo critical"

    def test_normalize_strip_punctuation(self):
        assert _normalize_question("BCM 缺陷有多少？") == "bcm 缺陷有多少"
        assert _normalize_question("严重度分布！") == "严重度分布"

    def test_normalize_collapse_spaces(self):
        assert _normalize_question("  多个   空格  ") == "多个 空格"


class TestKeywordExtraction:
    def test_extract_cjk_bigram(self):
        kw = _extract_keywords("IDCEVO 缺陷趋势")
        assert "缺陷" in kw or "趋势" in kw or "缺陷趋势" in kw

    def test_extract_english(self):
        kw = _extract_keywords("BCM Critical bugs")
        assert "bcm" in kw
        assert "critical" in kw

    def test_extract_empty(self):
        assert _extract_keywords("") == set()


class TestSimilarity:
    def test_jaccard_identical(self):
        s = {"a", "b", "c"}
        assert _jaccard_similarity(s, s) == 1.0

    def test_jaccard_disjoint(self):
        assert _jaccard_similarity({"a"}, {"b"}) == 0.0

    def test_jaccard_partial(self):
        sim = _jaccard_similarity({"a", "b"}, {"a", "c"})
        assert 0 < sim < 1

    def test_edit_distance_identical(self):
        assert _edit_distance_ratio("hello", "hello") == 1.0

    def test_edit_distance_different(self):
        assert _edit_distance_ratio("abc", "xyz") == 0.0

    def test_edit_distance_close(self):
        ratio = _edit_distance_ratio("IDCEVO缺陷", "IDCEVO缺陷趋势")
        assert 0.5 < ratio < 1.0


class TestQueryMemoryRecord:
    def test_record_and_retrieve(self):
        mem = QueryMemory(db_path=":memory:")
        
        rid = mem.record(
            question="IDCEVO 有多少 Critical 缺陷",
            sql="SELECT COUNT(*) FROM octane_defects WHERE project='IDCEVO' AND severity='Critical'",
            intent="count",
            entities={"project": "IDCEVO", "severity": "Critical"},
            result_summary="42",
            result_count=42,
        )
        
        assert rid  # non-empty id
        
        # Retrieve by ID
        record = mem.get_by_id(rid)
        assert record is not None
        assert record.question == "IDCEVO 有多少 Critical 缺陷"
        assert record.success is True
        assert record.result_count == 42

    def test_record_duplicate_updates_usage(self):
        mem = QueryMemory(db_path=":memory:")
        
        q = "IDCEVO Critical 缺陷数量"
        sql = "SELECT COUNT(*) FROM defects WHERE project='IDCEVO'"
        
        rid1 = mem.record(question=q, sql=sql)
        rid2 = mem.record(question=q, sql=sql)
        
        # Same ID (deterministic)
        assert rid1 == rid2
        
        record = mem.get_by_id(rid1)
        assert record.usage_count == 1  # incremented once

    def test_retrieve_similar(self):
        mem = QueryMemory(db_path=":memory:")
        
        # Record several queries
        mem.record(
            question="IDCEVO 本月 Critical 缺陷有多少",
            sql="SELECT COUNT(*) FROM defects WHERE project='IDCEVO'",
            intent="count",
        )
        mem.record(
            question="各项目缺陷严重度分布",
            sql="SELECT severity, COUNT(*) FROM defects GROUP BY severity",
            intent="distribution",
        )
        mem.record(
            question="BCM 相关缺陷趋势",
            sql="SELECT date, COUNT(*) FROM defects WHERE ecu='BCM' GROUP BY date",
            intent="trend",
        )
        
        # Query similar to first
        results = mem.retrieve_similar("IDCEVO Critical 缺陷数量是多少", top_k=2)
        assert len(results) > 0
        assert "IDCEVO" in results[0].question or "Critical" in results[0].question

    def test_retrieve_no_match(self):
        mem = QueryMemory(db_path=":memory:")
        mem.record(question="IDCEVO缺陷", sql="SELECT 1", intent="count")
        
        results = mem.retrieve_similar("今天天气怎么样", top_k=3, min_similarity=0.5)
        assert len(results) == 0

    def test_record_feedback_updates_score(self):
        mem = QueryMemory(db_path=":memory:")
        rid = mem.record(question="测试查询", sql="SELECT 1", intent="count")
        
        initial = mem.get_by_id(rid)
        initial_score = initial.score
        
        mem.record_feedback(rid, "up")
        after_up = mem.get_by_id(rid)
        assert after_up.score > initial_score
        assert after_up.feedback == "up"
        
        mem.record_feedback(rid, "down")
        after_down = mem.get_by_id(rid)
        assert after_down.feedback == "down"

    def test_get_statistics(self):
        mem = QueryMemory(db_path=":memory:")
        mem.record(question="Q1", sql="SELECT 1", success=True)
        mem.record(question="Q2", sql="SELECT 2", success=True)
        mem.record(question="Q3", sql="SELECT 3", success=False)
        
        stats = mem.get_statistics()
        assert stats["total_records"] == 3
        assert stats["successful"] == 2
        assert stats["success_rate"] == 2 / 3

    def test_get_recent(self):
        mem = QueryMemory(db_path=":memory:")
        for i in range(5):
            mem.record(question=f"问题{i}", sql=f"SELECT {i}")
        
        recent = mem.get_recent(limit=3)
        assert len(recent) == 3

    def test_export_examples(self):
        mem = QueryMemory(db_path=":memory:")
        mem.record(
            question="IDCEVO缺陷数量",
            sql="SELECT COUNT(*) FROM defects WHERE project='IDCEVO'",
            intent="count",
            success=True,
        )
        mem.record(
            question="测试失败统计",
            sql="SELECT 0",
            intent="count",
            success=False,
        )
        
        examples = mem.export_examples()
        assert len(examples) >= 1
        assert all(ex["question"] for ex in examples)
        assert all(ex["sql"] for ex in examples)


class TestQueryMemoryFileDB:
    def test_persistence_across_connections(self):
        """Test that data persists when using file-based SQLite"""
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
            db_path = f.name
        
        try:
            mem1 = QueryMemory(db_path=db_path)
            mem1.record(question="持久化测试", sql="SELECT 1", intent="count")
            
            mem2 = QueryMemory(db_path=db_path)
            results = mem2.retrieve_similar("持久化测试", top_k=1)
            assert len(results) > 0
            assert results[0].question == "持久化测试"
        finally:
            os.unlink(db_path)


# ========== FeedbackStore Tests ==========

class TestFeedbackStore:
    def _make_shared(self):
        """Create shared file DB for QueryMemory + FeedbackStore"""
        import tempfile, os
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        mem = QueryMemory(db_path=path)
        fb = FeedbackStore(db_path=path)
        return mem, fb, path

    def _cleanup(self, path):
        try:
            os.unlink(path)
        except OSError:
            pass

    def test_record_feedback(self):
        mem, fb, path = self._make_shared()
        try:
            rid = mem.record(question="测试", sql="SELECT 1", intent="count")
            fid = fb.record(rid, "up", note="很好", question="测试", sql="SELECT 1")
            assert fid
        finally:
            self._cleanup(path)

    def test_get_by_query(self):
        mem, fb, path = self._make_shared()
        try:
            rid = mem.record(question="测试反馈", sql="SELECT 1")
            fb.record(rid, "up", question="测试反馈")
            fb.record(rid, "down", note="不对", question="测试反馈")
            records = fb.get_by_query(rid)
            assert len(records) == 2
        finally:
            self._cleanup(path)

    def test_feedback_statistics(self):
        mem, fb, path = self._make_shared()
        try:
            rid1 = mem.record(question="Q1", sql="SELECT 1")
            rid2 = mem.record(question="Q2", sql="SELECT 2")
            fb.record(rid1, "up", question="Q1")
            fb.record(rid2, "down", note="结果不对", question="Q2")
            stats = fb.get_statistics()
            assert stats["total"] == 2
            assert stats["thumbs_up"] == 1
            assert stats["thumbs_down"] == 1
            assert len(stats["negative_notes"]) >= 1
        finally:
            self._cleanup(path)

    def test_get_recent_feedback(self):
        mem, fb, path = self._make_shared()
        try:
            for i in range(5):
                rid = mem.record(question=f"Q{i}", sql=f"SELECT {i}")
                fb.record(rid, "up", question=f"Q{i}")
            recent = fb.get_recent(limit=3)
            assert len(recent) == 3
        finally:
            self._cleanup(path)

    def test_invalid_feedback_type(self):
        fb = FeedbackStore(db_path=":memory:")
        with pytest.raises(ValueError):
            fb.record("fake_id", "invalid")


# ========== DataStoryteller Tests ==========

class TestStorytellerCount:
    def test_count_basic(self):
        teller = DataStoryteller()
        result = teller.tell_count(42, context={"severity": "Critical", "project": "IDCEVO"})
        
        assert "42" in result.headline
        assert "Critical" in result.headline
        assert len(result.insights) > 0
        assert result.story_type == "count"

    def test_count_zero(self):
        teller = DataStoryteller()
        result = teller.tell_count(0)
        
        assert "0" in result.headline
        assert any("零缺陷" in i for i in result.insights)

    def test_count_high(self):
        teller = DataStoryteller()
        result = teller.tell_count(100, context={"severity": "Critical"})
        
        assert any("较多" in i or "重点关注" in i for i in result.insights)
        assert result.recommendation  # should have a recommendation

    def test_count_critical_recommendation(self):
        teller = DataStoryteller()
        result = teller.tell_count(5, context={"severity": "Critical"})
        
        assert "24h" in result.recommendation or "立即" in result.recommendation


class TestStorytellerTrend:
    def test_trend_rising(self):
        teller = DataStoryteller()
        data = [
            {"period": "2026-01", "count": 10},
            {"period": "2026-02", "count": 15},
            {"period": "2026-03", "count": 25},
            {"period": "2026-04", "count": 40},
        ]
        result = teller.tell_trend(data)
        
        assert "上升" in result.headline
        assert any("上升" in i for i in result.insights)
        assert result.story_type == "trend"

    def test_trend_decreasing(self):
        teller = DataStoryteller()
        data = [
            {"period": "2026-01", "count": 40},
            {"period": "2026-02", "count": 30},
            {"period": "2026-03", "count": 20},
            {"period": "2026-04", "count": 10},
        ]
        result = teller.tell_trend(data)
        
        assert "下降" in result.headline

    def test_trend_stable(self):
        teller = DataStoryteller()
        data = [
            {"period": "2026-01", "count": 20},
            {"period": "2026-02", "count": 21},
            {"period": "2026-03", "count": 19},
            {"period": "2026-04", "count": 20},
        ]
        result = teller.tell_trend(data)
        
        assert "平稳" in result.headline

    def test_trend_empty(self):
        teller = DataStoryteller()
        result = teller.tell_trend([])
        assert "暂无" in result.headline

    def test_trend_peak_detection(self):
        teller = DataStoryteller()
        data = [
            {"period": "2026-01", "count": 10},
            {"period": "2026-02", "count": 50},
            {"period": "2026-03", "count": 15},
        ]
        result = teller.tell_trend(data)
        
        assert any("峰值" in i for i in result.insights)


class TestStorytellerDistribution:
    def test_distribution_concentrated(self):
        teller = DataStoryteller()
        data = [
            {"label": "BCM", "count": 80},
            {"label": "IDC", "count": 10},
            {"label": "APA", "count": 5},
            {"label": "ICM", "count": 5},
        ]
        result = teller.tell_distribution(data, dimension="ECU")
        
        assert "BCM" in result.headline
        assert any("集中" in i for i in result.insights)

    def test_distribution_spread(self):
        teller = DataStoryteller()
        data = [
            {"label": "A", "count": 8},
            {"label": "B", "count": 8},
            {"label": "C", "count": 7},
            {"label": "D", "count": 7},
            {"label": "E", "count": 6},
        ]
        result = teller.tell_distribution(data, dimension="模块")
        
        assert any("分散" in i for i in result.insights)

    def test_distribution_severity_critical(self):
        teller = DataStoryteller()
        data = [
            {"label": "Critical", "count": 15},
            {"label": "Major", "count": 30},
            {"label": "Minor", "count": 10},
        ]
        result = teller.tell_distribution(data, dimension="severity")
        
        assert any("Critical" in i for i in result.insights)

    def test_distribution_empty(self):
        teller = DataStoryteller()
        result = teller.tell_distribution([], dimension="ECU")
        assert "暂无" in result.headline


class TestStorytellerRanking:
    def test_ranking_basic(self):
        teller = DataStoryteller()
        data = [
            {"label": "BCM", "count": 50},
            {"label": "IDC", "count": 30},
            {"label": "APA", "count": 15},
        ]
        result = teller.tell_ranking(data, rank_by="ECU")
        
        assert "BCM" in result.headline
        assert result.story_type == "ranking"

    def test_ranking_hotspot(self):
        teller = DataStoryteller()
        data = [
            {"label": "BCM", "count": 100},
            {"label": "IDC", "count": 20},
            {"label": "APA", "count": 10},
        ]
        result = teller.tell_ranking(data, rank_by="ECU")
        
        assert any("远超" in i for i in result.insights)

    def test_ranking_empty(self):
        teller = DataStoryteller()
        result = teller.tell_ranking([], rank_by="ECU")
        assert "暂无" in result.headline


class TestStorytellerSummary:
    def test_summary_healthy(self):
        teller = DataStoryteller()
        stats = {
            "total": 100,
            "active": 10,
            "critical": 0,
            "resolved": 85,
        }
        result = teller.tell_summary(stats)
        
        assert "85" in result.headline or "100" in result.headline
        assert any("良好" in i for i in result.insights)

    def test_summary_critical_alert(self):
        teller = DataStoryteller()
        stats = {
            "total": 100,
            "active": 50,
            "critical": 8,
            "resolved": 40,
        }
        result = teller.tell_summary(stats)
        
        assert any("Critical" in i or "critical" in i for i in result.insights)

    def test_summary_backlog(self):
        teller = DataStoryteller()
        stats = {
            "total": 100,
            "active": 70,
            "critical": 2,
            "resolved": 25,
        }
        result = teller.tell_summary(stats)
        
        assert any("积压" in i or "活跃" in i for i in result.insights)


class TestStorytellerDispatch:
    def test_tell_dispatches_correctly(self):
        teller = DataStoryteller()
        
        # Count
        r1 = teller.tell("count", 42, context={})
        assert r1.story_type == "count"
        
        # Summary
        r2 = teller.tell("summary", {"total": 10, "active": 5, "critical": 1, "resolved": 3})
        assert r2.story_type == "summary"

    def test_tell_unknown_type(self):
        teller = DataStoryteller()
        result = teller.tell("unknown", "data")
        assert result.story_type == "unknown"

    def test_to_markdown(self):
        teller = DataStoryteller()
        result = teller.tell_count(42, context={"severity": "Critical"})
        md = result.to_markdown()
        
        assert "###" in md
        assert "42" in md
