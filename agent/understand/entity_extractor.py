"""Entity Extractor - Extract entities from natural language questions

Identifies and extracts structured entities from user questions:
- Projects (IDCEVO, IDC, MGU, etc.)
- ECUs (BCM, VCU, ADAS, etc.)
- Time ranges (本月, 上周, 近30天)
- Severities (Critical, Major, Minor)
- Status phases (活跃, 已关闭)
- Teams / People
- Phases (Q-Gate, CoC, Integration)
- Metrics (缺陷密度, 活跃缺陷数)
- Numeric constraints (>5, 超过10个)
"""

import re
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from agent.ontology import OntologyEngine, get_ontology_engine
from agent.understand.term_resolver import TermResolver, get_term_resolver, ResolvedTerm


@dataclass
class Entity:
    """An extracted entity"""
    entity_type: str        # project, ecu, severity, status, time_range, phase, team, metric, limit
    value: str              # Canonical value
    original: str           # Original text from user
    field: str = ""         # Maps to which DB field
    operator: str = "="     # SQL operator
    values: Optional[List[str]] = None  # For IN clauses
    start: int = 0          # Position in original text
    end: int = 0            # End position
    confidence: float = 1.0


@dataclass
class ExtractionResult:
    """Result of entity extraction"""
    entities: List[Entity] = field(default_factory=list)
    unresolved: List[str] = field(default_factory=list)  # Terms we couldn't resolve

    def get(self, entity_type: str) -> List[Entity]:
        """Get entities of a specific type"""
        return [e for e in self.entities if e.entity_type == entity_type]

    def has(self, entity_type: str) -> bool:
        return any(e.entity_type == entity_type for e in self.entities)

    def get_first(self, entity_type: str) -> Optional[Entity]:
        for e in self.entities:
            if e.entity_type == entity_type:
                return e
        return None


