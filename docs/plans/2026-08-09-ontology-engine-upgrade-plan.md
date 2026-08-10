# Ontology Engine Deep Upgrade — Implementation Plan

> **Date**: 2026-08-09
> **Branch**: `feature/2026-08-09-ontology-engine-upgrade`
> **Design Doc**: `docs/plans/2026-08-09-ontology-engine-deep-upgrade-design.md`

## Task Breakdown (TDD per task)

### Wave 1 — Independent Modules (parallel)

#### Task 1: OntologyTermResolver
- **Files**: `backend/analytics/ontology_term_resolver.py`, `backend/tests/test_ontology_term_resolver.py`
- **Test**: exact/prefix/fuzzy/CJK matching, longest-match-wins, no-match
- **Impl**: consume `catalog.bundle["terms"]`, build phrase index, `resolve(text) → list[TermMatch]`

#### Task 2: OntologyPromptBuilder  
- **Files**: `backend/analytics/ontology_prompt.py`, `backend/tests/test_ontology_prompt.py`
- **Test**: includes approved constraints, metric glossary, vocab table; respects max_chars
- **Impl**: extract from bundle → build structured markdown for system prompt injection

#### Task 3: OntologyGraph
- **Files**: `backend/analytics/ontology_graph.py`, `backend/tests/test_ontology_graph.py`
- **Test**: correct node/edge count, multi-hop BFS, shortest path, explain_path, mermaid output
- **Impl**: NetworkX DiGraph from bundle entities + relationships

#### Task 4: ConstraintGuardrail
- **Files**: `backend/analytics/ontology_guardrail.py`, `backend/tests/test_ontology_guardrail.py`
- **Test**: approved constraints loaded, query validation, metric target check, action validation
- **Impl**: pre-execution validator using constraints + metrics + actions

#### Task 5: SchemaDriftDetector + OntologyDiscovery
- **Files**: `backend/analytics/ontology_drift.py`, `backend/analytics/ontology_discovery.py`, tests
- **Test**: drift detection (extra/missing cols), mapping suggestions, query log gap analysis
- **Impl**: compare DB schema vs ontology, analyze unresolved query terms

#### Task 6: Content Expansion (constraints.json + actions.json)
- **Files**: `ontology/v1/constraints.json`, `ontology/v1/actions.json`
- **Test**: schema validation passes, every KPI has ≥1 constraint, actions cover all tools
- **Impl**: expand 5→25 constraints, 3→10 actions

#### Task 7: SKOS Semantic Relations (vocab.zh-CN.json)
- **Files**: `ontology/v1/vocab.zh-CN.json`
- **Test**: schema validation, synonym rings, broader/narrower, state transitions
- **Impl**: add SKOS relations to all existing terms

### Wave 2 — Integration (after Wave 1)

#### Task 8: OntologyEngine + Recompile
- **Files**: `backend/analytics/ontology_engine.py`, `backend/tests/test_ontology_engine.py`
- **Impl**: wire all modules, recompile ontology, run full test suite
