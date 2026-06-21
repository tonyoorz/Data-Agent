"""CHASE-SQL Multi-Path SQL Generator

Inspired by CHASE-SQL (ICLR 2025): generates multiple SQL candidates
via different reasoning paths, then selects the best.

Three generation paths:
- Path A: Direct generation (NL → SQL with full context)
- Path B: Divide & Conquer (decompose into sub-queries, combine)
- Path C: Execution plan reasoning (step-by-step plan → SQL)

A selection LLM (or heuristic) then compares candidate results pairwise
and picks the best answer.
"""

import re
import json
from typing import List, Optional, Dict, Tuple
from dataclasses import dataclass, field
from pathlib import Path

from agent.ontology import OntologyEngine, get_ontology_engine
from agent.context.engine import ContextEngine
from agent.understand.term_resolver import get_term_resolver
from agent.understand.entity_extractor import EntityExtractor, get_entity_extractor, ExtractionResult
from agent.understand.intent_detector import IntentDetector, get_intent_detector, QueryIntent, IntentResult
from agent.sql_engine.examples import get_examples_by_intent, get_similar_examples
from agent.sql_engine.validator import ResultValidator, get_result_validator


@dataclass
class SQLCandidate:
    """A generated SQL candidate"""
    sql: str
    path: str           # "direct", "decomposed", "plan_based"
    explanation: str    # Reasoning behind this SQL
    confidence: float = 0.5


@dataclass
class QueryResult:
    """Final result of NL→SQL query"""
    question: str
    sql: str                        # Best SQL
    data: List[Dict] = field(default_factory=list)  # Query results
    answer: str = ""                # Natural language answer
    intent: str = ""
    candidates: List[SQLCandidate] = field(default_factory=list)
    entities: ExtractionResult = None
    error: Optional[str] = None
    validation_issues: List[Dict] = field(default_factory=list)   # MARS validation findings
    validation_llm_verified: bool = False


class SQLGenerator:
    """
    Base SQL generator using Ontology context + entity extraction.
    Provides shared logic for all generation paths.
    """

    def __init__(self, ontology: Optional[OntologyEngine] = None,
                 db_path: Optional[str] = None):
        self.ontology = ontology or get_ontology_engine()
        self.term_resolver = get_term_resolver(ontology)
        self.entity_extractor = get_entity_extractor(ontology)
        self.intent_detector = get_intent_detector()
        self.context_engine = ContextEngine(ontology=self.ontology, db_path=db_path)

    def analyze_question(self, question: str) -> Tuple[ExtractionResult, IntentResult, str]:
        """
        Full analysis: entity extraction + intent detection + context building.
        Shared across all generation paths.
        """
        # Extract entities
        entities = self.entity_extractor.extract(question)

        # Detect intent
        intent = self.intent_detector.detect(question, entities)

        # Build context
        context = self.context_engine.build_context(
            object_type="Defect",
            question=question,
            include_layers=[1, 2, 3, 4]  # Skip behavioral for now
        )

        return entities, intent, context

    def build_where_clause(self, entities: ExtractionResult,
                           object_type: str = "Defect") -> str:
        """
        Build WHERE clause from extracted entities.
        """
        filters = self.entity_extractor.to_sql_filters(entities, object_type)
        if not filters:
            return "1=1"
        return " AND ".join(filters)

    def resolve_group_field(self, question: str, entities: ExtractionResult) -> str:
        """Determine the GROUP BY field from question/entities"""
        # Check entities for grouping hints
        for entity in entities.entities:
            if entity.entity_type in ("project", "ecu", "severity", "status",
                                       "team", "test_phase", "aida", "market"):
                return entity.field

        # Check question text
        field_hints = {
            "项目": "project",
            "ECU": "assigned_ecu",
            "严重": "severity",
            "状态": "status_phase",
            "团队": "team",
            "阶段": "phase",
            "域": "top_aida",
        }
        for keyword, field_name in field_hints.items():
            if keyword in question:
                return field_name

        return "project"  # Default

    def resolve_time_field(self, question: str) -> str:
        """Determine time field for trend queries"""
        return "creation_time"  # Always use creation_time for trends

    def resolve_limit(self, entities: ExtractionResult, default: int = 20) -> int:
        """Extract LIMIT from entities or return default"""
        limit_entity = entities.get_first("limit")
        if limit_entity:
            return int(limit_entity.value)
        return default


