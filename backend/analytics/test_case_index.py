"""RAG retrieval of similar Octane test cases for test-case generation.

Reuses the generic ``DuplicateIssueIndex`` (hybrid dense-embedding + TF-IDF sparse + RRF fusion)
from ``backend.duplicate_issue_finder`` — the same engine that powers defect duplicate search —
but indexes ``test_manual`` cases from the local SQLite store instead of defects.

The index is built from the ``octane_testcases`` table (16K+ rows with ``test_name`` as the
embedding text). The test name is actually quite descriptive for embedding purposes, e.g.:
``[IDCEVO][PU2707] Regression - pps CPU load stable when car is moving (D2804379)``.

For richer embeddings (description + steps), the index can be enriched later by fetching
``/tests/{id}`` and ``/tests/{id}/script`` from Octane — but the name-only index is a fast
starting point that needs no Octane API calls.
"""
from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass
from typing import Any, Sequence

import pandas as pd

from backend.analytics.config import get_full_picture_source_db_path
from backend.duplicate_issue_finder import (
    _DEFAULT_EMBEDDING_DB,
    DEFAULT_TEXT_FIELDS,
    DuplicateIssueIndex,
    DuplicateSearchHints,
    extract_hints,
)

# Test cases have no "status_phase" to filter — don't exclude any.
_TEST_CASE_TEXT_FIELDS: tuple[str, ...] = ("name", "test_subtype", "scope_team", "scope_release")

# Separate embedding cache DB so test_id embeddings don't collide with defect_id embeddings
# in the shared ticket_embeddings.db (both are 6-7 digit numbers with overlapping ranges).
_TEST_CASE_EMBEDDING_DB = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "database",
    "test_case_embeddings.db",
)

# In-process cache so repeated calls within one session don't rebuild.
_INDEX_CACHE: dict[str, DuplicateIssueIndex] = {}


@dataclass(frozen=True)
class SimilarTestCase:
    """A retrieved similar test case, for use as a few-shot example in generation."""

    test_id: str
    name: str
    score: float
    team: str
    release: str
    subtype: str


def _load_test_cases_df(db_path: str | None = None) -> pd.DataFrame:
    """Load ``octane_testcases`` into a DataFrame suitable for ``DuplicateIssueIndex.build_from_df``.

    The index needs an ``id`` column and the text fields listed in ``_TEST_CASE_TEXT_FIELDS``.
    """
    resolved_path = db_path or str(get_full_picture_source_db_path())
    conn = sqlite3.connect(resolved_path)
    try:
        df = pd.read_sql_query(
            """
            SELECT test_id          AS id,
                   test_name        AS name,
                   test_subtype     AS test_subtype,
                   scope_team       AS scope_team,
                   scope_release    AS scope_release,
                   run_count        AS run_count
            FROM octane_testcases
            WHERE test_name IS NOT NULL AND TRIM(test_name) != ''
            """,
            conn,
        )
    finally:
        conn.close()
    # DuplicateIssueIndex expects a "status_phase" column for filtering — add a dummy so
    # build_from_df's phase-exclusion logic doesn't crash (it checks "status_phase" in columns).
    df["status_phase"] = ""
    return df


def get_or_build_test_case_index(db_path: str | None = None) -> DuplicateIssueIndex:
    """Build (or return cached) the test-case similarity index.

    Reuses ``DuplicateIssueIndex`` with test-case-specific text fields. The index is cached
    in-process for the session lifetime. For cross-session persistence, the existing snapshot
    mechanism in ``duplicate_issue_finder`` could be wired in later.
    """
    cache_key = "test_cases_v1"
    if cache_key in _INDEX_CACHE and _INDEX_CACHE[cache_key].ready:
        return _INDEX_CACHE[cache_key]

    df = _load_test_cases_df(db_path)
    index = DuplicateIssueIndex(
        excluded_phase_prefixes=(),  # don't filter test cases by phase
        text_fields=_TEST_CASE_TEXT_FIELDS,
        embedding_cache_db_path=_TEST_CASE_EMBEDDING_DB,  # isolated from defect cache
        embedding_cache_table="test_case_embeddings",  # proper naming, not "ticket_embeddings"
        embedding_cache_id_column="test_id",  # proper naming, not "ticket_id"
    )
    index.build_from_df(df)
    _INDEX_CACHE[cache_key] = index
    return index


def retrieve_similar_test_cases(
    query: str,
    *,
    top_k: int = 5,
    db_path: str | None = None,
) -> list[SimilarTestCase]:
    """Retrieve the top-k most similar test cases to a query (typically the defect name + description).

    This is the RAG retrieval step: find existing test cases that are semantically similar to the
    defect being turned into a test. The results serve as few-shot examples for the LLM generation
    step — they show what a well-written test case in the same domain looks like (structure,
    granularity, checkpoint style).

    Hybrid retrieval: dense (embedding similarity) + sparse (TF-IDF keyword) fused via RRF —
    the same mechanism that powers defect duplicate search.
    """
    index = get_or_build_test_case_index(db_path=db_path)
    if not index.ready:
        return []

    hints = extract_hints(query)
    candidates, _meta = index.search_with_metadata(query, hints=hints, top_k=top_k)

    results: list[SimilarTestCase] = []
    for cand in candidates[:top_k]:
        meta = cand.ranking_signals or {}
        results.append(
            SimilarTestCase(
                test_id=str(getattr(cand, "ticket_id", "") or ""),
                name=str(getattr(cand, "name", "") or ""),
                score=float(getattr(cand, "similarity", 0.0) or 0.0),
                team=str(meta.get("team", "") or ""),
                release=str(meta.get("release", "") or ""),
                subtype=str(meta.get("subtype", "") or ""),
            )
        )
    return results


def format_few_shot_examples(cases: Sequence[SimilarTestCase], *, max_cases: int = 3) -> str:
    """Format retrieved test cases as a few-shot context string for the LLM generation prompt.

    This goes into the generation prompt so the LLM can see what real test cases in the same
    domain look like — their naming, structure, and granularity — before generating a new one.
    """
    if not cases:
        return ""
    lines = ["Here are similar existing test cases in the same domain for reference (structure, naming, granularity):"]
    for case in list(cases)[:max_cases]:
        lines.append(f"- [T{case.test_id}] {case.name} (similarity: {case.score:.2f})")
    lines.append("Use these as style/structure reference, but generate content specific to the source defect.")
    return "\n".join(lines)
