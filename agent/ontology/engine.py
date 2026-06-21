"""Ontology Engine - Core Semantic Modeling

Inspired by Palantir Ontology and WrenAI MDL

This engine loads and queries object type definitions from YAML files,
providing semantic context for NL→SQL generation and agent reasoning.
"""

import yaml
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any, Optional, Dict, List, Set
from enum import Enum


class PropertyType(Enum):
    STRING = "string"
    INTEGER = "integer"
    FLOAT = "float"
    ENUM = "enum"
    DATETIME = "datetime"
    JSON = "json"
    ARRAY = "array"


@dataclass
class PropertyDef:
    """Property definition for an object type"""
    name: str
    type: PropertyType
    meaning: str
    values: Optional[List[str]] = None
    examples: Optional[List[str]] = None
    foreign_key: Optional[str] = None
    category_groups: Optional[Dict[str, List[str]]] = None
    semantics: Optional[Dict[str, str]] = None
    business_rules: Optional[List[str]] = None
    aliases: Optional[Dict[str, List[str]]] = None
    mapping: Optional[Dict[str, Any]] = None
    item_type: Optional[PropertyType] = None  # For array types


@dataclass
class LinkDef:
    """Relationship definition between object types"""
    name: str
    target: str
    type: str  # one-to-one, one-to-many, many-to-one, many-to-many
    join: Optional[str] = None  # Optional - JSON-based relationships use "via"
    meaning: str = ""
    via: Optional[str] = None  # For many-to-many via junction table


@dataclass
class MetricDef:
    """Calculated metric definition"""
    name: str
    definition: str  # SQL-like definition
    meaning: str


@dataclass
class CalibrationRule:
    """Business calibration rule"""
    id: str
    trigger: List[str]  # Keywords that trigger this rule
    rule: str  # The rule text


@dataclass
class Governance:
    """Governance rules for object operations"""
    allow_operations: List[str]
    forbid_operations: List[str]
    sensitive_fields: List[str]
    default_time_range: str


@dataclass
class ObjectType:
    """Object type definition"""
    object_type: str
    description: str
    source_table: str
    primary_key: str
    properties: Dict[str, PropertyDef] = field(default_factory=dict)
    links: List[LinkDef] = field(default_factory=list)
    metrics: Dict[str, MetricDef] = field(default_factory=dict)
    calibration_rules: List[CalibrationRule] = field(default_factory=list)
    governance: Optional[Governance] = None