class DirectGenerator(SQLGenerator):
    """
    Path A: Direct NL→SQL generation.

    Uses full context + few-shot examples to generate SQL directly.
    Best for straightforward queries.
    """

    def generate(self, question: str) -> SQLCandidate:
        entities, intent, context = self.analyze_question(question)

        # Get relevant few-shot examples
        examples = get_examples_by_intent(intent.primary.value, top_k=3)
        examples_text = "\n".join(
            f"问: {ex['question']}\nSQL: {ex['sql']}" for ex in examples
        )

        # Build SQL from template
        where_clause = self.build_where_clause(entities)
        table = self.ontology.get_object("Defect").source_table
        group_field = self.resolve_group_field(question, entities)
        time_field = self.resolve_time_field(question)
        limit = self.resolve_limit(entities)
        id_field = self.ontology.get_object("Defect").primary_key

        sql = self._fill_template(
            intent.sql_template,
            table=table,
            filters=where_clause,
            group_field=group_field,
            time_field=time_field,
            limit=limit,
            id_field=id_field
        )

        return SQLCandidate(
            sql=sql,
            path="direct",
            explanation=f"直接生成: intent={intent.primary.value}, "
                       f"filters={where_clause[:80]}...",
            confidence=0.6
        )

    def _fill_template(self, template: str, **kwargs) -> str:
        """Fill in SQL template placeholders"""
        sql = template
        for key, value in kwargs.items():
            sql = sql.replace("{" + key + "}", str(value))

        # Clean up: if no LIMIT in template, don't add
        sql = sql.replace(" LIMIT {limit}", f" LIMIT {kwargs.get('limit', 20)}")
        sql = sql.rstrip()

        return sql


class DecomposedGenerator(SQLGenerator):
    """
    Path B: Divide & Conquer.

    Decomposes complex questions into sub-questions, generates SQL for each,
    then combines results.

    Best for: "IDCEVO 各ECU的Critical缺陷，按团队分布"
    → Sub-1: WHERE project=IDCEVO AND severity=Critical GROUP BY assigned_ecu
    → Sub-2: WHERE project=IDCEVO AND severity=Critical GROUP BY team
    → Combine: GROUP BY assigned_ecu, team
    """

    def generate(self, question: str) -> SQLCandidate:
        entities, intent, context = self.analyze_question(question)

        table = self.ontology.get_object("Defect").source_table
        where_clause = self.build_where_clause(entities)

        # Identify multiple dimensions in the question
        dimensions = self._find_dimensions(question, entities)

        if len(dimensions) >= 2 and intent.needs_grouping:
            # Multi-dimensional grouping
            group_fields = ", ".join(dimensions)
            sql = f"SELECT {group_fields}, COUNT(*) as count FROM {table} WHERE {where_clause} GROUP BY {group_fields} ORDER BY count DESC"
        elif intent.needs_timeseries and dimensions:
            # Time series + dimension
            time_field = self.resolve_time_field(question)
            dim = dimensions[0]
            sql = (f"SELECT strftime('%Y-%m', {time_field}) as month, {dim}, "
                   f"COUNT(*) as count FROM {table} WHERE {where_clause} "
                   f"GROUP BY strftime('%Y-%m', {time_field}), {dim} "
                   f"ORDER BY month, {dim}")
        elif intent.primary == QueryIntent.COUNT and entities.has("numeric_constraint"):
            # Numeric constraint: HAVING COUNT > N
            nc_entity = entities.get_first("numeric_constraint")
            if nc_entity:
                group_field = self.resolve_group_field(question, entities)
                op = nc_entity.operator if nc_entity.operator != "=" else ">"
                sql = (f"SELECT {group_field}, COUNT(*) as count FROM {table} "
                       f"WHERE {where_clause} GROUP BY {group_field} "
                       f"HAVING COUNT(*) {op} {nc_entity.value} ORDER BY count DESC")
            else:
                sql = f"SELECT COUNT(*) FROM {table} WHERE {where_clause}"
        else:
            # Fall back to simple query
            if intent.needs_grouping:
                group_field = self.resolve_group_field(question, entities)
                sql = f"SELECT {group_field}, COUNT(*) as count FROM {table} WHERE {where_clause} GROUP BY {group_field} ORDER BY count DESC"
            elif intent.needs_aggregation:
                sql = f"SELECT COUNT(*) FROM {table} WHERE {where_clause}"
            else:
                limit = self.resolve_limit(entities)
                sql = f"SELECT * FROM {table} WHERE {where_clause} LIMIT {limit}"

        return SQLCandidate(
            sql=sql,
            path="decomposed",
            explanation=f"分治策略: dimensions={dimensions}, intent={intent.primary.value}",
            confidence=0.65
        )

    def _find_dimensions(self, question: str, entities: ExtractionResult) -> List[str]:
        """Find grouping dimensions from question and entities"""
        dims = []
        seen = set()

        # From entities
        dim_types = ["project", "ecu", "severity", "status", "team",
                     "test_phase", "aida", "market", "solution_cluster"]
        for entity in entities.entities:
            if entity.entity_type in dim_types and entity.field not in seen:
                dims.append(entity.field)
                seen.add(entity.field)

        # From question text
        text_dims = {
            "项目": "project", "ECU": "assigned_ecu", "严重": "severity",
            "状态": "status_phase", "团队": "team", "阶段": "phase",
            "域": "top_aida", "市场": "market",
        }
        for keyword, field_name in text_dims.items():
            if keyword in question and field_name not in seen:
                # Only add if it's a grouping dimension (not a filter)
                has_filter = any(e.field == field_name for e in entities.entities
                                if e.entity_type in dim_types)
                if not has_filter:
                    dims.append(field_name)
                    seen.add(field_name)

        return dims


