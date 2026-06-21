"""SQL Selector - Candidate selection and validation

Selects the best SQL candidate from multiple generated paths.
In production, this uses an LLM for pairwise comparison.
Currently uses rule-based scoring with optional LLM enhancement.
"""

import re
from typing import List, Optional, Dict, Tuple
from dataclasses import dataclass

from agent.sql_engine.generator import SQLCandidate, NL2SQLEngine
from agent.understand.entity_extractor import ExtractionResult
from agent.understand.intent_detector import IntentResult, QueryIntent


@dataclass
class SelectionResult:
    """Result of SQL selection"""
    best: SQLCandidate
    runner_up: Optional[SQLCandidate]
    scores: Dict[str, float]  # path -> score
    reasoning: str


class SQLSelector:
    """
    SQL Candidate Selector.

    Validation checks:
    - SQL syntax
    - Table/column existence (via ontology)
    - Filter coverage (all entities represented?)
    - Intent alignment (aggregation/grouping correct?)

    Selection strategy:
    1. Validate all candidates
    2. Score each
    3. If close scores, prefer plan_based (more structured reasoning)
    """

    # Dangerous SQL patterns
    FORBIDDEN_PATTERNS = [
        r"\bDROP\b",
        r"\bDELETE\b",
        r"\bUPDATE\b",
        r"\bINSERT\b",
        r"\bALTER\b",
        r"\bATTACH\b",
        r"\bDETACH\b",
    ]

    def __init__(self):
        self._forbidden_re = [re.compile(p, re.IGNORECASE) for p in self.FORBIDDEN_PATTERNS]

    def validate(self, sql: str) -> Tuple[bool, Optional[str]]:
        """Validate SQL syntax and safety"""
        # Check forbidden patterns
        for pattern in self._forbidden_re:
            if pattern.search(sql):
                return False, f"Forbidden operation detected"

        # Check basic structure
        if not re.search(r"SELECT\s+", sql, re.IGNORECASE):
            return False, "Missing SELECT"

        if not re.search(r"FROM\s+\w+", sql, re.IGNORECASE):
            return False, "Missing FROM clause"

        # Check balanced parentheses
        if sql.count("(") != sql.count(")"):
            return False, "Unbalanced parentheses"

        return True, None

    def score_candidate(self, candidate: SQLCandidate,
                        question: str,
                        entities: ExtractionResult,
                        intent: IntentResult) -> float:
        """
        Score a candidate. Higher is better.

        Scoring criteria:
        - Base confidence from generator (0.3-0.7)
        - Filter coverage: are all extracted entities in SQL? (+0.1 each)
        - Intent alignment: correct aggregation/grouping? (+0.15)
        - SQL quality: proper columns, no SELECT * abuse (+0.1)
        - Path bonus: plan_based preferred for complex queries (+0.05)
        """
        score = candidate.confidence
        sql_lower = candidate.sql.lower()

        # Filter coverage
        filter_entities = [e for e in entities.entities
                          if e.field and not e.field.startswith("__")
                          and e.entity_type not in ("aggregation", "sort", "metric")]

        for entity in filter_entities:
            if entity.field.lower() in sql_lower:
                score += 0.1
            # Also check if entity value appears
            if entity.value.lower() in sql_lower:
                score += 0.05

        # Intent alignment
        if intent.needs_aggregation and "count" in sql_lower:
            score += 0.1
        if intent.needs_grouping and "group by" in sql_lower:
            score += 0.15
        if intent.needs_timeseries:
            if "strftime" in sql_lower or "date(" in sql_lower:
                score += 0.15
            else:
                score -= 0.2  # Missing time dimension is bad

        # SQL quality
        if intent.primary == QueryIntent.COUNT and "select *" in sql_lower:
            score -= 0.25
        if "limit" not in sql_lower and intent.primary in (QueryIntent.RANKING,
                                                            QueryIntent.DETAIL_LIST):
            score -= 0.1

        # Path bonus
        if candidate.path == "plan_based" and intent.confidence > 0.5:
            score += 0.05
        if candidate.path == "decomposed" and len(filter_entities) >= 3:
            score += 0.05

        # Penalty: WHERE clause missing
        filter_count = len(filter_entities)
        if filter_count > 0 and "where" not in sql_lower:
            score -= 0.4

        return score

    def select(self, candidates: List[SQLCandidate],
               question: str,
               entities: ExtractionResult,
               intent: IntentResult) -> SelectionResult:
        """
        Validate, score, and select the best candidate.
        """
        # Filter valid candidates
        valid = []
        for c in candidates:
            ok, err = self.validate(c.sql)
            if ok:
                valid.append(c)

        if not valid:
            # Return the first candidate even if invalid
            return SelectionResult(
                best=candidates[0] if candidates else SQLCandidate(
                    sql="SELECT COUNT(*) FROM octane_defects",
                    path="emergency_fallback",
                    explanation="All candidates failed validation",
                    confidence=0.1
                ),
                runner_up=None,
                scores={c.path: 0.0 for c in candidates},
                reasoning="No valid candidates; using fallback"
            )

        # Score all valid candidates
        scored = [(c, self.score_candidate(c, question, entities, intent))
                  for c in valid]
        scored.sort(key=lambda x: x[1], reverse=True)

        best = scored[0][0]
        best_score = scored[0][1]
        runner_up = scored[1][0] if len(scored) > 1 else None

        scores_map = {c.path: s for c, s in scored}

        # Reasoning
        margin = best_score - (scored[1][1] if len(scored) > 1 else 0)
        if margin > 0.3:
            reasoning = f"'{best.path}' 路径显著领先(Δ={margin:.2f})"
        elif margin > 0.1:
            reasoning = f"'{best.path}' 路径略优(Δ={margin:.2f})"
        else:
            reasoning = f"候选分数接近，选择 '{best.path}' (plan_based优先)"

        return SelectionResult(
            best=best,
            runner_up=runner_up,
            scores=scores_map,
            reasoning=reasoning
        )
