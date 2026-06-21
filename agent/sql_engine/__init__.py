"""SQL Engine - CHASE-SQL Multi-Path NL→SQL Generation

Generator: 3-path SQL generation (direct, decomposed, plan-based)
Selector: candidate validation and selection
Examples: 30+ few-shot business query examples
"""

from agent.sql_engine.generator import (
    NL2SQLEngine, SQLCandidate, QueryResult,
    DirectGenerator, DecomposedGenerator, PlanBasedGenerator,
    get_nl2sql_engine
)
from agent.sql_engine.selector import SQLSelector, SelectionResult
from agent.sql_engine.examples import (
    get_examples_by_intent, get_similar_examples, get_all_examples, get_example_count
)

__all__ = [
    "NL2SQLEngine", "SQLCandidate", "QueryResult",
    "DirectGenerator", "DecomposedGenerator", "PlanBasedGenerator",
    "get_nl2sql_engine",
    "SQLSelector", "SelectionResult",
    "get_examples_by_intent", "get_similar_examples",
    "get_all_examples", "get_example_count",
]
