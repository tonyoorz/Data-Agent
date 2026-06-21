"""Context Engine - 5-Layer Context Building

Inspired by WrenAI's context layer model:

Layer 1 - Structural: Tables, columns, types, keys, relationships
Layer 2 - Semantic: Business names, descriptions, calculations, enums
Layer 3 - Business: Canonical tables, reusable metrics, relationship meaning
Layer 4 - Operational: Safe join paths, forbidden operations
Layer 5 - Behavioral: Historical successful queries, user feedback, frequent patterns
"""

from typing import Optional, Dict, List
from pathlib import Path
from datetime import datetime
import sqlite3

from agent.ontology import OntologyEngine, get_ontology_engine


class DataProfiler:
    """
    Automatic data profiling for Layer 1 context

    Analyzes database to provide:
    - Row counts
    - Column distributions
    - Value frequencies
    - Data quality warnings
    """

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._cache: Dict[str, Dict] = {}

    def profile_table(self, table_name: str) -> Dict:
        """Profile a single table"""
        if table_name in self._cache:
            return self._cache[table_name]

        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        profile = {
            "row_count": 0,
            "columns": {},
            "created_at": datetime.now().isoformat()
        }

        # Row count
        cursor.execute(f"SELECT COUNT(*) FROM {table_name}")
        profile["row_count"] = cursor.fetchone()[0]

        # Column profiles
        cursor.execute(f"PRAGMA table_info({table_name})")
        columns_info = cursor.fetchall()

        for col_info in columns_info:
            col_name = col_info[1]
            col_type = col_info[2]

            col_profile = {
                "type": col_type,
                "nullable": col_info[3] == 0,  # 0 = NOT NULL
                "sample_values": [],
                "unique_count": 0,
                "null_count": 0
            }

            # Sample values and statistics
            try:
                cursor.execute(f"SELECT DISTINCT {col_name} FROM {table_name} WHERE {col_name} IS NOT NULL LIMIT 5")
                sample_values = cursor.fetchall()
                col_profile["sample_values"] = [v[0] for v in sample_values if v[0] is not None]

                # Unique count (for reasonable sized tables)
                if profile["row_count"] < 100000:
                    cursor.execute(f"SELECT COUNT(DISTINCT {col_name}) FROM {table_name}")
                    col_profile["unique_count"] = cursor.fetchone()[0]

                # Null count
                cursor.execute(f"SELECT COUNT(*) FROM {table_name} WHERE {col_name} IS NULL")
                col_profile["null_count"] = cursor.fetchone()[0]

                # Null percentage
                if profile["row_count"] > 0:
                    col_profile["null_percentage"] = (col_profile["null_count"] / profile["row_count"]) * 100

            except sqlite3.OperationalError:
                # Column might not support these operations (e.g., BLOB)
                pass

            profile["columns"][col_name] = col_profile

        conn.close()
        self._cache[table_name] = profile
        return profile

    def profile_all_tables(self) -> Dict[str, Dict]:
        """Profile all tables in the database"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        tables = [row[0] for row in cursor.fetchall()]
        conn.close()

        profiles = {}
        for table in tables:
            if not table.startswith("sqlite_"):  # Skip SQLite system tables
                profiles[table] = self.profile_table(table)

        return profiles

    def get_summary_text(self) -> str:
        """Get a human-readable summary of database profile"""
        profiles = self.profile_all_tables()

        lines = ["## 数据库概览\n"]

        total_rows = sum(p["row_count"] for p in profiles.values())
        lines.append(f"**总表数**: {len(profiles)}")
        lines.append(f"**总行数**: {total_rows:,}\n")

        for table_name, profile in sorted(profiles.items()):
            lines.append(f"### {table_name}")
            lines.append(f"- 行数: {profile['row_count']:,}")
            lines.append(f"- 列数: {len(profile['columns'])}")

            # Highlight interesting columns
            interesting_cols = []
            for col_name, col_profile in profile["columns"].items():
                if col_profile["null_percentage"] and col_profile["null_percentage"] > 20:
                    interesting_cols.append(f"{col_name} (缺失率高 {col_profile['null_percentage']:.1f}%)")

                if col_profile["unique_count"] == profile["row_count"] and profile["row_count"] > 0:
                    interesting_cols.append(f"{col_name} (唯一)")

            if interesting_cols:
                lines.append(f"- 注意: {', '.join(interesting_cols)}")

            lines.append("")

        return "\n".join(lines)


class ContextEngine:
    """
    Context Engine - 5-Layer context builder for LLM prompts

    Combines structural, semantic, business, operational, and behavioral context
    """

    def __init__(
        self,
        ontology: Optional[OntologyEngine] = None,
        db_path: Optional[str] = None
    ):
        self.ontology = ontology or get_ontology_engine()
        self.profiler: Optional[DataProfiler] = None

        if db_path:
            self.profiler = DataProfiler(db_path)

        # Behavioral layer - query history and feedback
        self.query_history: List[Dict] = []

    def structural_layer(self, object_type: str) -> str:
        """
        Layer 1: Structural Context
        Table schema, columns, types, primary keys, foreign keys
        """
        obj = self.ontology.get_object(object_type)
        if not obj:
            return f"## 未找到对象类型: {object_type}\n"

        lines = [f"## 结构层 - {object_type}\n"]
        lines.append(f"**数据表**: {obj.source_table}\n")
        lines.append(f"**主键**: {obj.primary_key}\n")

        if obj.properties:
            lines.append("### 字段结构\n")
            for prop_name, prop in obj.properties.items():
                type_str = prop.type.value
                if prop.item_type:
                    type_str = f"{prop.item_type.value}[]"

                line = f"- **{prop_name}**: {type_str}"
                if prop.foreign_key:
                    line += f" → {prop.foreign_key}"
                lines.append(line)

        return "\n".join(lines)

    def semantic_layer(self, object_type: str, keywords: List[str] = None) -> str:
        """
        Layer 2: Semantic Context
        Business meanings, enum values, category groups, aliases
        """
        obj = self.ontology.get_object(object_type)
        if not obj:
            return ""

        lines = [f"\n## 语义层 - {object_type}\n"]

        if obj.properties:
            for prop_name, prop in obj.properties.items():
                if not prop.meaning and not prop.values and not prop.aliases:
                    continue

                lines.append(f"### {prop_name}\n")

                if prop.meaning:
                    lines.append(f"**含义**: {prop.meaning}\n")

                if prop.values:
                    lines.append(f"**取值**: {', '.join(prop.values)}\n")

                if prop.aliases:
                    lines.append("**别名**:\n")
                    for canonical, aliases in prop.aliases.items():
                        lines.append(f"- {canonical}: {', '.join(aliases)}\n")

                if prop.category_groups:
                    lines.append("**分类**:\n")
                    for category, values in prop.category_groups.items():
                        lines.append(f"- {category}: {', '.join(values)}\n")

                if prop.semantics:
                    lines.append("**语义说明**:\n")
                    for value, meaning in prop.semantics.items():
                        lines.append(f"- {value}: {meaning}\n")

        return "\n".join(lines)

    def business_layer(self, object_type: str, question: str = None) -> str:
        """
        Layer 3: Business Context
        Metrics, business rules, canonical definitions
        """
        obj = self.ontology.get_object(object_type)
        if not obj:
            return ""

        lines = [f"\n## 业务层 - {object_type}\n"]

        # Metrics
        if obj.metrics:
            lines.append("### 计算指标\n")
            for metric_name, metric in obj.metrics.items():
                lines.append(f"- **{metric_name}**: {metric.meaning}")
                lines.append(f"  - 计算: {metric.definition}\n")

        # Calibration rules
        relevant_rules = []
        if question:
            keywords = question.lower().split()
            relevant_rules = self.ontology.find_relevant_rules(keywords)

        if relevant_rules:
            lines.append("### 业务规则提醒\n")
            lines.append("根据你的问题，请注意以下业务规则:\n")
            for rule in relevant_rules[:5]:  # Top 5 most relevant
                lines.append(f"- {rule.rule}\n")

        return "\n".join(lines)

    def operational_layer(self, object_type: str) -> str:
        """
        Layer 4: Operational Context
        Safe join paths, forbidden operations, governance
        """
        obj = self.ontology.get_object(object_type)
        if not obj:
            return ""

        lines = [f"\n## 操作层 - {object_type}\n"]

        # Governance
        if obj.governance:
            if obj.governance.forbid_operations:
                lines.append("**禁止的操作**:\n")
                lines.append(f"{'、'.join(obj.governance.forbid_operations)}\n")

            if obj.governance.default_time_range:
                lines.append(f"**默认时间范围**: {obj.governance.default_time_range}\n")

        # Join paths
        if obj.links:
            lines.append("### 安全的 JOIN 路径\n")
            for link in obj.links:
                lines.append(f"- **{link.name}** → {link.target}")
                lines.append(f"  - 关联: {link.join}\n")

        return "\n".join(lines)

    def behavioral_layer(self, object_type: str, question: str = None) -> str:
        """
        Layer 5: Behavioral Context
        Historical queries, user feedback, frequent patterns
        """
        lines = [f"\n## 行为层 - {object_type}\n"]

        # Similar successful queries from history
        if question and self.query_history:
            similar_queries = self._find_similar_queries(question, object_type)
            if similar_queries:
                lines.append("### 历史成功查询参考\n")
                for i, q in enumerate(similar_queries[:3], 1):
                    lines.append(f"{i}. **问题**: {q['question']}")
                    lines.append(f"   **SQL**: ```sql\n{q['sql']}\n```\n")

        return "\n".join(lines)

    def build_context(
        self,
        object_type: str,
        question: Optional[str] = None,
        include_layers: Optional[List[int]] = None
    ) -> str:
        """
        Build complete 5-layer context

        Args:
            object_type: The object type to get context for
            question: The user's question (for relevance scoring)
            include_layers: Which layers to include (default: all)

        Returns:
            Complete context string for LLM prompt
        """
        if include_layers is None:
            include_layers = [1, 2, 3, 4, 5]

        context_parts = []

        if 1 in include_layers:
            context_parts.append(self.structural_layer(object_type))

        if 2 in include_layers:
            context_parts.append(self.semantic_layer(object_type))

        if 3 in include_layers:
            context_parts.append(self.business_layer(object_type, question))

        if 4 in include_layers:
            context_parts.append(self.operational_layer(object_type))

        if 5 in include_layers and question:
            context_parts.append(self.behavioral_layer(object_type, question))

        # Add data profile if available
        if self.profiler:
            context_parts.append("\n## 数据概览\n")
            context_parts.append(self.profiler.get_summary_text())

        return "\n".join(context_parts)

    def add_to_history(self, question: str, sql: str, object_type: str, success: bool = True):
        """Add a query to behavioral history"""
        self.query_history.append({
            "question": question,
            "sql": sql,
            "object_type": object_type,
            "success": success,
            "timestamp": datetime.now().isoformat()
        })

    def _find_similar_queries(self, question: str, object_type: str, top_k: int = 3) -> List[Dict]:
        """
        Find similar historical queries

        Simple keyword matching - production would use embeddings
        """
        question_words = set(question.lower().split())
        scored = []

        for q in self.query_history:
            if q["object_type"] != object_type:
                continue
            if not q["success"]:
                continue

            history_words = set(q["question"].lower().split())
            overlap = len(question_words & history_words)
            scored.append((overlap, q))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [q for _, q in scored[:top_k]]


def get_context_engine(
    ontology: Optional[OntologyEngine] = None,
    db_path: Optional[str] = None
) -> ContextEngine:
    """Factory function for ContextEngine"""
    return ContextEngine(ontology=ontology, db_path=db_path)