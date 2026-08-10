# Ontology Engine Deep Upgrade Design

> **Date**: 2026-08-09
> **Branch**: `feature/2026-08-09-ontology-engine-upgrade`
> **Base**: `feature/2026-08-04-semantic-analysis-closure-integration`
> **Scope**: Full ontology system overhaul — from data dictionary to reasoning engine

---

## Problem Statement

The current Ontology system has 28 entities, 27 relationships, 50 dimensions, 30 metrics, 78 vocab terms, and strong JSON Schema governance. However it functions as a **data dictionary**, not a **reasoning engine**:

1. **Vocab terms compiled but unused** — 78 terms sit in the bundle; Agent never matches user language to ontology concepts
2. **No system prompt injection** — Agent doesn't know business rules exist
3. **No graph runtime** — 27 relationship types defined but no graph traversal at query time
4. **Constraints nearly empty** — 5 constraints for 30 metrics; Agent has no guardrails
5. **Actions nearly empty** — 3 actions vs 7+ agent tools
6. **No automated discovery** — Ontology is manually curated
7. **No schema drift detection** — SQLite can diverge from ontology definitions
8. **No semantic relations** — No synonym rings, hyponyms, or state machines

## Design

### Module 1: OntologyTermResolver — Term Disambiguation Engine

**File**: `backend/analytics/ontology_term_resolver.py`

Consumes the compiled bundle's `terms` array. Given a user's natural language query, resolves to metric/dimension/entity/concept.

```python
class OntologyTermResolver:
    def __init__(self, catalog: OntologyCatalog):
        self._terms = catalog.bundle.get("terms", [])
        self._phrase_index = self._build_phrase_index()

    def _build_phrase_index(self) -> dict[str, list[TermMatch]]:
        # Map every phrase (lowercased) to its term definitions
        # Support exact, prefix, and fuzzy matching

    def resolve(self, text: str) -> list[TermMatch]:
        # Scan text for known phrases
        # Return ranked matches with resolution targets

    def resolve_metric(self, text: str) -> str | None:
        # Convenience: return the best metric_id match

    def resolve_dimension(self, text: str) -> str | None:
        # Convenience: return the best dimension_id match
```

**Tests**: `backend/tests/test_ontology_term_resolver.py`
- Exact phrase match ("Top Issue" → metric `defect.top_issue_count`)
- Multi-phrase disambiguation ("矩阵" → dimension `quality.matrix_rating`)
- CJK matching ("成熟度" → concept `concept.maturity_grade`)
- Overlapping phrases (longest match wins)
- No match returns empty list

---

### Module 2: OntologyPromptBuilder — System Prompt Auto-Injection

**File**: `backend/analytics/ontology_prompt.py`

Extracts key information from the compiled bundle and builds a structured context block for the Agent's system prompt.

```python
class OntologyPromptBuilder:
    def __init__(self, catalog: OntologyCatalog):
        self._catalog = catalog

    def build_system_context(self, *, max_chars: int = 4000) -> str:
        # Priority: constraints > metrics summary > vocab > relationships
        # Truncate to max_chars to avoid prompt bloat

    def build_guardrail_rules(self) -> list[str]:
        # Extract all approved constraints as human-readable rules

    def build_metric_glossary(self) -> str:
        # One-line per approved metric: id, description, target

    def build_vocab_table(self) -> str:
        # phrase → resolution mapping, compact format
```

**Tests**: `backend/tests/test_ontology_prompt.py`
- Output includes all approved constraints
- Output includes metric glossary with target values
- Output respects max_chars budget
- Output is valid markdown
- Guardrail rules are human-readable

---

### Module 3: OntologyGraph — In-Memory Knowledge Graph

**File**: `backend/analytics/ontology_graph.py`

Builds a NetworkX DiGraph from the compiled bundle. Provides multi-hop traversal, neighbor lookup, and path reasoning.

