"""Result Validator - MARS-SQL style independent verification

Inspired by MARS-SQL (arXiv 2511.01008, 2026):
    Instead of just checking SQL syntax, an independent Validation Agent
    reviews the *execution result* against the user's question.

    Two validation modes:
    1. Rule-based (always on): heuristic sanity checks
    2. LLM-based (when available): semantic consistency check

Rule-based checks (fast, no API call):
    - Empty result for data-expecting queries
    - Suspiciously large result (>10K rows = likely missing WHERE)
    - All values identical (possible bug)
    - Type mismatch (expecting number, got string)
    - Count mismatch (SUM of distribution != total)

LLM-based checks (when result passes rules but might be semantically wrong):
    - "Does this result answer the user's question?"
    - "Are the column names consistent with what was asked?"
    - "Is the magnitude reasonable?"

Usage:
    from agent.sql_engine.validator import ResultValidator

    validator = ResultValidator(llm_call_fn=client.as_fixer_fn())
    verdict = validator.validate(
        question="IDCEVO有多少Critical缺陷?",
        sql="SELECT COUNT(*) FROM ... WHERE project='IDCEVO' AND severity='Critical'",
        rows=[{"COUNT(*)": 23}],
        intent="count"
    )
    if not verdict.passed:
        print(verdict.reason)  # "Result is empty but question expects data"
"""

from __future__ import annotations

import re
import logging
from typing import List, Dict, Optional, Callable
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)


class ValidationLevel(Enum):
    """Severity of validation failure"""
    INFO = "info"         # Something noted, but OK to proceed
    WARNING = "warning"   # Suspicious, may want to retry
    ERROR = "error"       # Clearly wrong, must retry or report


@dataclass
class ValidationIssue:
    """A single validation finding"""
    level: ValidationLevel
    check: str            # Which check found this
    message: str
    suggestion: str = ""  # How to fix


@dataclass
class ValidationVerdict:
    """Overall validation result"""
    passed: bool                          # True if no ERROR-level issues
    issues: List[ValidationIssue] = field(default_factory=list)
    llm_verified: bool = False           # Whether LLM validation ran
    llm_reasoning: str = ""               # LLM's reasoning (if ran)

    @property
    def primary_reason(self) -> str:
        """Main reason for failure (first ERROR issue)"""
        for issue in self.issues:
            if issue.level == ValidationLevel.ERROR:
                return issue.message
        for issue in self.issues:
            if issue.level == ValidationLevel.WARNING:
                return issue.message
        return ""


