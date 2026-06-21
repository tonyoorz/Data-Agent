"""
Query Fixer - Self-Correction for SQL

Based on CHASE-SQL ICLR 2025 Algorithm 4 (Query Fixer):
  - Execute SQL → catch error
  - Feed error + original SQL + question to LLM
  - Generate fixed SQL
  - Retry up to β times (β=3)
  - Drop unfixable candidates

This handles:
  - Syntax errors
  - Missing tables/columns
  - Type mismatches
  - Logical errors (detected via result sanity checks)
"""

from __future__ import annotations

import sqlite3
import re
from dataclasses import dataclass
from typing import Optional, Dict, List, Callable
from datetime import datetime


@dataclass
class FixResult:
    """Result of query fixing attempt"""
    fixed_sql: Optional[str]
    success: bool
    iterations: int
    error_message: Optional[str] = None
    reasoning: str = ""


@dataclass
class ExecutionResult:
    """Result of SQL execution"""
    success: bool
    rows: List[Dict]
    error: Optional[str]
    columns: List[str]
    rowcount: int


class QueryFixer:
    """
    Self-correcting SQL executor.

    Workflow:
      1. Try executing SQL
      2. On error, call LLM to fix
      3. Retry with fixed SQL (max β=3 attempts)
      4. If no fix after β attempts, mark as unfixable

    LLM prompt template:
        Error executing SQL: {error_message}
        Original SQL: {original_sql}
        Question we're trying to answer: {question}
        Database schema (relevant tables/columns): {schema_context}
        Please provide a corrected SQL query that fixes the error.
        Explain your reasoning briefly.
    """

    def __init__(self, db_path: str, llm_call_fn: Optional[Callable] = None):
        """
        Args:
            db_path: Path to SQLite database
            llm_call_fn: Optional LLM callable for fixing queries.
                        If None, use rule-based fallback.
        """
        self.db_path = db_path
        self.llm_call_fn = llm_call_fn
        self.max_attempts = 3  # CHASE-SQL uses β=3

    def execute(
        self,
        sql: str,
        question: str = "",
        schema_context: str = ""
    ) -> ExecutionResult:
        """
        Execute SQL with self-correction.

        Args:
            sql: SQL query to execute
            question: Original natural language question (for LLM context)
            schema_context: Database schema info (for LLM context)

        Returns:
            ExecutionResult with rows or error
        """
        current_sql = sql

        for attempt in range(1, self.max_attempts + 1):
            # Try execution
            try:
                result = self._try_execute(current_sql)

                # Sanity check the result
                if result.success:
                    if not self._is_result_sane(result, question):
                        # Result looks wrong (empty/abnormal), try to fix
                        if self.llm_call_fn:
                            fix = self._llm_fix(
                                current_sql,
                                f"Query succeeded but result looks abnormal:\n{self._format_result(result)}",
                                question,
                                schema_context
                            )
                            if fix.success and fix.fixed_sql:
                                current_sql = fix.fixed_sql
                                continue
                        else:
                            # Rule-based fallback: mark as failed
                            result.success = False
                            result.error = "Result sanity check failed"

                if result.success:
                    return result

                # Execution failed (syntax/table error)
                # If no LLM, return error immediately on first attempt
                if not self.llm_call_fn:
                    return result

                # With LLM, try to fix
                if result.error:
                    fix = self._llm_fix(
                        current_sql,
                        result.error,
                        question,
                        schema_context
                    )
                    if fix.success and fix.fixed_sql:
                        current_sql = fix.fixed_sql
                        continue
                    else:
                        return result

            except sqlite3.Error as e:
                # SQL execution error (shouldn't reach here, _try_execute catches)
                if not self.llm_call_fn:
                    return ExecutionResult(
                        success=False,
                        rows=[],
                        error=str(e),
                        columns=[],
                        rowcount=0
                    )

                fix = self._llm_fix(
                    current_sql,
                    str(e),
                    question,
                    schema_context
                )

                if fix.success and fix.fixed_sql:
                    current_sql = fix.fixed_sql
                    continue
                else:
                    return ExecutionResult(
                        success=False,
                        rows=[],
                        error=f"{e} (unfixable after {attempt} attempts)",
                        columns=[],
                        rowcount=0
                    )

        # Max attempts exhausted
        return ExecutionResult(
            success=False,
            rows=[],
            error="Max fix attempts exhausted",
            columns=[],
            rowcount=0
        )

    def _try_execute(self, sql: str) -> ExecutionResult:
        """Attempt single SQL execution"""
        try:
            conn = sqlite3.connect(self.db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(sql)
            rows = cursor.fetchall()

            columns = [d[0] for d in cursor.description] if cursor.description else []
            result_rows = [dict(r) for r in rows]

            conn.close()

            return ExecutionResult(
                success=True,
                rows=result_rows,
                error=None,
                columns=columns,
                rowcount=len(result_rows)
            )

        except sqlite3.Error as e:
            return ExecutionResult(
                success=False,
                rows=[],
                error=str(e),
                columns=[],
                rowcount=0
            )

    def _llm_fix(
        self,
        original_sql: str,
        error_message: str,
        question: str,
        schema_context: str
    ) -> FixResult:
        """
        Use LLM to fix SQL query.

        Returns:
            FixResult with fixed SQL and reasoning
        """
        if not self.llm_call_fn:
            return FixResult(
                fixed_sql=None,
                success=False,
                iterations=0,
                error_message="No LLM available for fixing"
            )

        prompt = f"""
You are a SQL expert. Fix the following SQL query.

## Error
{error_message}

## Original SQL
```sql
{original_sql}
```

## Question
{question}

## Database Schema
{schema_context}

## Instructions
1. Analyze the error and identify what's wrong
2. Provide a corrected SQL query
3. Explain briefly what you fixed

## Output Format
```
REASONING:
Your explanation here...

FIXED_SQL:
SELECT ...
```
"""

        try:
            response = self.llm_call_fn(prompt)

            # Parse response
            reasoning = ""
            fixed_sql = None

            # Extract reasoning
            reasoning_match = re.search(r"REASONING:\s*(.+?)(?=\nFIXED_SQL:|\n\n|$)", response, re.DOTALL)
            if reasoning_match:
                reasoning = reasoning_match.group(1).strip()

            # Extract SQL
            sql_match = re.search(r"FIXED_SQL:\s*(.+?)(?=\n\n|$)", response, re.DOTALL)
            if sql_match:
                fixed_sql = sql_match.group(1).strip()

            # Validate extracted SQL
            if fixed_sql and self._sql_looks_valid(fixed_sql):
                return FixResult(
                    fixed_sql=fixed_sql,
                    success=True,
                    iterations=1,
                    reasoning=reasoning
                )
            else:
                return FixResult(
                    fixed_sql=None,
                    success=False,
                    iterations=1,
                    error_message="Failed to parse valid SQL from LLM response"
                )

        except Exception as e:
            return FixResult(
                fixed_sql=None,
                success=False,
                iterations=1,
                error_message=f"LLM fix failed: {str(e)}"
            )

    def _sql_looks_valid(self, sql: str) -> bool:
        """Basic validation that extracted text looks like SQL"""
        sql = sql.strip()

        # Must start with SELECT or other DML (not DROP/DELETE/UPDATE for safety)
        if not re.match(r"^\s*(SELECT|WITH|SELECT\s+)", sql, re.IGNORECASE):
            return False

        # Check for forbidden operations
        forbidden = ["DROP", "DELETE", "UPDATE", "INSERT", "ALTER", "TRUNCATE"]
        for op in forbidden:
            if re.search(rf"\b{op}\b", sql, re.IGNORECASE):
                return False

        return True

    def _is_result_sane(self, result: ExecutionResult, question: str) -> bool:
        """
        Check if execution result looks reasonable.

        Heuristics:
        - For count queries: result should be a single number, not empty
        - For ranking/distribution: result should have > 0 rows
        - For all queries: result shouldn't be suspiciously large (>10K rows)
        - Values shouldn't all be the same (possible bug)
        """
        # Empty result might be OK for count (should be 0), but check
        if result.rowcount == 0:
            # For queries expecting data, empty is suspicious
            # Check if question words suggest expecting data
            data_words = ["多少", "数量", "有几个", "top", "排名", "分布"]
            if any(word in question.lower() for word in data_words):
                return False

        # Too many rows (likely a bug or unintended full scan)
        if result.rowcount > 10000:
            return False

        # All values identical (possible bug)
        if len(result.rows) > 1:
            first_value = result.rows[0].get(result.columns[0]) if result.columns else None
            if first_value is not None:
                all_same = all(r.get(result.columns[0]) == first_value for r in result.rows)
                if all_same:
                    return False

        return True

    def _format_result(self, result: ExecutionResult) -> str:
        """Format result for LLM error message"""
        if not result.rows:
            return f"Empty result (0 rows), columns: {result.columns}"

        if result.rowcount <= 3:
            sample = result.rows
        else:
            sample = result.rows[:3]

        return f"""
Result stats:
  - Rows: {result.rowcount}
  - Columns: {result.columns}

Sample rows:
{sample}
""".strip()