```python
class OntologyGraph:
    def __init__(self, catalog: OntologyCatalog):
        self._graph = self._build_graph(catalog.bundle)

    def _build_graph(self, bundle) -> nx.DiGraph:
        # Add entity nodes with full property metadata
        # Add relationship edges with predicate labels

    def neighbors(self, entity_id: str, max_hops: int = 2) -> list[GraphPath]:
        # BFS traversal, return all reachable entities within max_hops

    def shortest_path(self, source: str, target: str) -> list[str] | None:
        # Shortest path between two entity types

    def subgraph(self, entity_ids: list[str]) -> dict:
        # Extract subgraph around given entities

    def explain_path(self, path: list[str]) -> str:
        # Human-readable path explanation: "Defect --detected_in--> TestRun --executes--> TestCase"

    def find_by_predicate(self, predicate: str) -> list[tuple[str, str]]:
        # Find all (source, target) pairs connected by a given predicate

    def get_entity_properties(self, entity_id: str) -> dict:
        # Return the full entity definition including properties

    def to_mermaid(self, max_nodes: int = 30) -> str:
        # Generate Mermaid diagram for visualization
```

**Tests**: `backend/tests/test_ontology_graph.py`
- Graph has correct node/edge count
- Multi-hop traversal finds expected neighbors
- Shortest path between defect and team is correct
- explain_path produces readable output
- Mermaid output is valid

---

### Module 4: ConstraintGuardrail — Pre-Execution Validation

**File**: `backend/analytics/ontology_guardrail.py`

Validates agent queries/actions against ontology constraints before execution.

```python
class ConstraintGuardrail:
    def __init__(self, catalog: OntologyCatalog):
        self._constraints = [c for c in catalog.bundle.get("constraints", [])
                             if c.get("governance", {}).get("status") == "approved"]
        self._metrics = {m["id"]: m for m in catalog.bundle.get("metrics", [])}
        self._actions = [a for a in catalog.bundle.get("actions", [])
                         if a.get("governance", {}).get("status") == "approved"]

    def validate_query(self, metric_id: str, dimensions: list[str], filters: dict) -> GuardrailResult:
        # Check if the query violates any business constraints
        # Return violations with severity and human-readable messages

    def validate_action(self, action_id: str, params: dict) -> GuardrailResult:
        # Check if an action is permitted given current context

    def check_metric_target(self, metric_id: str, value: float) -> GuardrailResult:
        # Compare a computed value against the metric's target/threshold

    def list_active_rules(self) -> list[str]:
        # Human-readable list of all active guardrail rules
```

**Tests**: `backend/tests/test_ontology_guardrail.py`
- Approved constraints are loaded
- Query with valid metric/dimension passes
- Query violating constraint is blocked with message
- Metric target check works (e.g., CWA rate > 10% triggers warning)
- Actions with wrong status are rejected

---

### Module 5: SchemaDriftDetector — Ontology vs Database Integrity

**File**: `backend/analytics/ontology_drift.py`

Compares the Ontology entity definitions against the actual SQLite schema to detect drift.

```python
class SchemaDriftDetector:
    def __init__(self, catalog: OntologyCatalog, db_path: Path):
        self._catalog = catalog
        self._db_path = db_path

    def detect_drift(self) -> DriftReport:
        # For each entity with a table mapping:
        # 1. Check if table exists
        # 2. Compare actual columns vs defined properties
        # 3. Report: unmapped columns, missing columns, type mismatches

    def suggest_mappings(self, drift: DriftReport) -> list[MappingSuggestion]:
        # For unmapped columns, suggest ontology property mappings
        # Using name similarity (Levenshtein) and type compatibility
```

**Tests**: `backend/tests/test_ontology_drift.py`
- Clean DB (no drift) → empty report
- Extra column in DB → reported as unmapped
- Missing column in DB → reported as missing
- Suggest mappings based on name similarity

---

### Module 6: OntologyDiscovery — Automated Gap Detection

**File**: `backend/analytics/ontology_discovery.py`

Analyzes query logs and feedback to discover ontology gaps — terms, metrics, or relationships that users reference but aren't in the ontology.

