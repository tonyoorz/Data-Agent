"""Conversation Context — Multi-turn dialogue management

Inspired by BIRD-Interact (ICLR 2026 Oral):
- Multi-turn interactions where users refine queries
- Coreference resolution ("其中", "这些", "上面提到的")
- Implicit constraint inheritance (previous filters carry forward)
- Turn type detection (refine, follow-up, new_topic, clarify)

Key design:
1. TurnHistory: stores all prior turns (question + SQL + result summary)
2. ContextResolver: merges prior context into current question
3. The resolver produces a "resolved question" that can be processed
   as if the user asked it fresh, but with all necessary context.

Example:
    Turn 1: "IDCEVO有多少Critical缺陷" → 23个
    Turn 2: "按ECU分布呢" → "IDCEVO项目中Critical缺陷按ECU分布"
    Turn 3: "IHU的有多少" → "IDCEVO项目中Critical缺陷中IHU有多少"

Usage:
    from agent.conversation.context import ConversationContext

    ctx = ConversationContext(llm_call_fn=my_fn)
    ctx.add_turn("IDCEVO有多少Critical缺陷", sql, "23个")
    resolved = ctx.resolve("按ECU分布呢")
    # → "IDCEVO项目中Critical缺陷按ECU分布呢"
"""

from __future__ import annotations

import logging
import time
import json
from typing import List, Dict, Optional, Any, Callable
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)


# ============================================================================
# Data Models
# ============================================================================

class TurnType(Enum):
    """Type of user turn in multi-turn dialogue"""
    INITIAL = "initial"        # First question or topic change
    REFINE = "refine"          # Refine previous query ("按ECU分布呢")
    FOLLOW_UP = "follow_up"    # Follow-up question ("IHU的有多少")
    CLARIFY = "clarify"        # Clarification ("我说的是IDCEVO不是IDC")
    COMPARE = "compare"        # Compare with previous result


@dataclass
class TurnRecord:
    """A single conversation turn"""
    turn_index: int = 0
    question: str = ""
    resolved_question: str = ""    # After context resolution
    sql: str = ""
    intent: str = ""
    result_summary: str = ""
    result_count: int = 0
    entities: Dict[str, Any] = field(default_factory=dict)
    turn_type: TurnType = TurnType.INITIAL
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "turn_index": self.turn_index,
            "question": self.question,
            "resolved_question": self.resolved_question,
            "sql": self.sql,
            "intent": self.intent,
            "result_summary": self.result_summary,
            "result_count": self.result_count,
            "entities": self.entities,
            "turn_type": self.turn_type.value,
            "timestamp": self.timestamp,
        }


# ============================================================================
# Turn Classifier
# ============================================================================

