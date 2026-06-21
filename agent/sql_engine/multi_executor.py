"""Multi-Path SQL Executor — Execute and compare all candidate SQLs

Inspired by CHASE-SQL (ICLR 2025) + PV-SQL (2026):
    Instead of picking one SQL based on static scoring, EXECUTE all candidates
    and compare their results. This catches subtle SQL bugs that pass
    syntax validation but produce wrong answers.

Pipeline:
    1. Execute each valid candidate SQL
    2. Compare results:
       a. All agree → high confidence, return best
       b. 2 of 3 agree → medium confidence, return majority
       c. All disagree → low confidence, use LLM to pick (or fallback to scoring)

    3. If LLM available: pairwise comparison of top-2 results vs question

Usage:
    from agent.sql_engine.multi_executor import MultiPathExecutor

    executor = MultiPathExecutor(db_path="...")
    result = executor.execute_and_compare(
        candidates=[sql1, sql2, sql3],
        question="IDCEVO有多少Critical缺陷",
        question="...",
    )
    # result.best_sql, result.best_data, result.confidence, result.agreement
"""

from __future__ import annotations

import sqlite3
import logging
from typing import List, Optional, Dict, Any, Tuple
from dataclasses import dataclass, field
from enum import Enum
import json

logger = logging.getLogger(__name__)


class AgreementLevel(Enum):
    """How well candidates agree"""
    UNANIMOUS = "unanimous"     # All candidates produce same result
    MAJORITY = "majority"       # 2/3 agree
    DISAGREE = "disagree"       # All different
    SINGLE = "single"           # Only one valid candidate


@dataclass
class CandidateResult:
    """Result of executing one candidate SQL"""
    sql: str
    path: str               # direct / decomposed / plan_based
    success: bool
    data: List[Dict] = field(default_factory=list)
    row_count: int = 0
    error: str = ""
    execution_ms: float = 0.0

    @property
    def data_signature(self) -> str:
        """
        A normalized signature of the result data for comparison.
        Two results with the same signature are considered equivalent.
        """
        if not self.success or not self.data:
            return f"empty:{self.success}"

        # For count queries (1 row, 1 col), signature is the value
        if len(self.data) == 1 and len(self.data[0]) == 1:
            val = list(self.data[0].values())[0]
            return f"scalar:{val}"

        # For multi-row results, compare row count + first col values
        first_col = list(self.data[0].keys())[0] if self.data[0] else ""
        values = [str(row.get(first_col, "")) for row in self.data[:20]]
        return f"rows:{self.row_count}:{first_col}:{','.join(values)}"


@dataclass
class MultiPathResult:
    """Result of multi-path execution and comparison"""
    best_sql: str
    best_data: List[Dict]
    best_path: str
    agreement: AgreementLevel
    confidence: float                    # 0-1
    all_results: List[CandidateResult] = field(default_factory=list)
    llm_verdict: str = ""               # LLM reasoning if used
    reasoning: str = ""

    @property
    def row_count(self) -> int:
        return len(self.best_data)