```python
class OntologyDiscovery:
    def __init__(self, catalog: OntologyCatalog, resolver: OntologyTermResolver):
        self._catalog = catalog
        self._resolver = resolver

    def analyze_query_logs(self, logs: list[dict]) -> DiscoveryReport:
        # For each query in logs:
        # 1. Run through resolver
        # 2. If unresolved terms found, collect as candidates
        # 3. Group by frequency

    def suggest_new_terms(self, report: DiscoveryReport, top_n: int = 20) -> list[TermCandidate]:
        # Rank unresolved terms by frequency
        # Suggest resolution (entity/metric/dimension) based on context

    def suggest_new_relationships(self, logs: list[dict]) -> list[RelCandidate]:
        # Find entity pairs frequently co-occurring in queries
        # but not connected in the ontology
```

**Tests**: `backend/tests/test_ontology_discovery.py`
- Known terms resolve → not flagged
- Unknown terms → flagged with frequency
- Co-occurring entities → relationship candidates
- Empty logs → empty report

---

### Module 7: Constraints + Actions Content Expansion

**Files**: `ontology/v1/constraints.json` (expand), `ontology/v1/actions.json` (expand)

Expand from 5 → 25+ constraints covering all critical metrics. Expand from 3 → 10+ actions covering all agent tools.

New constraints:
- Every KPI metric gets a target constraint
- Data quality constraints (non-null, valid enum, etc.)
- Business rule constraints (China scope, phase transitions, etc.)

New actions:
- query_defects, query_trend, get_distribution, get_ranking
- search_similar, get_dashboard, analyze_data
- Each with proper capability states and governance

---

### Module 8: Semantic Relations Enhancement (SKOS)

**File**: `ontology/v1/vocab.zh-CN.json` (expand)

Add SKOS-style semantic relations between terms:
- `synonyms`: synonym rings (RG5 = 功能完整 = Reifegrad 5)
- `broader`: hypernyms (Top Issue ⊂ Defect)
- `narrower`: hyponyms
- `related`: related concepts (Top Issue ↔ Showstopper)
- `state_transitions`: ordered state machines (RG4 → RG5 → RG6)

---

### Module 9: Integration — Wire Everything Together

**File**: `backend/analytics/ontology_engine.py` (new)

Single entry point that wires all modules together:

```python
class OntologyEngine:
    """One-stop ontology reasoning engine."""
    def __init__(self, db_path: Path | None = None):
        self._catalog = load_ontology()
        self._resolver = OntologyTermResolver(self._catalog)
        self._prompt = OntologyPromptBuilder(self._catalog)
        self._graph = OntologyGraph(self._catalog)
        self._guardrail = ConstraintGuardrail(self._catalog)
        if db_path:
            self._drift = SchemaDriftDetector(self._catalog, db_path)
            self._discovery = OntologyDiscovery(self._catalog, self._resolver)

    @cached_property
    def system_prompt_context(self) -> str:
        return self._prompt.build_system_context()

    def resolve_terms(self, text: str) -> list[TermMatch]:
        return self._resolver.resolve(text)

    def validate_query(self, metric_id, dimensions, filters) -> GuardrailResult:
        return self._guardrail.validate_query(metric_id, dimensions, filters)

    def explore_graph(self, entity_id, max_hops=2):
        return self._graph.neighbors(entity_id, max_hops)
```

---

## Execution Order

| # | Module | Dependencies | Est. LOC |
|---|--------|-------------|----------|
| 1 | OntologyTermResolver | catalog | ~250 |
| 2 | OntologyPromptBuilder | catalog | ~200 |
| 3 | OntologyGraph | catalog + networkx | ~300 |
| 4 | ConstraintGuardrail | catalog | ~250 |
| 5 | SchemaDriftDetector | catalog + db | ~200 |
| 6 | OntologyDiscovery | catalog + resolver | ~250 |
| 7 | Content Expansion | v1/ JSON files | ~800 |
| 8 | SKOS Enhancement | vocab.zh-CN.json | ~300 |
| 9 | OntologyEngine (integration) | all above | ~150 |
| 10 | Recompile + verify | all above | — |

**Total**: ~2700 LOC + tests (~1500 LOC)

## Principles

- **TDD**: Every module gets comprehensive tests first
- **No external services**: NetworkX in-memory, no Neo4j required
- **Backward compatible**: Existing API surface unchanged
- **Ontology stays in JSON**: Source of truth remains v1/*.json
- **Lazy loading**: Graph and resolver only initialize when first used