class PlanBasedGenerator(SQLGenerator):
    """
    Path C: Execution plan reasoning.

    Creates a step-by-step execution plan, then generates SQL.
    Best for complex analytical queries.

    Example:
        "IDCEVO 风险最高的3个缺陷"
        → Plan:
          1. Filter: project = 'IDCEVO'
          2. Order by: risk_score DESC
          3. Limit: 3
        → SQL: SELECT defect_id, name, severity, ... FROM octane_defects
               WHERE project = 'IDCEVO' ORDER BY severity DESC, creation_time DESC LIMIT 3
    """

    def generate(self, question: str) -> SQLCandidate:
        entities, intent, context = self.analyze_question(question)

        table = self.ontology.get_object("Defect").source_table
        pk = self.ontology.get_object("Defect").primary_key
        where_clause = self.build_where_clause(entities)

        # Build execution plan
        plan_steps = []

        # Step 1: Base filter
        plan_steps.append(f"1. 过滤: WHERE {where_clause}")

        # Step 2: Determine SELECT columns
        if intent.primary in (QueryIntent.COUNT, QueryIntent.SUMMARY):
            select_cols = "COUNT(*)"
            if intent.needs_grouping:
                group_field = self.resolve_group_field(question, entities)
                select_cols = f"{group_field}, COUNT(*) as count"
        elif intent.primary == QueryIntent.DETAIL_LIST:
            # Select meaningful columns
            obj = self.ontology.get_object("Defect")
            detail_cols = ["defect_id", "name", "project", "severity",
                          "status_phase", "assigned_ecu", "creation_time"]
            select_cols = ", ".join(detail_cols)
        elif intent.primary == QueryIntent.STATUS_CHECK:
            select_cols = "defect_id, name, status_phase, severity, last_modified"
        elif intent.primary == QueryIntent.RANKING:
            group_field = self.resolve_group_field(question, entities)
            select_cols = f"{group_field}, COUNT(*) as count"
        else:
            select_cols = "*"

        # Step 3: Grouping
        group_clause = ""
        if intent.needs_grouping:
            group_field = self.resolve_group_field(question, entities)
            group_clause = f" GROUP BY {group_field}"
            plan_steps.append(f"2. 分组: GROUP BY {group_field}")

        # Step 4: Ordering
        order_clause = ""
        if intent.primary == QueryIntent.RANKING:
            order_clause = " ORDER BY count DESC"
            plan_steps.append("3. 排序: ORDER BY count DESC")
        elif intent.primary == QueryIntent.DETAIL_LIST:
            order_clause = " ORDER BY creation_time DESC"
            plan_steps.append("3. 排序: ORDER BY creation_time DESC")
        elif intent.primary == QueryIntent.STATUS_CHECK:
            order_clause = " ORDER BY last_modified DESC"
            plan_steps.append("3. 排序: ORDER BY last_modified DESC")
        elif intent.needs_grouping:
            order_clause = " ORDER BY count DESC"
            plan_steps.append("3. 排序: ORDER BY count DESC")

        # Step 5: Limit
        limit_clause = ""
        if intent.primary in (QueryIntent.RANKING, QueryIntent.DETAIL_LIST,
                              QueryIntent.STATUS_CHECK):
            limit = self.resolve_limit(entities, default=20)
            limit_clause = f" LIMIT {limit}"
            plan_steps.append(f"4. 限制: LIMIT {limit}")
        elif intent.primary == QueryIntent.TREND:
            limit_clause = ""  # Trends usually don't need limits

        # Build final SQL
        sql = f"SELECT {select_cols} FROM {table} WHERE {where_clause}{group_clause}{order_clause}{limit_clause}"

        # Special handling for trend
        if intent.primary == QueryIntent.TREND:
            time_field = self.resolve_time_field(question)
            sql = (f"SELECT strftime('%Y-%m', {time_field}) as month, COUNT(*) as count "
                   f"FROM {table} WHERE {where_clause} "
                   f"GROUP BY strftime('%Y-%m', {time_field}) ORDER BY month")

        # Special handling for distribution with percentage
        if intent.primary == QueryIntent.DISTRIBUTION and "占比" in question:
            group_field = self.resolve_group_field(question, entities)
            sql = (f"SELECT {group_field}, COUNT(*) as count, "
                   f"ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM {table} WHERE {where_clause}), 1) as pct "
                   f"FROM {table} WHERE {where_clause} "
                   f"GROUP BY {group_field} ORDER BY count DESC")

        plan_text = "\n".join(plan_steps)
        return SQLCandidate(
            sql=sql,
            path="plan_based",
            explanation=f"执行计划:\n{plan_text}",
            confidence=0.7
        )