class MultiPathExecutor:
    """
    Execute all candidate SQLs and pick the best based on result comparison.

    This is the execution-guided selection layer that complements
    the static SQLSelector scoring.
    """

    def __init__(
        self,
        db_path: str,
        llm_call_fn: Optional = None,
        max_candidates: int = 3,
    ):
        self.db_path = db_path
        self.llm_call_fn = llm_call_fn
        self.max_candidates = max_candidates

    def execute_and_compare(
        self,
        candidates: List,  # List[SQLCandidate]
        question: str = "",
        intent: str = "",
    ) -> MultiPathResult:
        """
        Execute all candidates, compare results, and select the best.

        Args:
            candidates: List of SQLCandidate objects
            question: Original user question (for LLM comparison)
            intent: Detected intent type

        Returns:
            MultiPathResult with best SQL and comparison metadata
        """
        if not candidates:
            return MultiPathResult(
                best_sql="SELECT COUNT(*) FROM octane_defects",
                best_data=[],
                best_path="fallback",
                agreement=AgreementLevel.SINGLE,
                confidence=0.1,
                reasoning="No candidates provided",
            )

        # Step 1: Execute all candidates
        results = []
        for cand in candidates[:self.max_candidates]:
            r = self._execute_one(cand.sql, cand.path)
            results.append(r)

        # Step 2: Filter successful
        successful = [r for r in results if r.success]
        failed = [r for r in results if not r.success]

        if len(successful) == 0:
            # All failed — return first with error
            return MultiPathResult(
                best_sql=candidates[0].sql,
                best_data=[],
                best_path=candidates[0].path,
                agreement=AgreementLevel.DISAGREE,
                confidence=0.0,
                all_results=results,
                reasoning=f"All {len(results)} candidates failed: {failed[0].error if failed else 'unknown'}",
            )

        if len(successful) == 1:
            # Only one succeeded
            return MultiPathResult(
                best_sql=successful[0].sql,
                best_data=successful[0].data,
                best_path=successful[0].path,
                agreement=AgreementLevel.SINGLE,
                confidence=0.7,
                all_results=results,
                reasoning=f"Only '{successful[0].path}' succeeded ({successful[0].row_count} rows)",
            )

        # Step 3: Compare results
        agreement = self._check_agreement(successful)

        if agreement == AgreementLevel.UNANIMOUS:
            # All agree! High confidence
            best = successful[0]
            return MultiPathResult(
                best_sql=best.sql,
                best_data=best.data,
                best_path=best.path,
                agreement=agreement,
                confidence=0.95,
                all_results=results,
                reasoning=f"All {len(successful)} candidates agree ({best.row_count} rows)",
            )

        if agreement == AgreementLevel.MAJORITY and len(successful) >= 3:
            # 2 of 3 agree — return majority
            majority_result = self._find_majority(successful)
            return MultiPathResult(
                best_sql=majority_result.sql,
                best_data=majority_result.data,
                best_path=majority_result.path,
                agreement=agreement,
                confidence=0.80,
                all_results=results,
                reasoning=f"Majority agreement (2/3), selecting '{majority_result.path}'",
            )

        # Step 4: Disagreement — try LLM arbitration
        if self.llm_call_fn and question:
            return self._llm_arbitrate(successful, question, intent, results)

        # No LLM — fallback to highest scoring path preference
        # Preference order: plan_based > decomposed > direct
        preference = {"plan_based": 3, "decomposed": 2, "direct": 1}
        successful.sort(
            key=lambda r: preference.get(r.path, 0),
            reverse=True
        )
        best = successful[0]
        return MultiPathResult(
            best_sql=best.sql,
            best_data=best.data,
            best_path=best.path,
            agreement=agreement,
            confidence=0.5,
            all_results=results,
            reasoning=f"Candidates disagree; selected '{best.path}' (path preference fallback)",
        )

    # ==================== Execution ====================

    def _execute_one(self, sql: str, path: str) -> CandidateResult:
        """Execute a single SQL and return result"""
        import time
        t0 = time.time()

        try:
            conn = sqlite3.connect(self.db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute(sql)
            rows = [dict(row) for row in cursor.fetchall()]
            conn.close()

            latency = (time.time() - t0) * 1000
            return CandidateResult(
                sql=sql,
                path=path,
                success=True,
                data=rows,
                row_count=len(rows),
                execution_ms=latency,
            )
        except Exception as e:
            latency = (time.time() - t0) * 1000
            return CandidateResult(
                sql=sql,
                path=path,
                success=False,
                error=str(e),
                execution_ms=latency,
            )

    # ==================== Agreement Checking ====================

    def _check_agreement(self, results: List[CandidateResult]) -> AgreementLevel:
        """Check how well results agree"""
        if len(results) <= 1:
            return AgreementLevel.SINGLE

        signatures = [r.data_signature for r in results]
        unique_sigs = set(signatures)

        if len(unique_sigs) == 1:
            return AgreementLevel.UNANIMOUS
        elif len(results) >= 3 and len(unique_sigs) == 2:
            return AgreementLevel.MAJORITY
        else:
            return AgreementLevel.DISAGREE

    def _find_majority(self, results: List[CandidateResult]) -> CandidateResult:
        """Find the majority result (shared by 2+ candidates)"""
        sig_groups: Dict[str, List[CandidateResult]] = {}
        for r in results:
            sig = r.data_signature
            if sig not in sig_groups:
                sig_groups[sig] = []
            sig_groups[sig].append(r)

        # Find the group with most members
        majority_group = max(sig_groups.values(), key=len)
        return majority_group[0]

    # ==================== LLM Arbitration ====================

    def _llm_arbitrate(
        self,
        results: List[CandidateResult],
        question: str,
        intent: str,
        all_results: List[CandidateResult],
    ) -> MultiPathResult:
        """Use LLM to pick the best result when candidates disagree"""

        # Prepare comparison prompt
        candidates_text = []
        for i, r in enumerate(results):
            sample = r.data[:5]
            candidates_text.append(
                f"候选 {i+1} (路径: {r.path}):\n"
                f"  SQL: {r.sql}\n"
                f"  行数: {r.row_count}\n"
                f"  样本: {json.dumps(sample, ensure_ascii=False, default=str)[:300]}\n"
            )

        prompt = f"""你是SQL结果评审专家。多个SQL候选对同一问题产生了不同结果，请判断哪个最正确。

## 用户问题
{question}

## 意图
{intent}

## 候选结果
{chr(10).join(candidates_text)}

## 评审标准
1. SQL逻辑是否正确（JOIN/WHERE/GROUP BY）
2. 结果是否回答了用户问题
3. 数据量是否合理

## 输出格式
回复 JSON:
{{"best": <候选编号1-3>, "reason": "<简要原因>"}}
只回复 JSON，不要其他内容。"""

        try:
            response = self.llm_call_fn(prompt).strip()

            # Parse JSON response
            # Handle cases where LLM wraps in markdown
            if "```" in response:
                response = response.split("```")[1]
                if response.startswith("json"):
                    response = response[4:]
            response = response.strip("` \n")

            verdict = json.loads(response)
            best_idx = int(verdict["best"]) - 1  # 1-indexed → 0-indexed

            if 0 <= best_idx < len(results):
                chosen = results[best_idx]
                return MultiPathResult(
                    best_sql=chosen.sql,
                    best_data=chosen.data,
                    best_path=chosen.path,
                    agreement=AgreementLevel.DISAGREE,
                    confidence=0.75,
                    all_results=all_results,
                    llm_verdict=verdict.get("reason", ""),
                    reasoning=f"LLM selected '{chosen.path}' (候选{best_idx+1}): {verdict.get('reason', '')}",
                )

        except (json.JSONDecodeError, ValueError, IndexError) as e:
            logger.warning(f"LLM arbitration parse error: {e}")
        except Exception as e:
            logger.warning(f"LLM arbitration failed: {e}")

        # Fallback: prefer plan_based
        preference = {"plan_based": 3, "decomposed": 2, "direct": 1}
        results.sort(key=lambda r: preference.get(r.path, 0), reverse=True)
        best = results[0]
        return MultiPathResult(
            best_sql=best.sql,
            best_data=best.data,
            best_path=best.path,
            agreement=AgreementLevel.DISAGREE,
            confidence=0.5,
            all_results=all_results,
            reasoning="LLM arbitration failed; path preference fallback",
        )
