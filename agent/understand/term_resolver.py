"""Term Resolver - Business term disambiguation

Resolves user-facing business terms to canonical field values,
using Ontology Engine's alias mappings and domain knowledge.

Examples:
    "大灯" → assigned_ecu = 'IHU' (or relevant ECU)
    "Critical" → severity = 'Critical'
    "活跃" → status_phase IN ('New', 'Open', 'In Progress')
    "中国项目" → project IN ('IDCEVO', 'IDC', 'MGU')
"""

import re
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, field
from pathlib import Path

from agent.ontology import OntologyEngine, get_ontology_engine


@dataclass
class ResolvedTerm:
    """A resolved business term"""
    original: str               # Original text from user
    canonical: str              # Canonical form
    field: str                  # Which field this maps to
    value: str                  # The canonical value
    operator: str = "="         # SQL operator (=, IN, etc.)
    values: Optional[List[str]] = None  # For IN clauses
    confidence: float = 1.0
    source: str = "ontology"    # ontology | pattern | synonym


class TermResolver:
    """
    Resolves business terms using:
    1. Ontology alias mappings (primary)
    2. Category group expansions (e.g., "活跃" → active statuses)
    3. Synonym dictionary (supplementary)
    4. Pattern matching (e.g., "超过N个" → >N)
    """

    # Supplementary synonyms not in YAML
    SUPPLEMENT_SYNONYMS: Dict[str, Dict[str, List[str]]] = {
        "severity": {
            "Critical": ["严重", "致命", "高优", "P0", "S0"],
            "Major": ["主要", "重要", "P1", "S1"],
            "Minor": ["次要", "轻微", "P2", "S2"],
            "Cosmetic": ["外观", "表面", "P3", "S3"],
        },
        "status_phase": {
            "active": ["活跃", "未关闭", "待处理", "open状态", "处理中",
                       "未解决", "还没关", "open的"],
            "resolved": ["已解决", "已关闭", "已修复", "已完成"],
            "New": ["新建", "新提", "刚提"],
            "Open": ["打开", "已指派"],
            "In Progress": ["进行中", "开发中", "修复中", "处理中"],
            "Fixed": ["已修", "修好了", "已修复"],
            "Closed": ["已关", "关闭了", "验证通过"],
            "Rejected": ["已拒绝", "驳回"],
            "Deferred": ["延期", "延后", "推迟"],
        },
    }

    # Numeric constraint patterns
    NUMERIC_PATTERNS = [
        # "超过N个", "大于N", ">N"
        (re.compile(r"超过\s*(\d+)\s*[个条项]?"), ">", "count"),
        (re.compile(r"大于\s*(\d+)\s*[个条项]?"), ">", "count"),
        (re.compile(r"多于\s*(\d+)\s*[个条项]?"), ">", "count"),
        (re.compile(r"至少\s*(\d+)\s*[个条项]?"), ">=", "count"),
        (re.compile(r"少于\s*(\d+)\s*[个条项]?"), "<", "count"),
        (re.compile(r"小于\s*(\d+)\s*[个条项]?"), "<", "count"),
        (re.compile(r"不到\s*(\d+)\s*[个条项]?"), "<", "count"),
        (re.compile(r"刚好\s*(\d+)\s*[个条项]?"), "=", "count"),
        (re.compile(r"前\s*(\d+)\s*[个条项]"), "TOP", "limit"),
        (re.compile(r"top\s*(\d+)", re.IGNORECASE), "TOP", "limit"),
    ]

    # Time range patterns
    TIME_PATTERNS = [
        (re.compile(r"今天|今日"), "today"),
        (re.compile(r"昨天|昨日"), "yesterday"),
        (re.compile(r"本周|这周|这一周"), "this_week"),
        (re.compile(r"上周|上一周"), "last_week"),
        (re.compile(r"本月|这个月|当月"), "this_month"),
        (re.compile(r"上月|上个月|上个月"), "last_month"),
        (re.compile(r"本季度|这个季度"), "this_quarter"),
        (re.compile(r"上季度|上个季度"), "last_quarter"),
        (re.compile(r"今年|本年|年度"), "this_year"),
        (re.compile(r"去年|上一年"), "last_year"),
        (re.compile(r"近\s*(\d+)\s*天"), "recent_days"),
        (re.compile(r"近\s*(\d+)\s*个月"), "recent_months"),
        (re.compile(r"近\s*(\d+)\s*周"), "recent_weeks"),
    ]

    def __init__(self, ontology: Optional[OntologyEngine] = None):
        self.ontology = ontology or get_ontology_engine()
        self._build_reverse_index()

    def _build_reverse_index(self):
        """Build reverse alias index for fast lookup"""
        self._alias_index: Dict[str, List[Tuple[str, str, str]]] = {}
        # alias_index: lowercase_alias -> [(object_type, field, canonical_value), ...]

        for obj_type_name, obj in self.ontology.get_all_objects().items():
            for prop_name, prop in obj.properties.items():
                if prop.aliases:
                    for canonical, aliases in prop.aliases.items():
                        # Index the canonical value itself as a key
                        canon_key = canonical.lower().strip()
                        self._alias_index.setdefault(canon_key, []).append(
                            (obj_type_name, prop_name, canonical)
                        )
                        # Index all aliases
                        for alias in aliases:
                            key = alias.lower().strip()
                            self._alias_index.setdefault(key, []).append(
                                (obj_type_name, prop_name, canonical)
                            )

                # Also index the canonical value itself
                if prop.values:
                    for val in prop.values:
                        key = val.lower().strip()
                        self._alias_index.setdefault(key, []).append(
                            (obj_type_name, prop_name, val)
                        )

                # Also index examples as known values
                if prop.examples:
                    for val in prop.examples:
                        key = val.lower().strip()
                        if key not in self._alias_index:
                            self._alias_index.setdefault(key, []).append(
                                (obj_type_name, prop_name, val)
                            )

        # Add supplement synonyms
        for field_name, synonyms in self.SUPPLEMENT_SYNONYMS.items():
            for canonical, syns in synonyms.items():
                for syn in syns:
                    key = syn.lower().strip()
                    self._alias_index.setdefault(key, []).append(
                        ("Defect", field_name, canonical)
                    )

    def resolve(self, text: str, object_type: str = "Defect") -> List[ResolvedTerm]:
        """
        Resolve all business terms in the given text.

        Args:
            text: User's question or text segment
            object_type: Which object type to resolve against

        Returns:
            List of resolved terms found in the text
        """
        results: List[ResolvedTerm] = []
        seen = set()  # Avoid duplicates

        # 1. Resolve aliases and synonyms (longest-match-first to avoid partial overlaps)
        text_lower = text.lower()
        sorted_aliases = sorted(self._alias_index.keys(), key=len, reverse=True)
        consumed_positions: set = set()  # Track matched char positions

        for alias in sorted_aliases:
            if len(alias) < 2:
                continue
            is_cjk = any(ord(c) > 0x3000 for c in alias)
            # Find all non-overlapping occurrences
            search_from = 0
            while search_from <= len(text_lower) - len(alias):
                pos = text_lower.find(alias, search_from)
                if pos == -1:
                    break
                search_from = pos + 1
                # Word boundary check (skip for CJK text)
                if not is_cjk:
                    before_ok = (pos == 0 or not text_lower[pos - 1].isalnum())
                    after_ok = (pos + len(alias) >= len(text_lower) or not text_lower[pos + len(alias)].isalnum())
                    if not (before_ok and after_ok):
                        continue
                positions = set(range(pos, pos + len(alias)))
                if positions & consumed_positions:
                    continue
                consumed_positions |= positions

                for obj_type, field, canonical in self._alias_index[alias]:
                    if obj_type != object_type:
                        continue
                    key = (field, canonical)
                    if key in seen:
                        continue
                    seen.add(key)

                    # Check if this is a category group
                    prop = self.ontology.get_property(object_type, field)
                    is_category = False
                    values = None
                    if prop and prop.category_groups:
                        for group_name, group_values in prop.category_groups.items():
                            if canonical == group_name:
                                is_category = True
                                values = group_values
                                break

                    if is_category and values:
                        results.append(ResolvedTerm(
                            original=alias,
                            canonical=canonical,
                            field=field,
                            value=canonical,
                            operator="IN",
                            values=values,
                            confidence=0.95,
                            source="category"
                        ))
                    else:
                        results.append(ResolvedTerm(
                            original=alias,
                            canonical=canonical,
                            field=field,
                            value=canonical,
                            confidence=0.9,
                            source="alias"
                        ))

        # 2. Resolve category group terms directly
        obj = self.ontology.get_object(object_type)
        if obj:
            for prop_name, prop in obj.properties.items():
                if not prop.category_groups:
                    continue
                for group_name, group_values in prop.category_groups.items():
                    # Check if user mentioned the group name
                    if group_name.lower() in text_lower:
                        key = (prop_name, group_name)
                        if key not in seen:
                            seen.add(key)
                            results.append(ResolvedTerm(
                                original=group_name,
                                canonical=group_name,
                                field=prop_name,
                                value=group_name,
                                operator="IN",
                                values=group_values,
                                confidence=0.95,
                                source="category"
                            ))

        # 3. Resolve numeric constraints
        for pattern, operator, kind in self.NUMERIC_PATTERNS:
            match = pattern.search(text)
            if match:
                num = int(match.group(1))
                if kind == "limit":
                    results.append(ResolvedTerm(
                        original=match.group(0),
                        canonical=f"LIMIT {num}",
                        field="__limit__",
                        value=str(num),
                        operator="LIMIT",
                        confidence=1.0,
                        source="pattern"
                    ))
                else:
                    results.append(ResolvedTerm(
                        original=match.group(0),
                        canonical=f"{operator}{num}",
                        field="__count__",
                        value=str(num),
                        operator=operator,
                        confidence=1.0,
                        source="pattern"
                    ))

        # 4. Resolve time ranges
        for pattern, range_type in self.TIME_PATTERNS:
            match = pattern.search(text)
            if match:
                results.append(ResolvedTerm(
                    original=match.group(0),
                    canonical=range_type,
                    field="creation_time",
                    value=range_type,
                    operator="time_range",
                    confidence=1.0,
                    source="pattern"
                ))

        return results

    def resolve_field(self, text: str, object_type: str = "Defect") -> Optional[Tuple[str, str]]:
        """
        Try to resolve a single term to a field+value.

        Returns (field_name, canonical_value) or None
        """
        terms = self.resolve(text, object_type)
        for t in terms:
            if t.field and not t.field.startswith("__"):
                return (t.field, t.value)
        return None

    def expand_category(self, field: str, category: str,
                        object_type: str = "Defect") -> Optional[List[str]]:
        """Expand a category name to its member values"""
        prop = self.ontology.get_property(object_type, field)
        if prop and prop.category_groups:
            return prop.category_groups.get(category)
        return None

    def get_all_known_terms(self, object_type: str = "Defect") -> Dict[str, List[str]]:
        """
        Get all known terms for an object type.
        Useful for debugging and visualization.
        """
        result: Dict[str, List[str]] = {}
        obj = self.ontology.get_object(object_type)
        if not obj:
            return result

        for prop_name, prop in obj.properties.items():
            terms = []
            if prop.values:
                terms.extend(prop.values)
            if prop.aliases:
                for canonical, aliases in prop.aliases.items():
                    terms.append(canonical)
                    terms.extend(aliases)
            if prop.category_groups:
                terms.extend(prop.category_groups.keys())

            # Add supplement synonyms
            if prop_name in self.SUPPLEMENT_SYNONYMS:
                for canonical, syns in self.SUPPLEMENT_SYNONYMS[prop_name].items():
                    terms.append(canonical)
                    terms.extend(syns)

            if terms:
                result[prop_name] = terms

        return result


# Singleton
_resolver: Optional[TermResolver] = None


def get_term_resolver(ontology: Optional[OntologyEngine] = None) -> TermResolver:
    global _resolver
    if _resolver is None:
        _resolver = TermResolver(ontology)
    return _resolver
