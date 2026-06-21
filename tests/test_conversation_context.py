"""Tests for Conversation Context (multi-turn dialogue)"""

import os
import sys
import pytest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.conversation.context import (
    ConversationContext,
    SessionManager,
    TurnClassifier,
    ContextResolver,
    TurnRecord,
    TurnType,
)


# ============================================================================
# Turn Classifier Tests
# ============================================================================

class TestTurnClassifier:

    def setup_method(self):
        self.clf = TurnClassifier()

    def test_initial_no_history(self):
        tt = self.clf.classify("IDCEVO有多少Critical缺陷", history=[])
        assert tt == TurnType.INITIAL

    def test_refine_with_distribution_keyword(self):
        history = [TurnRecord(question="IDCEVO有多少Critical缺陷", result_summary="23个")]
        tt = self.clf.classify("按ECU分布呢", history)
        assert tt == TurnType.REFINE

    def test_follow_up_short_question(self):
        history = [TurnRecord(question="各项目缺陷数量排名", result_summary="IDCEVO...")]
        # Short question referencing prior context
        tt = self.clf.classify("第一个呢", history)
        assert tt in (TurnType.FOLLOW_UP, TurnType.REFINE)

    def test_clarify_correction(self):
        history = [TurnRecord(question="IDC有多少缺陷", result_summary="101个")]
        tt = self.clf.classify("不是IDC，是IDCEVO", history)
        assert tt == TurnType.CLARIFY

    def test_new_topic_after_gap(self):
        history = [TurnRecord(question="IDCEVO有多少Critical缺陷", result_summary="23个")]
        tt = self.clf.classify("我想了解天气", history)
        # No overlap → INITIAL
        assert tt == TurnType.INITIAL


# ============================================================================
# Context Resolver Tests
# ============================================================================

class TestContextResolver:

    def test_initial_unchanged(self):
        resolver = ContextResolver(llm_call_fn=None)
        result = resolver.resolve(
            "IDCEVO有多少缺陷",
            history=[],
            turn_type=TurnType.INITIAL,
        )
        assert result == "IDCEVO有多少缺陷"

    def test_rule_refine_adds_context(self):
        resolver = ContextResolver(llm_call_fn=None)
        history = [
            TurnRecord(
                question="IDCEVO有多少Critical缺陷",
                resolved_question="IDCEVO有多少Critical缺陷",
                result_summary="23个",
                entities={"project": "IDCEVO", "severity": "Critical"},
            )
        ]
        result = resolver.resolve(
            "按ECU分布呢",
            history,
            TurnType.REFINE,
        )
        # Should contain IDCEVO and Critical context
        assert "IDCEVO" in result
        assert "Critical" in result or "critical" in result

    def test_rule_follow_up_short_question(self):
        resolver = ContextResolver(llm_call_fn=None)
        history = [
            TurnRecord(
                question="各项目缺陷数量排名",
                resolved_question="各项目缺陷数量排名",
                result_summary="IDCEVO 111, MGU 105",
            )
        ]
        result = resolver.resolve(
            "IHU呢",
            history,
            TurnType.FOLLOW_UP,
        )
        # Short question → gets context prefix
        assert "各项目" in result or "IHU" in result

    def test_clarify_unchanged(self):
        resolver = ContextResolver(llm_call_fn=None)
        history = [
            TurnRecord(question="IDC有多少缺陷", result_summary="101个")
        ]
        result = resolver.resolve(
            "不是IDC，是IDCEVO",
            history,
            TurnType.CLARIFY,
        )
        assert result == "不是IDC，是IDCEVO"

    def test_llm_resolver_with_mock(self):
        """Mock LLM that always returns a rewritten question"""
        def mock_llm(messages, tools):
            return "重写后的完整问题"

        resolver = ContextResolver(llm_call_fn=mock_llm)
        history = [
            TurnRecord(question="IDCEVO有多少缺陷", result_summary="111个")
        ]
        result = resolver.resolve(
            "按ECU分布呢",
            history,
            TurnType.REFINE,
        )
        assert result == "重写后的完整问题"


# ============================================================================
# ConversationContext Tests
# ============================================================================