class TurnClassifier:
    """
    Classify user turn type based on question characteristics.

    Heuristics:
    - Contains pronouns/demonstratives → REFINE or FOLLOW_UP
    - Very short (< 8 chars) → likely FOLLOW_UP
    - Contains comparison keywords → COMPARE
    - Contains correction keywords → CLARIFY
    - Otherwise → INITIAL (new topic)
    """

    # Pronouns and demonstratives (Chinese + English)
    REFERENCE_KEYWORDS = {
        "其中", "这些", "上面", "刚才", "那个", "这", "那",
        "其中", "里面的", "它们的", "其",
        "them", "those", "these", "that", "this", "above",
        "it", "their", "previous",
    }

    # Refinement keywords
    REFINE_KEYWORDS = {
        "按", "根据", "分组", "分布", "排名", "排序", "统计",
        "呢", "怎么样", "如何",
        "group", "by", "distribution", "rank", "sort", "breakdown",
    }

    # Correction keywords
    CLARIFY_KEYWORDS = {
        "不是", "我说的是", "应该是", "错了", "不对",
        "不是那个", "更正", "纠正",
        "not", "I meant", "correction", "actually",
    }

    # Comparison keywords
    COMPARE_KEYWORDS = {
        "对比", "比较", "vs", "和...比", "差异", "区别",
        "compare", "comparison", "vs", "difference", "versus",
    }

    def classify(
        self,
        question: str,
        history: List[TurnRecord],
    ) -> TurnType:
        """Classify the turn type"""
        if not history:
            return TurnType.INITIAL

        q_lower = question.lower().strip()

        # Check correction first (highest priority)
        for kw in self.CLARIFY_KEYWORDS:
            if kw in q_lower:
                return TurnType.CLARIFY

        # Check comparison
        for kw in self.COMPARE_KEYWORDS:
            if kw in q_lower:
                return TurnType.COMPARE

        # Check reference words → REFINE or FOLLOW_UP
        has_reference = any(kw in q_lower for kw in self.REFERENCE_KEYWORDS)
        has_refine = any(kw in q_lower for kw in self.REFINE_KEYWORDS)

        # Check if question shares tokens with previous
        shares_tokens = False
        if history:
            last_turn = history[-1]
            # CJK-aware token overlap: use 2-gram characters
            q_tokens = set()
            for i in range(len(q_lower) - 1):
                q_tokens.add(q_lower[i:i+2])
            last_lower = last_turn.question.lower()
            last_tokens = set()
            for i in range(len(last_lower) - 1):
                last_tokens.add(last_lower[i:i+2])
            common = q_tokens & last_tokens
            shares_tokens = len(common) >= 3  # At least 3 bigrams overlap

        is_short = len(question.strip()) < 8

        # REFINE keywords (按, 分布, 排名...) are strong signals on their own
        if has_refine and history:
            return TurnType.REFINE
        if has_reference:
            return TurnType.FOLLOW_UP
        if is_short and shares_tokens:
            return TurnType.FOLLOW_UP

        # No overlap with previous turns → INITIAL
        return TurnType.INITIAL


# ============================================================================
# Context Resolver
# ============================================================================