class NL2SQLEngine:
    """
    Main NL→SQL Engine: CHASE-SQL multi-path generation + selection.

    Flow:
    1. Analyze question (entities + intent + context)
    2. Generate 3 SQL candidates via different paths
    3. (Optionally execute and) Select best candidate
    4. Return result

    Usage:
        engine = NL2SQLEngine()
        result = engine.query("IDCEVO 本月 Critical 缺陷有多少")
        print(result.sql)  # SELECT COUNT(*) FROM octane_defects WHERE ...
    """

    def __init__(self, ontology: Optional[OntologyEngine] = None,
                 db_path: Optional[str] = None,
                 llm_call_fn: Optional = None,
                 use_query_fixer: bool = True,
                 use_validator: bool = True):
        self.direct_gen = DirectGenerator(ontology, db_path)
        self.decomposed_gen = DecomposedGenerator(ontology, db_path)
        self.plan_gen = PlanBasedGenerator(ontology, db_path)
        self.db_path = db_path
        self.llm_call_fn = llm_call_fn

        # Query Fixer (self-correction)
        self.use_query_fixer = use_query_fixer
        if use_query_fixer:
            from agent.sql_engine.fixer import QueryFixer
            self.query_fixer = QueryFixer(
                db_path=self.db_path,
                llm_call_fn=llm_call_fn
            )
        else:
            self.query_fixer = None

        # Result Validator (MARS-style verification)
        self.use_validator = use_validator
        if use_validator:
            self.validator = ResultValidator(
                llm_call_fn=llm_call_fn,
                enable_llm_validation=llm_call_fn is not None,
            )
        else:
            self.validator = None

    def generate_candidates(self, question: str) -> List[SQLCandidate]:
        """Generate all SQL candidates via 3 paths"""
        candidates = []

        try:
            candidates.append(self.direct_gen.generate(question))
        except Exception as e:
            pass  # One path failing shouldn't block others

        try:
            candidates.append(self.decomposed_gen.generate(question))
        except Exception as e:
            pass

        try:
            candidates.append(self.plan_gen.generate(question))
        except Exception as e:
            pass

        return candidates

    def select_best(self, question: str,
                    candidates: List[SQLCandidate],
                    entities: ExtractionResult,
                    intent: IntentResult) -> SQLCandidate:
        """
        Select the best SQL candidate using heuristics.

        In production, this would use an LLM to compare candidates pairwise.
        For now, we use rule-based scoring.
        """
        if not candidates:
            # Fallback: simple count query
            table = "octane_defects"
            return SQLCandidate(
                sql=f"SELECT COUNT(*) FROM {table}",
                path="fallback",
                explanation="Fallback: no candidate succeeded",
                confidence=0.3
            )

        if len(candidates) == 1:
            return candidates[0]

        # Score each candidate
        scored = [(c, self._score_candidate(c, question, entities, intent))
                  for c in candidates]
        scored.sort(key=lambda x: x[1], reverse=True)

        return scored[0][0]

    def _score_candidate(self, candidate: SQLCandidate, question: str,
                         entities: ExtractionResult,
                         intent: IntentResult) -> float:
        """Score a SQL candidate (higher is better)"""
        score = candidate.confidence

        sql_lower = candidate.sql.lower()

        # Bonus: covers all filter entities
        for entity in entities.entities:
            if entity.field and not entity.field.startswith("__"):
                if entity.field in sql_lower:
                    score += 0.1

        # Bonus: correct aggregation
        if intent.needs_aggregation and "count" in sql_lower:
            score += 0.1
        if intent.needs_grouping and "group by" in sql_lower:
            score += 0.15
        if intent.needs_timeseries and ("strftime" in sql_lower or "date(" in sql_lower):
            score += 0.15

        # Penalty: missing WHERE when entities exist
        filter_entities = [e for e in entities.entities
                          if e.field and not e.field.startswith("__")
                          and e.entity_type not in ("aggregation", "sort", "metric")]
        if filter_entities and "where" not in sql_lower:
            score -= 0.3

        # Penalty: SELECT * for count queries
        if intent.primary == QueryIntent.COUNT and "select *" in sql_lower:
            score -= 0.2

        # Bonus: plan-based path for complex queries
        if candidate.path == "plan_based" and intent.confidence > 0.5:
            score += 0.05

        # Bonus: decomposed path for multi-dimensional queries
        if candidate.path == "decomposed":
            dim_count = sql_lower.count(",") - sql_lower.count("count")
            if dim_count > 0:
                score += 0.05

        return score

    def query(self, question: str) -> QueryResult:
        """
        Full NL→SQL pipeline:
        1. Analyze
        2. Generate candidates
        3. Select best
        4. Execute with self-correction (Query Fixer)
        5. Validate result (MARS-style Result Validator)
        """
        # Analyze
        entities, intent, context = self.direct_gen.analyze_question(question)

        # Generate candidates
        candidates = self.generate_candidates(question)

        # Select best
        best = self.select_best(question, candidates, entities, intent)

        result = QueryResult(
            question=question,
            sql=best.sql,
            intent=intent.primary.value,
            candidates=candidates,
            entities=entities
        )

        # Execute if database available
        if self.db_path:
            if self.query_fixer:
                # Use Query Fixer for self-correction
                from agent.ontology import OntologyEngine
                schema_ctx = self._get_schema_context()
                exec_result = self.query_fixer.execute(
                    best.sql,
                    question=question,
                    schema_context=schema_ctx
                )
                if exec_result.success:
                    result.data = exec_result.rows

                    # MARS-style validation (post-execution)
                    if self.validator:
                        verdict = self.validator.validate(
                            question=question,
                            sql=best.sql,
                            rows=exec_result.rows,
                            intent=intent.primary.value,
                            columns=exec_result.columns,
                        )
                        if not verdict.passed:
                            # Store validation issues in metadata
                            result.error = f"Validation: {verdict.primary_reason}"
                            # Don't fail completely - return data with warning
                            # The caller can decide whether to retry or accept
                        result.validation_issues = [
                            {"level": i.level.value, "check": i.check, "message": i.message}
                            for i in verdict.issues
                        ]
                        result.validation_llm_verified = verdict.llm_verified
                else:
                    result.error = exec_result.error
            else:
                # Legacy execution path
                data, error = self._execute_sql(best.sql)
                if error:
                    result.error = error
                else:
                    result.data = data

        return result

    def _execute_sql(self, sql: str) -> Tuple[List[Dict], Optional[str]]:
        """Execute SQL and return results (legacy path, used if no fixer)"""
        import sqlite3
        try:
            conn = sqlite3.connect(self.db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute(sql)
            rows = cursor.fetchall()
            conn.close()
            return [dict(row) for row in rows], None
        except Exception as e:
            return [], str(e)

    def _get_schema_context(self) -> str:
        """Get database schema context for LLM fixing"""
        # Get main table info from ontology
        defect_obj = self.direct_gen.ontology.get_object("Defect")
        test_obj = self.direct_gen.ontology.get_object("ManualRun")

        lines = []
        lines.append(f"Table: {defect_obj.source_table}")
        for prop_name, prop_def in defect_obj.properties.items():
            mapping = getattr(prop_def, 'mapping', None)
            source_col = mapping.get('column', prop_name) if mapping else prop_name
            lines.append(f"  - {source_col} ({prop_def.type.value}): {prop_def.meaning}")

        if test_obj:
            lines.append(f"\nTable: {test_obj.source_table}")
            for prop_name, prop_def in test_obj.properties.items():
                mapping = getattr(prop_def, 'mapping', None)
                source_col = mapping.get('column', prop_name) if mapping else prop_name
                lines.append(f"  - {source_col} ({prop_def.type.value}): {prop_def.meaning}")

        return "\n".join(lines)

    def to_prompt_context(self, question: str) -> str:
        """
        Generate a prompt context for LLM-based SQL generation.
        Combines context + entities + intent + few-shot examples.
        """
        entities, intent, context = self.direct_gen.analyze_question(question)

        # Few-shot examples
        similar = get_similar_examples(question, top_k=3)
        examples_text = "\n".join(
            f"示例:\n  问: {ex['question']}\n  SQL: {ex['sql']}\n  说明: {ex['explanation']}"
            for ex in similar
        )

        # Entity summary
        entity_lines = []
        for e in entities.entities:
            if e.values:
                entity_lines.append(f"  - {e.entity_type}: {e.original} → {e.field} IN {e.values}")
            else:
                entity_lines.append(f"  - {e.entity_type}: {e.original} → {e.field} {e.operator} '{e.value}'")

        entities_text = "\n".join(entity_lines) if entity_lines else "  (无特定实体)"

        return f"""# 查询分析

## 用户问题
{question}

## 意图
- 主意图: {intent.primary.value} ({intent.description})
- SQL模板: {intent.sql_template}
- 需要聚合: {intent.needs_aggregation}
- 需要分组: {intent.needs_grouping}
- 需要时序: {intent.needs_timeseries}

## 提取的实体
{entities_text}

## 数据库语义上下文
{context[:2000]}...

## 参考示例
{examples_text}
"""


# Singleton
_engine: Optional[NL2SQLEngine] = None


def get_nl2sql_engine(ontology: Optional[OntologyEngine] = None,
                      db_path: Optional[str] = None,
                      llm_call_fn: Optional = None,
                      use_query_fixer: bool = True,
                      use_validator: bool = True) -> NL2SQLEngine:
    global _engine
    if _engine is None:
        _engine = NL2SQLEngine(ontology, db_path, llm_call_fn, use_query_fixer, use_validator)
    return _engine