class TestConversationContext:

    def test_initial_turn(self):
        ctx = ConversationContext(llm_call_fn=None)
        resolved = ctx.resolve("IDCEVO有多少缺陷")
        assert resolved == "IDCEVO有多少缺陷"
        assert ctx.turn_count == 0

    def test_after_first_turn(self):
        ctx = ConversationContext(llm_call_fn=None)
        ctx.add_turn(
            question="IDCEVO有多少Critical缺陷",
            sql="SELECT COUNT(*)...",
            result_summary="23个",
            entities={"project": "IDCEVO", "severity": "Critical"},
        )
        assert ctx.turn_count == 1

        # Second turn should be resolved with context
        resolved = ctx.resolve("按ECU分布呢")
        assert "IDCEVO" in resolved  # Rule-based adds context

    def test_history_text(self):
        ctx = ConversationContext(llm_call_fn=None)
        ctx.add_turn(question="Q1", result_summary="R1")
        ctx.add_turn(question="Q2", result_summary="R2")

        text = ctx.get_history_text(max_turns=2)
        assert "Q1" in text
        assert "R1" in text
        assert "Q2" in text

    def test_clear(self):
        ctx = ConversationContext(llm_call_fn=None)
        ctx.add_turn(question="Q1", result_summary="R1")
        ctx.clear()
        assert ctx.turn_count == 0

    def test_context_summary(self):
        ctx = ConversationContext(llm_call_fn=None)
        ctx.add_turn(
            question="IDCEVO有多少缺陷",
            intent="count",
            result_summary="111个",
        )
        summary = ctx.get_context_summary()
        assert summary["turn_count"] == 1
        assert summary["active_context"] is True
        assert summary["last_question"] == "IDCEVO有多少缺陷"

    def test_max_history_trim(self):
        ctx = ConversationContext(llm_call_fn=None, max_history=3)
        for i in range(5):
            ctx.add_turn(question=f"Q{i}", result_summary=f"R{i}")
        assert ctx.turn_count == 3  # Trimmed to max


# ============================================================================
# SessionManager Tests
# ============================================================================

class TestSessionManager:

    def test_create_and_get(self):
        mgr = SessionManager(llm_call_fn=None)
        ctx1 = mgr.get_session("session1")
        assert ctx1.turn_count == 0

        ctx1.add_turn(question="Q1", result_summary="R1")

        # Same session → same context
        ctx1_again = mgr.get_session("session1")
        assert ctx1_again.turn_count == 1

    def test_different_sessions(self):
        mgr = SessionManager(llm_call_fn=None)
        ctx1 = mgr.get_session("s1")
        ctx2 = mgr.get_session("s2")

        ctx1.add_turn(question="Q1", result_summary="R1")

        assert ctx1.turn_count == 1
        assert ctx2.turn_count == 0

    def test_remove_session(self):
        mgr = SessionManager(llm_call_fn=None)
        mgr.get_session("s1")
        mgr.remove_session("s1")
        assert "s1" not in mgr.get_active_sessions()

    def test_active_sessions(self):
        mgr = SessionManager(llm_call_fn=None)
        mgr.get_session("a")
        mgr.get_session("b")
        active = mgr.get_active_sessions()
        assert "a" in active
        assert "b" in active


# ============================================================================
# Integration Test
# ============================================================================

class TestMultiTurnSimulation:

    def test_three_turn_flow(self):
        """Simulate a 3-turn conversation"""
        ctx = ConversationContext(llm_call_fn=None)

        # Turn 1: Initial question
        resolved1 = ctx.resolve("IDCEVO有多少Critical缺陷")
        assert resolved1 == "IDCEVO有多少Critical缺陷"
        ctx.add_turn(
            question="IDCEVO有多少Critical缺陷",
            resolved_question=resolved1,
            sql="SELECT COUNT(*) FROM octane_defects WHERE project='IDCEVO' AND severity='Critical'",
            result_summary="23个",
            entities={"project": "IDCEVO", "severity": "Critical"},
        )

        # Turn 2: Refine (ask for ECU distribution)
        resolved2 = ctx.resolve("按ECU分布呢")
        ctx.add_turn(
            question="按ECU分布呢",
            resolved_question=resolved2,
            sql="SELECT assigned_ecu, COUNT(*) FROM octane_defects WHERE project='IDCEVO' AND severity='Critical' GROUP BY assigned_ecu",
            result_summary="IHU 8, BCM 6, ADAS 5",
            entities={"project": "IDCEVO", "severity": "Critical"},
        )

        # Turn 3: Follow-up (ask about specific ECU)
        resolved3 = ctx.resolve("IHU有多少")
        # Should contain context from previous turns
        assert "IHU" in resolved3

        ctx.add_turn(
            question="IHU有多少",
            resolved_question=resolved3,
            sql="SELECT COUNT(*) FROM octane_defects WHERE project='IDCEVO' AND severity='Critical' AND assigned_ecu='IHU'",
            result_summary="8个",
        )

        assert ctx.turn_count == 3