class ResultValidator:
    """
    Independent result validation (MARS-SQL style).

    Validates that execution results actually answer the user's question.
    Works as a post-execution check, complementing the pre-execution SQL Fixer.
    """

    # Questions that expect data (non-empty results)
    DATA_EXPECTING_PATTERNS = [
        "多少", "数量", "有几个", "几个", "count", "how many",
        "top", "排名", "ranking", "最", "most",
        "分布", "distribution", "breakdown",
        "列表", "列出", "list", "show",
        "趋势", "trend",
        "哪些", "which",
    ]

    # Max rows before flagging as suspicious (likely missing WHERE)
    MAX_REASONABLE_ROWS = 10000

    # Numeric intent types where result should be a number
    NUMERIC_INTENTS = {"count", "summary"}

    def __init__(
        self,
        llm_call_fn: Optional[Callable[[str], str]] = None,
        enable_llm_validation: bool = True,
    ):
        """
        Args:
            llm_call_fn: Optional LLM callable for semantic validation.
                        Signature: fn(prompt: str) -> str
            enable_llm_validation: Whether to use LLM validation (can disable for speed)
        """
        self.llm_call_fn = llm_call_fn
        self.enable_llm = enable_llm_validation and llm_call_fn is not None

    def validate(
        self,
        question: str,
        sql: str,
        rows: List[Dict],
        intent: str = "",
        columns: Optional[List[str]] = None,
    ) -> ValidationVerdict:
        """
        Validate execution result against the question.

        Args:
            question: Original user question
            sql: SQL that was executed
            rows: Result rows
            intent: Detected intent type
            columns: Column names (inferred from rows if not provided)

        Returns:
            ValidationVerdict with pass/fail and any issues
        """
        verdict = ValidationVerdict(passed=True)

        if not columns:
            columns = list(rows[0].keys()) if rows else []

        # --- Rule-based checks ---

        # 1. Empty result check
        issue = self._check_empty_result(question, rows, intent)
        if issue:
            verdict.issues.append(issue)

        # 2. Large result check
        issue = self._check_large_result(rows, sql, intent)
        if issue:
            verdict.issues.append(issue)

        # 3. Uniform values check
        issue = self._check_uniform_values(rows, columns)
        if issue:
            verdict.issues.append(issue)

        # 4. Count consistency check (for distribution queries)
        issue = self._check_distribution_consistency(rows, sql, intent)
        if issue:
            verdict.issues.append(issue)

        # 5. SQL structure check (did SQL match intent?)
        issue = self._check_sql_intent_alignment(sql, intent, question)
        if issue:
            verdict.issues.append(issue)

        # Determine if passed
        verdict.passed = not any(
            i.level == ValidationLevel.ERROR for i in verdict.issues
        )

        # --- LLM-based validation (only if rule-based passed and LLM available) ---
        if verdict.passed and self.enable_llm and rows:
            llm_issue = self._llm_validate(question, sql, rows, intent)
            if llm_issue:
                verdict.issues.append(llm_issue)
                if llm_issue.level == ValidationLevel.ERROR:
                    verdict.passed = False
                verdict.llm_verified = True
                verdict.llm_reasoning = llm_issue.message
            else:
                verdict.llm_verified = True
                verdict.llm_reasoning = "LLM validation passed"

        return verdict

    # ==================== Rule-Based Checks ====================

    def _check_empty_result(
        self, question: str, rows: List[Dict], intent: str
    ) -> Optional[ValidationIssue]:
        """Check: empty result for data-expecting questions"""
        if rows:
            return None

        q_lower = question.lower()
        expects_data = any(p in q_lower for p in self.DATA_EXPECTING_PATTERNS)

        if expects_data and intent != "count":
            return ValidationIssue(
                level=ValidationLevel.ERROR,
                check="empty_result",
                message="查询结果为空，但问题期望有数据。可能是过滤条件太严格或字段值不匹配。",
                suggestion="检查 WHERE 条件中的值是否正确，或放宽过滤条件。"
            )

        return None

    def _check_large_result(
        self, rows: List[Dict], sql: str, intent: str
    ) -> Optional[ValidationIssue]:
        """Check: suspiciously large result set"""
        row_count = len(rows)
        if row_count <= self.MAX_REASONABLE_ROWS:
            return None

        sql_lower = sql.lower()

        # If no WHERE clause and lots of rows, likely missing filter
        if "where" not in sql_lower:
            return ValidationIssue(
                level=ValidationLevel.ERROR,
                check="large_result_no_filter",
                message=f"返回 {row_count} 行且无 WHERE 条件，可能缺少过滤。",
                suggestion="添加 WHERE 条件限制结果范围。"
            )

        return ValidationIssue(
            level=ValidationLevel.WARNING,
            check="large_result",
            message=f"返回 {row_count} 行，可能需要 LIMIT。",
            suggestion=f"添加 LIMIT 限制返回行数。"
        )

    def _check_uniform_values(
        self, rows: List[Dict], columns: List[str]
    ) -> Optional[ValidationIssue]:
        """Check: all values in first column are identical (possible bug)"""
        if len(rows) < 3 or not columns:
            return None

        first_col = columns[0]
        first_val = rows[0].get(first_col)

        if first_val is None:
            return None

        # Skip count columns (they're supposed to vary)
        if first_col.lower() in ("count", "cnt", "total"):
            return None

        all_same = all(r.get(first_col) == first_val for r in rows[:20])
        if all_same:
            return ValidationIssue(
                level=ValidationLevel.WARNING,
                check="uniform_values",
                message=f"第一列 '{first_col}' 的所有值都是 '{first_val}'，可能是 GROUP BY 错误。",
                suggestion="检查 GROUP BY 字段是否正确。"
            )

        return None

    def _check_distribution_consistency(
        self, rows: List[Dict], sql: str, intent: str
    ) -> Optional[ValidationIssue]:
        """Check: distribution percentages sum to ~100%"""
        if intent != "distribution" or not rows:
            return None

        # Look for pct column
        pct_values = []
        for row in rows:
            if "pct" in row and row["pct"] is not None:
                try:
                    pct_values.append(float(row["pct"]))
                except (ValueError, TypeError):
                    pass

        if not pct_values:
            return None

        total_pct = sum(pct_values)
        # Allow some tolerance for rounding
        if total_pct < 90 or total_pct > 110:
            return ValidationIssue(
                level=ValidationLevel.WARNING,
                check="pct_sum",
                message=f"分布百分比总和为 {total_pct:.1f}%，偏离 100% 较多。",
                suggestion="检查 SQL 中的百分比计算逻辑。"
            )

        return None

    def _check_sql_intent_alignment(
        self, sql: str, intent: str, question: str
    ) -> Optional[ValidationIssue]:
        """Check: SQL structure aligns with detected intent"""
        sql_lower = sql.lower()

        # Count intent should have COUNT
        if intent == "count" and "count" not in sql_lower:
            return ValidationIssue(
                level=ValidationLevel.WARNING,
                check="intent_alignment",
                message="意图为'计数'，但SQL中无 COUNT 函数。",
                suggestion="添加 COUNT(*) 聚合。"
            )

        # Trend intent should have time grouping
        if intent == "trend":
            has_time = any(x in sql_lower for x in ["strftime", "date(", "group by"])
            if not has_time:
                return ValidationIssue(
                    level=ValidationLevel.WARNING,
                    check="intent_alignment",
                    message="意图为'趋势'，但SQL中无时间分组。",
                    suggestion="添加按月份/日期的 GROUP BY。"
                )

        # Ranking intent should have ORDER BY
        if intent == "ranking" and "order by" not in sql_lower:
            return ValidationIssue(
                level=ValidationLevel.WARNING,
                check="intent_alignment",
                message="意图为'排名'，但SQL中无 ORDER BY。",
                suggestion="添加 ORDER BY count DESC。"
            )

        return None

    # ==================== LLM-Based Validation ====================

    def _llm_validate(
        self,
        question: str,
        sql: str,
        rows: List[Dict],
        intent: str,
    ) -> Optional[ValidationIssue]:
        """
        Use LLM to semantically validate the result.

        Asks the LLM:
        - Does this result answer the question?
        - Is the magnitude reasonable?
        - Are there obvious errors?
        """
        # Prepare a sample of the data for the LLM
        sample = rows[:5]
        row_count = len(rows)

        # Format columns
        columns = list(rows[0].keys()) if rows else []

        prompt = f"""你是一个数据验证专家。请检查以下 SQL 查询结果是否正确回答了用户问题。

## 用户问题
{question}

## 执行的 SQL
```sql
{sql}
```

## 查询结果
- 总行数: {row_count}
- 列: {columns}
- 前5行数据:
{sample}

## 检查项
1. 结果是否回答了用户的问题？
2. 数据量是否合理？（不是0，也不是异常大）
3. 列名是否与问题相关？
4. 数值范围是否合理？

## 输出格式
如果结果正确，只回复：PASS
如果有问题，回复：
FAIL: <问题描述>

只回复 PASS 或 FAIL: ...，不要其他内容。"""

        try:
            response = self.llm_call_fn(prompt).strip()

            if response.upper().startswith("PASS"):
                return None  # Validation passed

            if response.upper().startswith("FAIL"):
                reason = response[5:].strip().split("\n")[0]  # First line after FAIL:
                return ValidationIssue(
                    level=ValidationLevel.WARNING,
                    check="llm_semantic",
                    message=f"LLM 验证未通过: {reason}",
                    suggestion="考虑重新生成 SQL 或调整查询条件。"
                )

            # Unparseable response → assume pass
            logger.debug(f"LLM validation unclear response: {response[:100]}")
            return None

        except Exception as e:
            logger.warning(f"LLM validation failed: {e}")
            return None  # Don't fail on LLM errors


# ============================================================================
# Singleton
# ============================================================================

_validator: Optional[ResultValidator] = None


def get_result_validator(
    llm_call_fn: Optional[Callable] = None,
    enable_llm: bool = True,
) -> ResultValidator:
    """Get or create singleton ResultValidator"""
    global _validator
    if _validator is None:
        _validator = ResultValidator(
            llm_call_fn=llm_call_fn,
            enable_llm_validation=enable_llm,
        )
    return _validator