class OntologyEngine:
    """
    Ontology Engine - loads and queries semantic object definitions

    Provides semantic context for:
    - Understanding what each field means
    - Knowing relationships between objects
    - Applying business rules
    - Generating proper SQL with semantics
    """

    def __init__(self, ontology_dir: Path):
        self.ontology_dir = Path(ontology_dir)
        self._objects: Dict[str, ObjectType] = {}
        self._load_objects()

    def _load_objects(self):
        """Load all object type definitions from YAML files"""
        objects_dir = self.ontology_dir / "objects"
        if not objects_dir.exists():
            raise FileNotFoundError(f"Objects directory not found: {objects_dir}")

        for yaml_file in objects_dir.glob("*.yaml"):
            with open(yaml_file, encoding="utf-8") as f:
                data = yaml.safe_load(f)

            obj_type = self._parse_object_type(data)
            self._objects[obj_type.object_type] = obj_type

    def _parse_object_type(self, data: dict) -> ObjectType:
        """Parse YAML data into ObjectType"""
        # Parse properties
        properties = {}
        for prop_name, prop_data in data.get("properties", {}).items():
            if isinstance(prop_data, str):
                # Simple string meaning
                properties[prop_name] = PropertyDef(
                    name=prop_name,
                    type=PropertyType.STRING,
                    meaning=prop_data
                )
            elif isinstance(prop_data, dict):
                prop_type_str = prop_data.get("type", "string")
                prop_type = PropertyType(prop_type_str)

                # Parse item_type for arrays
                item_type_str = prop_data.get("item_type")
                item_type = PropertyType(item_type_str) if item_type_str else None

                properties[prop_name] = PropertyDef(
                    name=prop_name,
                    type=prop_type,
                    meaning=prop_data.get("meaning", ""),
                    values=prop_data.get("values"),
                    examples=prop_data.get("examples"),
                    foreign_key=prop_data.get("foreign_key"),
                    category_groups=prop_data.get("category_groups"),
                    semantics=prop_data.get("semantics"),
                    business_rules=prop_data.get("business_rules"),
                    aliases=prop_data.get("aliases"),
                    mapping=prop_data.get("mapping"),
                    item_type=item_type
                )

        # Parse links
        links = []
        for link_data in data.get("links", []):
            # Some relationships use "via" for JSON-based joins, not SQL join
            join_clause = link_data.get("join")
            if not join_clause and link_data.get("via"):
                join_clause = f"via {link_data['via']}"  # JSON-based relationship
            
            links.append(LinkDef(
                name=link_data["name"],
                target=link_data["target"],
                type=link_data["type"],
                join=join_clause,
                meaning=link_data.get("meaning", ""),
                via=link_data.get("via")
            ))

        # Parse metrics
        metrics = {}
        for metric_name, metric_data in data.get("metrics", {}).items():
            if isinstance(metric_data, dict):
                metrics[metric_name] = MetricDef(
                    name=metric_name,
                    definition=metric_data["definition"],
                    meaning=metric_data["meaning"]
                )

        # Parse calibration rules
        calibration_rules = []
        for rule_data in data.get("calibration_rules", []):
            calibration_rules.append(CalibrationRule(
                id=rule_data["id"],
                trigger=rule_data["trigger"],
                rule=rule_data["rule"]
            ))

        # Parse governance
        governance = None
        governance_data = data.get("governance")
        if governance_data:
            governance = Governance(
                allow_operations=governance_data.get("allow_operations", []),
                forbid_operations=governance_data.get("forbid_operations", []),
                sensitive_fields=governance_data.get("sensitive_fields", []),
                default_time_range=governance_data.get("default_time_range", "90 days")
            )

        return ObjectType(
            object_type=data["object_type"],
            description=data["description"],
            source_table=data["source_table"],
            primary_key=data["primary_key"],
            properties=properties,
            links=links,
            metrics=metrics,
            calibration_rules=calibration_rules,
            governance=governance
        )

    def get_object(self, object_type: str) -> Optional[ObjectType]:
        """Get object type definition"""
        return self._objects.get(object_type)

    def get_all_objects(self) -> Dict[str, ObjectType]:
        """Get all object type definitions"""
        return self._objects

    def get_property(self, object_type: str, property_name: str) -> Optional[PropertyDef]:
        """Get property definition"""
        obj = self.get_object(object_type)
        if obj:
            return obj.properties.get(property_name)
        return None

    def get_links(self, object_type: str) -> List[LinkDef]:
        """Get all links for an object type"""
        obj = self.get_object(object_type)
        if obj:
            return obj.links
        return []

    def get_link(self, object_type: str, link_name: str) -> Optional[LinkDef]:
        """Get specific link by name"""
        for link in self.get_links(object_type):
            if link.name == link_name:
                return link
        return None

    def get_metrics(self, object_type: str) -> Dict[str, MetricDef]:
        """Get all metrics for an object type"""
        obj = self.get_object(object_type)
        if obj:
            return obj.metrics
        return {}

    def get_calibration_rules(self, object_type: str) -> List[CalibrationRule]:
        """Get calibration rules for an object type"""
        obj = self.get_object(object_type)
        if obj:
            return obj.calibration_rules
        return []

    def get_all_calibration_rules(self) -> List[CalibrationRule]:
        """Get calibration rules from all object types"""
        all_rules = []
        for obj in self._objects.values():
            all_rules.extend(obj.calibration_rules)
        return all_rules

    def find_relevant_rules(self, keywords: List[str]) -> List[CalibrationRule]:
        """Find calibration rules that match given keywords"""
        relevant_rules = []
        for rule in self.get_all_calibration_rules():
            for trigger in rule.trigger:
                for keyword in keywords:
                    if keyword.lower() in trigger.lower():
                        relevant_rules.append(rule)
                        break
        return relevant_rules

    def resolve_alias(self, object_type: str, property_name: str, alias: str) -> Optional[str]:
        """
        Resolve an alias to its canonical value

        Example:
            resolve_alias("Defect", "project", "idcevo") -> "IDCEVO"
            resolve_alias("Defect", "assigned_ecu", "车身控制器") -> "BCM"
        """
        prop = self.get_property(object_type, property_name)
        if not prop or not prop.aliases:
            return None

        alias_lower = alias.lower().strip()
        for canonical, aliases in prop.aliases.items():
            if alias_lower in [a.lower() for a in aliases]:
                return canonical
        return None

    def get_category_group(self, object_type: str, property_name: str, category: str) -> Optional[List[str]]:
        """Get values for a specific category group"""
        prop = self.get_property(object_type, property_name)
        if not prop or not prop.category_groups:
            return None
        return prop.category_groups.get(category)

    def traverse(self, start_type: str, start_id: str, path: List[str]) -> List[Dict[str, Any]]:
        """
        Traverse the ontology graph following a path of link names

        Example:
            traverse("Defect", "DEF-001", ["has_history"]) -> history records
            traverse("Defect", "DEF-001", ["belongs_to_project"]) -> project info

        Returns a list of dict results with traversed object data
        """
        # This is a placeholder - actual implementation requires database access
        # The ontology engine defines the traversal plan, but execution happens in SQL engine
        return []

    def to_schema_context(self) -> str:
        """
        Convert ontology to schema context for LLM prompts

        Generates a human-readable description of all objects, properties, and relationships
        """
        lines = ["# 数据库语义模型\n"]

        for obj_type, obj in sorted(self._objects.items()):
            lines.append(f"\n## {obj_type}\n")
            lines.append(f"**含义**: {obj.description}\n")
            lines.append(f"**数据表**: {obj.source_table}\n")
            lines.append(f"**主键**: {obj.primary_key}\n")

            if obj.properties:
                lines.append("\n### 字段\n")
                for prop_name, prop in obj.properties.items():
                    type_str = prop.type.value
                    values_str = f" (取值: {', '.join(prop.values)})" if prop.values else ""
                    meaning_str = prop.meaning or ""
                    lines.append(f"- **{prop_name}** ({type_str}{values_str}): {meaning_str}")

                    if prop.aliases:
                        aliases_str = ", ".join([f"{k}({', '.join(v)})" for k, v in prop.aliases.items()])
                        lines.append(f"  - 别名: {aliases_str}")

                    if prop.business_rules:
                        for rule in prop.business_rules:
                            lines.append(f"  - 规则: {rule}")

            if obj.links:
                lines.append("\n### 关系\n")
                for link in obj.links:
                    lines.append(f"- **{link.name}** → {link.target} ({link.type}): {link.meaning}")
                    lines.append(f"  - 关联条件: {link.join}")

            if obj.metrics:
                lines.append("\n### 计算指标\n")
                for metric_name, metric in obj.metrics.items():
                    lines.append(f"- **{metric_name}**: {metric.meaning}")
                    lines.append(f"  - 计算: {metric.definition}")

            if obj.calibration_rules:
                lines.append("\n### 业务规则提醒\n")
                for rule in obj.calibration_rules:
                    trigger_str = ", ".join(f'"{t}"' for t in rule.trigger)
                    lines.append(f"- 当提到 {trigger_str} 时: {rule.rule}")

        return "\n".join(lines)

    def get_sql_table_mapping(self) -> Dict[str, str]:
        """Get mapping from object type to SQL table"""
        return {obj_type: obj.source_table for obj_type, obj in self._objects.items()}

    def get_primary_keys(self) -> Dict[str, str]:
        """Get primary key for each object type"""
        return {obj_type: obj.primary_key for obj_type, obj in self._objects.items()}


# Singleton instance for easy access
_engine: Optional[OntologyEngine] = None


def get_ontology_engine(ontology_dir: Optional[Path] = None) -> OntologyEngine:
    """Get or create the singleton OntologyEngine"""
    global _engine
    if _engine is None:
        if ontology_dir is None:
            # Default to agent/ontology/
            ontology_dir = Path(__file__).parent.parent / "agent" / "ontology"
        _engine = OntologyEngine(ontology_dir)
    return _engine