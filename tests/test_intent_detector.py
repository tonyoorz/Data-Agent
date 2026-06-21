"""Tests for Intent Detector

Tests query intent classification.
"""

import pytest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from agent.understand.intent_detector import IntentDetector, QueryIntent, get_intent_detector
from agent.understand.entity_extractor import EntityExtractor
from agent.ontology import OntologyEngine


@pytest.fixture
def detector():
    return IntentDetector()


@pytest.fixture
def extractor():
    ontology_dir = Path(__file__).parent.parent / "agent" / "ontology"
    engine = OntologyEngine(ontology_dir)
    return EntityExtractor(engine)


class TestIntentDetection:

    def test_count_intent(self, detector):
        """Test count intent detection"""
        result = detector.detect("有多少缺陷")
        assert result.primary == QueryIntent.COUNT

    def test_count_intent_2(self, detector):
        """Test count with '数量'"""
        result = detector.detect("IDCEVO 缺陷数量")
        assert result.primary == QueryIntent.COUNT

    def test_trend_intent(self, detector):
        """Test trend intent detection"""
        result = detector.detect("缺陷趋势分析")
        assert result.primary == QueryIntent.TREND
        assert result.needs_timeseries

    def test_ranking_intent(self, detector):
        """Test ranking intent detection"""
        result = detector.detect("缺陷最多的 TOP 10 ECU")
        assert result.primary == QueryIntent.RANKING

    def test_distribution_intent(self, detector):
        """Test distribution intent detection"""
        result = detector.detect("缺陷按项目分布")
        assert result.primary == QueryIntent.DISTRIBUTION
        assert result.needs_grouping

    def test_comparison_intent(self, detector):
        """Test comparison intent detection"""
        result = detector.detect("IDCEVO 和 IDC 对比")
        assert result.primary == QueryIntent.COMPARISON

    def test_detail_list_intent(self, detector):
        """Test detail list intent detection"""
        result = detector.detect("列出所有 Critical 缺陷")
        assert result.primary == QueryIntent.DETAIL_LIST

    def test_search_similar_intent(self, detector):
        """Test similar search intent detection"""
        result = detector.detect("有没有类似的缺陷")
        assert result.primary == QueryIntent.SEARCH_SIMILAR

    def test_with_extraction_context(self, detector, extractor):
        """Test intent detection with entity extraction context"""
        entities = extractor.extract("IDCEVO 各ECU缺陷分布")
        result = detector.detect("IDCEVO 各ECU缺陷分布", entities)
        assert result.primary == QueryIntent.DISTRIBUTION

    def test_default_to_count(self, detector):
        """Test unknown intent defaults to count"""
        result = detector.detect("xkcd random text")
        assert result.primary == QueryIntent.COUNT