class ContextResolver:
    """
    Resolve a user question with conversation context.

    Two approaches:
    1. Rule-based: merge entities and filters from previous turns
    2. LLM-based: ask LLM to rewrite the question with full context

    The LLM approach is more accurate but requires an API call.
    """

    # Context resolution prompt
    RESOLUTION_PROMPT = """你是一个多轮对话上下文解析器。

对话历史：
{history}

用户当前问题：{question}

请根据对话历史，将用户的当前问题重写为一个完整的、独立的问题。
要求：
1. 补全省略的主语、宾语、条件
2. 继承之前查询的筛选条件（项目、严重程度等）
3. 不要改变用户的原始意图
4. 如果当前问题已经是完整的，直接返回原文

只输出重写后的问题，不要解释。

示例：
历史：Q: IDCEVO有多少Critical缺陷 → A: 23个
当前：按ECU分布呢
重写：IDCEVO项目中Critical缺陷按ECU分布

历史：Q: 各项目缺陷数量 → A: IDCEVO 111, MGU 105...
当前：第一名的是哪些ECU
重写：缺陷数量最多的项目(IDCEVO)中，各ECU的缺陷分布
"""

    def __init__(
        self,
        llm_call_fn: Optional[Callable] = None,
        max_history_turns: int = 5,
    ):
        self.llm_call_fn = llm_call_fn
        self.max_history_turns = max_history_turns

    def resolve(
        self,
        question: str,
        history: List[TurnRecord],
        turn_type: TurnType,
    ) -> str:
        """
        Resolve a question using conversation history.

        Returns the resolved (context-complete) question.
        """
        if turn_type == TurnType.INITIAL or not history:
            return question

        # Try LLM-based resolution first
        if self.llm_call_fn:
            resolved = self._llm_resolve(question, history)
            if resolved:
                return resolved

        # Fall back to rule-based resolution
        return self._rule_resolve(question, history, turn_type)

    def _llm_resolve(
        self,
        question: str,
        history: List[TurnRecord],
    ) -> Optional[str]:
        """Use LLM to rewrite question with context"""
        try:
            # Build history text
            history_text = self._format_history(history)

            prompt = self.RESOLUTION_PROMPT.format(
                history=history_text,
                question=question,
            )

            # Call LLM (text mode)
            response = self.llm_call_fn(
                messages=[
                    {"role": "system", "content": "你是一个问题重写助手。"},
                    {"role": "user", "content": prompt},
                ],
                tools=[],  # No tools, just text
            )

            # Extract text from response
            if isinstance(response, str):
                return response.strip()
            if isinstance(response, dict):
                return response.get("content", "").strip()
            if isinstance(response, list) and response:
                # Might be a list of choices
                return str(response[0]).strip()

            return None

        except Exception as e:
            logger.warning(f"LLM context resolution failed: {e}")
            return None

    def _rule_resolve(
        self,
        question: str,
        history: List[TurnRecord],
        turn_type: TurnType,
    ) -> str:
        """Rule-based context resolution (no LLM)"""
        if not history:
            return question

        last_turn = history[-1]
        resolved = question

        # For REFINE: prepend the previous query context
        if turn_type == TurnType.REFINE:
            # If question starts with refinement keyword, prepend context
            context_parts = []

            # Extract key entities from previous turn
            prev_entities = last_turn.entities
            if prev_entities:
                project = prev_entities.get("project")
                if project:
                    context_parts.append(f"{project}项目中")
                severity = prev_entities.get("severity")
                if severity:
                    context_parts.append(f"{severity}级别的")
                ecu = prev_entities.get("assigned_ecu")
                if ecu:
                    context_parts.append(f"{ecu}的")

            if context_parts:
                prefix = "".join(context_parts)
                resolved = f"{prefix}{question}"

        elif turn_type == TurnType.FOLLOW_UP:
            # For FOLLOW_UP: if question is short, inherit previous subject
            if len(question.strip()) < 15:
                # Use previous question's subject
                prev_q = last_turn.resolved_question or last_turn.question
                resolved = f"关于「{prev_q}」的结果，{question}"

        elif turn_type == TurnType.CLARIFY:
            # For CLARIFY: just use the question as-is (user is correcting)
            resolved = question

        return resolved

    def _format_history(self, history: List[TurnRecord]) -> str:
        """Format conversation history for LLM prompt"""
        lines = []
        # Use last N turns
        for turn in history[-self.max_history_turns:]:
            lines.append(
                f"Q: {turn.question}\n"
                f"A: {turn.result_summary or '(SQL: ' + turn.sql[:60] + ')'}"
            )
        return "\n\n".join(lines)


# ============================================================================
# Conversation Context
# ============================================================================

