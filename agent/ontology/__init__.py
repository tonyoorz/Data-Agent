"""Ontology Module - Semantic Object Modeling

Inspired by Palantir Ontology and WrenAI MDL

This module provides:
- Object type definitions (YAML-based)
- Semantic property and relationship modeling
- Business rule definitions
- Calibration rules for common misunderstandings
- Governance and access control definitions
"""

from .engine import (
    OntologyEngine,
    ObjectType,
    PropertyDef,
    LinkDef,
    MetricDef,
    CalibrationRule,
    Governance,
    get_ontology_engine,
    PropertyType,
)

__all__ = [
    "OntologyEngine",
    "ObjectType",
    "PropertyDef",
    "LinkDef",
    "MetricDef",
    "CalibrationRule",
    "Governance",
    "get_ontology_engine",
    "PropertyType",
]