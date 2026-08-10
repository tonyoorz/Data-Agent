from __future__ import annotations

import json
import math
from collections.abc import Callable, Iterable, Sequence
from pathlib import Path
from typing import Any


SearchFn = Callable[[str, int], Sequence[str]]


def _normalize_ticket_ids(values: Any) -> list[str]:
    if not isinstance(values, Iterable) or isinstance(values, (str, bytes, bytearray)):
        return []
    ticket_ids: list[str] = []
    seen: set[str] = set()
    for value in values:
        ticket_id = str(value or "").strip()
        if not ticket_id or ticket_id in seen:
            continue
        seen.add(ticket_id)
        ticket_ids.append(ticket_id)
    return ticket_ids


def load_eval_cases(path: str | Path) -> list[dict[str, Any]]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError("duplicate search eval cases must be a JSON array")

    cases: list[dict[str, Any]] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        query = str(item.get("query") or "").strip()
        positive_ticket_ids = _normalize_ticket_ids(item.get("positive_ticket_ids"))
        if not query or not positive_ticket_ids:
            continue
        cases.append(
            {
                "query": query,
                "positive_ticket_ids": positive_ticket_ids,
                "negative_ticket_ids": _normalize_ticket_ids(item.get("negative_ticket_ids")),
            }
        )
    return cases


def build_eval_cases_from_feedback(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, list[str]]] = {}
    order: list[str] = []
    for row in rows:
        query = str(row.get("query_text") or "").strip()
        ticket_id = str(row.get("ticket_id") or "").strip()
        signal = str(row.get("signal") or "").strip().lower()
        if not query or not ticket_id:
            continue
        if query not in grouped:
            grouped[query] = {"positive": [], "negative": []}
            order.append(query)
        if signal == "positive" and ticket_id not in grouped[query]["positive"]:
            grouped[query]["positive"].append(ticket_id)
        elif signal == "negative" and ticket_id not in grouped[query]["negative"]:
            grouped[query]["negative"].append(ticket_id)

    cases: list[dict[str, Any]] = []
    for query in order:
        positives = grouped[query]["positive"]
        if not positives:
            continue
        positive_set = set(positives)
        negatives = [ticket_id for ticket_id in grouped[query]["negative"] if ticket_id not in positive_set]
        cases.append(
            {
                "query": query,
                "positive_ticket_ids": positives,
                "negative_ticket_ids": negatives,
            }
        )
    return cases


def _first_positive_rank(results: Sequence[str], positives: set[str], top_k: int) -> int | None:
    for index, ticket_id in enumerate(results[:top_k], start=1):
        if str(ticket_id) in positives:
            return index
    return None


def _dcg_at_k(results: Sequence[str], positives: set[str], top_k: int) -> float:
    dcg = 0.0
    for index, ticket_id in enumerate(results[:top_k], start=1):
        if str(ticket_id) in positives:
            dcg += 1.0 / math.log2(index + 1)
    return dcg


def _ideal_dcg(positive_count: int, top_k: int) -> float:
    return sum(1.0 / math.log2(index + 1) for index in range(1, min(positive_count, top_k) + 1))


def evaluate_duplicate_search(
    cases: Sequence[dict[str, Any]],
    search_fn: SearchFn,
    top_k: int = 10,
) -> dict[str, Any]:
    resolved_top_k = max(1, int(top_k))
    case_summaries: list[dict[str, Any]] = []
    recall_hits = 0
    reciprocal_rank_total = 0.0
    ndcg_total = 0.0
    precision_total = 0.0

    for case in cases:
        query = str(case.get("query") or "").strip()
        positives = set(_normalize_ticket_ids(case.get("positive_ticket_ids")))
        if not query or not positives:
            continue
        results = [str(ticket_id or "").strip() for ticket_id in search_fn(query, resolved_top_k)]
        results = [ticket_id for ticket_id in results if ticket_id]
        positive_rank = _first_positive_rank(results, positives, resolved_top_k)
        relevant_retrieved = sum(1 for ticket_id in results[:resolved_top_k] if ticket_id in positives)
        ideal = _ideal_dcg(len(positives), resolved_top_k)
        ndcg = 0.0 if ideal <= 0 else _dcg_at_k(results, positives, resolved_top_k) / ideal

        if positive_rank is not None:
            recall_hits += 1
            reciprocal_rank_total += 1.0 / float(positive_rank)
        ndcg_total += ndcg
        precision_total += float(relevant_retrieved) / float(resolved_top_k)
        case_summaries.append(
            {
                "query": query,
                "positive_ticket_ids": sorted(positives),
                "result_ticket_ids": results[:resolved_top_k],
                "positive_rank": positive_rank,
                "recall_hit": positive_rank is not None,
                "precision_at_k": float(relevant_retrieved) / float(resolved_top_k),
                "ndcg_at_k": ndcg,
            }
        )

    case_count = len(case_summaries)
    if case_count == 0:
        return {
            "case_count": 0,
            "top_k": resolved_top_k,
            "recall_at_k": 0.0,
            "mrr_at_k": 0.0,
            "precision_at_k": 0.0,
            "ndcg_at_k": 0.0,
            "cases": [],
        }

    return {
        "case_count": case_count,
        "top_k": resolved_top_k,
        "recall_at_k": recall_hits / case_count,
        "mrr_at_k": reciprocal_rank_total / case_count,
        "precision_at_k": precision_total / case_count,
        "ndcg_at_k": ndcg_total / case_count,
        "cases": case_summaries,
    }