class ConversationContext:
    """
    Manages multi-turn conversation context.

    Usage:
        ctx = ConversationContext(llm_call_fn=my_fn)

        # Turn 1
        resolved = ctx.resolve("IDCEVO有多少Critical缺陷")
        # → "IDCEVO有多少Critical缺陷" (initial, no change)
        ctx.add_turn(question="IDCEVO有多少Critical缺陷",
                     resolved_question=resolved,
                     sql="SELECT COUNT(*)...",
                     result_summary="23个")

        # Turn 2
        resolved = ctx.resolve("按ECU分布呢")
        # → "IDCEVO项目中Critical缺陷按ECU分布" (refined)

        # Turn 3
        resolved = ctx.resolve("IHU的有多少")
        # → "IDCEVO项目中Critical缺陷中IHU有多少" (follow-up)

        # Get full history
        history = ctx.get_history()
    """

    def __init__(
        self,
        llm_call_fn: Optional[Callable] = None,
        max_history: int = 10,
        session_id: str = "",
    ):
        self.session_id = session_id
        self.max_history = max_history
        self.classifier = TurnClassifier()
        self.resolver = ContextResolver(
            llm_call_fn=llm_call_fn,
            max_history_turns=max_history,
        )
        self._turns: List[TurnRecord] = []

    @property
    def turn_count(self) -> int:
        return len(self._turns)

    @property
    def turns(self) -> List[TurnRecord]:
        return list(self._turns)

    def resolve(self, question: str) -> str:
        """
        Resolve the current question using conversation context.

        Returns the resolved question (may be same as input if initial).
        Does NOT add the turn to history (call add_turn after execution).
        """
        turn_type = self.classifier.classify(question, self._turns)
        return self.resolver.resolve(question, self._turns, turn_type)

    def classify(self, question: str) -> TurnType:
        """Classify the turn type without resolving"""
        return self.classifier.classify(question, self._turns)

    def add_turn(
        self,
        question: str,
        resolved_question: str = "",
        sql: str = "",
        intent: str = "",
        result_summary: str = "",
        result_count: int = 0,
        entities: Optional[Dict[str, Any]] = None,
    ):
        """Record a completed turn"""
        turn_type = self.classifier.classify(question, self._turns)

        turn = TurnRecord(
            turn_index=len(self._turns),
            question=question,
            resolved_question=resolved_question or question,
            sql=sql,
            intent=intent,
            result_summary=result_summary,
            result_count=result_count,
            entities=entities or {},
            turn_type=turn_type,
        )
        self._turns.append(turn)

        # Trim history
        if len(self._turns) > self.max_history:
            self._turns = self._turns[-self.max_history:]

    def get_history(self) -> List[TurnRecord]:
        """Get conversation history"""
        return list(self._turns)

    def get_history_text(self, max_turns: int = 3) -> str:
        """Get formatted history text for prompt injection"""
        turns = self._turns[-max_turns:]
        if not turns:
            return ""

        lines = []
        for t in turns:
            lines.append(
                f"之前问过: {t.question}\n"
                f"结果: {t.result_summary or '已查询'}"
            )
        return "\n\n".join(lines)

    def clear(self):
        """Clear conversation history"""
        self._turns.clear()

    def get_context_summary(self) -> Dict[str, Any]:
        """Get a summary of current conversation state"""
        if not self._turns:
            return {"turn_count": 0, "active_context": False}

        last = self._turns[-1]
        return {
            "turn_count": len(self._turns),
            "active_context": True,
            "last_question": last.question,
            "last_intent": last.intent,
            "last_entities": last.entities,
            "last_turn_type": last.turn_type.value,
        }


# ============================================================================
# Session Manager (multi-session support)
# ============================================================================

class SessionManager:
    """
    Manage conversation contexts for multiple sessions.

    Each session (identified by session_id) has its own ConversationContext.
    Sessions expire after a period of inactivity.
    """

    def __init__(
        self,
        llm_call_fn: Optional[Callable] = None,
        session_timeout: float = 1800,  # 30 minutes
    ):
        self.llm_call_fn = llm_call_fn
        self.session_timeout = session_timeout
        self._sessions: Dict[str, ConversationContext] = {}
        self._last_active: Dict[str, float] = {}

    def get_session(self, session_id: str) -> ConversationContext:
        """Get or create a conversation context for a session"""
        self._cleanup_expired()

        if session_id not in self._sessions:
            self._sessions[session_id] = ConversationContext(
                llm_call_fn=self.llm_call_fn,
                session_id=session_id,
            )

        self._last_active[session_id] = time.time()
        return self._sessions[session_id]

    def remove_session(self, session_id: str):
        """Remove a session"""
        self._sessions.pop(session_id, None)
        self._last_active.pop(session_id, None)

    def _cleanup_expired(self):
        """Remove expired sessions"""
        now = time.time()
        expired = [
            sid for sid, last in self._last_active.items()
            if now - last > self.session_timeout
        ]
        for sid in expired:
            self._sessions.pop(sid, None)
            self._last_active.pop(sid, None)

    def get_active_sessions(self) -> List[str]:
        """Get list of active session IDs"""
        self._cleanup_expired()
        return list(self._sessions.keys())