class EntityExtractor:
    """
    Extracts structured entities from user questions.

    Uses TermResolver for canonical mapping and adds:
    - Pattern-based extraction (dates, numbers)
    - Context-aware disambiguation
    - Multi-entity extraction
    """

    # Metric keywords → metric name
    METRIC_KEYWORDS: Dict[str, str] = {
        "活跃缺陷": "active_defect_count",
        "active": "active_defect_count",
        "critical缺陷": "critical_defect_count",
        "critical数": "critical_defect_count",
        "缺陷密度": "defect_density",
        "中国缺陷": "china_defect_count",
        "china缺陷": "china_defect_count",
        "q-gate缺陷": "q_gate_defect_count",
        "coc缺陷": "coc_defect_count",
    }

    # Aggregation intent patterns
    AGG_PATTERNS = [
        (re.compile(r"多少|数量|总数|count", re.IGNORECASE), "count", "COUNT"),
        (re.compile(r"趋势|走势|变化|trend", re.IGNORECASE), "trend", "TIMESERIES"),
        (re.compile(r"排名|top|前\d|最高|最多|最低|最少", re.IGNORECASE), "ranking", "ORDER BY"),
        (re.compile(r"分布|占比|比例|百分比|breakdown|分组", re.IGNORECASE), "distribution", "GROUP BY"),
        (re.compile(r"对比|比较|vs|versus|同比|环比", re.IGNORECASE), "comparison", "COMPARE"),
        (re.compile(r"列表|明细|清单|list|详情", re.IGNORECASE), "list", "SELECT *"),
        (re.compile(r"平均|均值|avg|average", re.IGNORECASE), "average", "AVG"),
    ]

    def __init__(self, ontology: Optional[OntologyEngine] = None):
        self.ontology = ontology or get_ontology_engine()
        self.term_resolver = get_term_resolver(ontology)

    def extract(self, question: str, object_type: str = "Defect") -> ExtractionResult:
        """
        Extract all entities from a natural language question.

        Args:
            question: User's question
            object_type: Which object type to extract against

        Returns:
            ExtractionResult with all found entities
        """
        result = ExtractionResult()

        # 1. Resolve terms via TermResolver
        resolved_terms = self.term_resolver.resolve(question, object_type)

        for rt in resolved_terms:
            entity = self._resolved_to_entity(rt)
            if entity:
                result.entities.append(entity)

        # 2. Extract metrics
        self._extract_metrics(question, result)

        # 3. Extract aggregation intent
        self._extract_aggregation(question, result)

        # 4. Extract time range entities more precisely
        self._extract_time_ranges(question, result)

        # 5. Extract sort/limit
        self._extract_sort_limit(question, result)

        # Sort by position
        result.entities.sort(key=lambda e: e.start)

        return result

    def _resolved_to_entity(self, rt: ResolvedTerm) -> Optional[Entity]:
        """Convert a ResolvedTerm to an Entity"""
        if rt.field == "__limit__":
            return Entity(
                entity_type="limit",
                value=rt.value,
                original=rt.original,
                field="limit",
                operator="LIMIT",
                confidence=rt.confidence
            )
        if rt.field == "__count__":
            return Entity(
                entity_type="numeric_constraint",
                value=rt.value,
                original=rt.original,
                field="count",
                operator=rt.operator,
                confidence=rt.confidence
            )
        if rt.operator == "time_range":
            return Entity(
                entity_type="time_range",
                value=rt.value,
                original=rt.original,
                field="creation_time",
                operator="time_range",
                confidence=rt.confidence
            )

        # Map field to entity type
        field_to_type = {
            "project": "project",
            "assigned_ecu": "ecu",
            "severity": "severity",
            "status_phase": "status",
            "phase": "test_phase",
            "team": "team",
            "problem_finder_team": "team",
            "top_aida": "aida",
            "market": "market",
            "solution_cluster": "solution_cluster",
        }

        etype = field_to_type.get(rt.field, rt.field)

        return Entity(
            entity_type=etype,
            value=rt.value,
            original=rt.original,
            field=rt.field,
            operator=rt.operator if rt.operator != "=" else "=",
            values=rt.values,
            confidence=rt.confidence
        )

    def _extract_metrics(self, question: str, result: ExtractionResult):
        """Extract metric references"""
        q_lower = question.lower()
        for keyword, metric_name in self.METRIC_KEYWORDS.items():
            if keyword.lower() in q_lower:
                # Check not already extracted
                if not any(e.entity_type == "metric" and e.value == metric_name for e in result.entities):
                    result.entities.append(Entity(
                        entity_type="metric",
                        value=metric_name,
                        original=keyword,
                        field="metric",
                        confidence=0.85
                    ))

    def _extract_aggregation(self, question: str, result: ExtractionResult):
        """Extract aggregation intent"""
        for pattern, agg_type, sql_hint in self.AGG_PATTERNS:
            match = pattern.search(question)
            if match:
                # Only take the first matching aggregation
                if not any(e.entity_type == "aggregation" for e in result.entities):
                    result.entities.append(Entity(
                        entity_type="aggregation",
                        value=agg_type,
                        original=match.group(0),
                        field="__aggregation__",
                        operator=sql_hint,
                        start=match.start(),
                        end=match.end(),
                        confidence=0.9
                    ))
                    break

    def _extract_time_ranges(self, question: str, result: ExtractionResult):
        """Extract precise time range with date computation"""
        now = datetime.now()

        time_range_map = {
            "today": (now.replace(hour=0, minute=0, second=0), now),
            "yesterday": (now.replace(hour=0, minute=0, second=0) - timedelta(days=1),
                          now.replace(hour=0, minute=0, second=0)),
            "this_week": (now - timedelta(days=now.weekday()), now),
            "last_week": (now - timedelta(days=now.weekday() + 7),
                          now - timedelta(days=now.weekday())),
            "this_month": (now.replace(day=1, hour=0, minute=0, second=0), now),
            "last_month": (
                (now.replace(day=1) - timedelta(days=1)).replace(day=1, hour=0, minute=0, second=0),
                now.replace(day=1, hour=0, minute=0, second=0) - timedelta(seconds=1)
            ),
            "this_quarter": (
                now.replace(month=((now.month - 1) // 3) * 3 + 1, day=1, hour=0, minute=0, second=0),
                now
            ),
            "this_year": (now.replace(month=1, day=1, hour=0, minute=0, second=0), now),
            "last_year": (
                now.replace(year=now.year - 1, month=1, day=1, hour=0, minute=0, second=0),
                now.replace(month=1, day=1, hour=0, minute=0, second=0) - timedelta(seconds=1)
            ),
        }

        # Find time range entities
        for entity in result.entities:
            if entity.entity_type != "time_range":
                continue

            range_type = entity.value

            # Handle "近N天/月/周"
            if range_type in ("recent_days", "recent_months", "recent_weeks"):
                match = re.search(r"近\s*(\d+)\s*(天|个月|周)", question)
                if match:
                    n = int(match.group(1))
                    unit = match.group(2)
                    if unit == "天":
                        start_date = now - timedelta(days=n)
                    elif unit == "个月":
                        start_date = now - timedelta(days=n * 30)
                    else:  # 周
                        start_date = now - timedelta(weeks=n)
                    entity.values = [start_date.strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")]
            elif range_type in time_range_map:
                start, end = time_range_map[range_type]
                entity.values = [start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")]

    def _extract_sort_limit(self, question: str, result: ExtractionResult):
        """Extract sort direction and limit"""
        # Sort direction
        sort_desc_patterns = [
            re.compile(r"最高|最多|最大|top|降序|倒序", re.IGNORECASE),
        ]
        sort_asc_patterns = [
            re.compile(r"最低|最少|最小|升序|bottom", re.IGNORECASE),
        ]

        has_desc = any(p.search(question) for p in sort_desc_patterns)
        has_asc = any(p.search(question) for p in sort_asc_patterns)

        if has_desc and not any(e.entity_type == "sort" for e in result.entities):
            result.entities.append(Entity(
                entity_type="sort",
                value="DESC",
                original="降序",
                field="__sort__",
                operator="ORDER BY ... DESC",
                confidence=0.8
            ))
        elif has_asc and not any(e.entity_type == "sort" for e in result.entities):
            result.entities.append(Entity(
                entity_type="sort",
                value="ASC",
                original="升序",
                field="__sort__",
                operator="ORDER BY ... ASC",
                confidence=0.8
            ))

    def to_sql_filters(self, result: ExtractionResult,
                       object_type: str = "Defect") -> List[str]:
        """
        Convert extracted entities to SQL WHERE clause fragments.

        Returns list of SQL conditions that can be AND-ed together.
        """
        filters = []
        obj = self.ontology.get_object(object_type)
        if not obj:
            return filters

        for entity in result.entities:
            if entity.entity_type in ("aggregation", "sort", "limit", "metric",
                                      "numeric_constraint"):
                continue

            field = entity.field
            if not field or field.startswith("__"):
                continue

            if entity.operator == "IN" and entity.values:
                values_str = ", ".join(f"'{v}'" for v in entity.values)
                filters.append(f"{field} IN ({values_str})")
            elif entity.operator == "time_range" and entity.values:
                filters.append(f"{field} >= '{entity.values[0]}' AND {field} <= '{entity.values[1]}'")
            else:
                filters.append(f"{field} {entity.operator} '{entity.value}'")

        return filters


# Singleton
_extractor: Optional[EntityExtractor] = None


def get_entity_extractor(ontology: Optional[OntologyEngine] = None) -> EntityExtractor:
    global _extractor
    if _extractor is None:
        _extractor = EntityExtractor(ontology)
    return _extractor
