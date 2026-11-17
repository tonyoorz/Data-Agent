"""Format the ontology context payload as compact prompt text for test-case generation.

``ontology_context.build_test_case_context_payload`` returns a structured payload
(business scope, run statistics, traceability, gaps, defect context) grounded in the
local SQLite store. This module renders it into a few lines of prompt-friendly text —
the same approach as ``formatTestCaseContext`` in ``server/mainAgentTools.mjs``, kept
Python-side so the ``prepare`` bridge action can attach it without a Node round-trip.
"""
from __future__ import annotations

from typing import Any, Mapping

_MAX_DESCRIPTION_CHARS = 800
_MAX_LIST_ITEMS = 5


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _clip(text: str, limit: int) -> str:
    text = str(text or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit] + "…"


def _scope_line(payload: Mapping[str, Any]) -> str:
    scope = payload.get("business_scope") or {}
    parts = [
        f"project {_clean(scope.get('project'))}" if _clean(scope.get("project")) else "",
        f"release {_clean(scope.get('release'))}" if _clean(scope.get("release")) else "",
        f"week {_clean(scope.get('planned_week'))}" if _clean(scope.get("planned_week")) else "",
        f"AIDA {_clean(scope.get('aida'))}" if _clean(scope.get("aida")) else "",
        f"FV {_clean(scope.get('fv'))}" if _clean(scope.get("fv")) else "",
        f"team {_clean(scope.get('team'))}" if _clean(scope.get("team")) else "",
        f"lead model {_clean(scope.get('lead_model'))}" if _clean(scope.get("lead_model")) else "",
    ]
    return "; ".join(p for p in parts if p)


def _runs_line(payload: Mapping[str, Any]) -> str:
    summary = payload.get("coverage_summary") or {}
    parts = [
        f"related testcases {_clean(summary.get('related_testcases')) or 0}",
        f"latest runs {_clean(summary.get('latest_runs')) or 0}",
        f"passed {_clean(summary.get('passed')) or 0}",
        f"failed {_clean(summary.get('failed')) or 0}",
        f"requires_attention {_clean(summary.get('requires_attention')) or 0}",
        f"linked defects {_clean(summary.get('linked_defects')) or 0}",
    ]
    return "; ".join(parts)


def _named_items(entries: Any) -> list[str]:
    items: list[str] = []
    for entry in list(entries or [])[:_MAX_LIST_ITEMS]:
        if isinstance(entry, dict):
            name = _clean(entry.get("name")) or _clean(entry.get("id"))
            if name:
                items.append(name)
        elif _clean(entry):
            items.append(_clean(entry))
    return items


def format_ontology_context_for_prompt(payload: Mapping[str, Any] | None) -> str:
    """Render the ontology context payload into compact prompt text ('' when nothing useful)."""
    if not isinstance(payload, dict):
        return ""

    lines: list[str] = []
    scope = _scope_line(payload)
    if scope:
        lines.append(f"Verified business scope: {scope}.")
    runs = _runs_line(payload)
    if runs:
        lines.append(f"Historical runs: {runs}.")

    defect_context = payload.get("defect_context") or {}
    requirement = _clean(defect_context.get("requirement"))
    if requirement:
        lines.append(f"Requirement: {_clip(requirement, _MAX_DESCRIPTION_CHARS)}")
    description = _clean(defect_context.get("description"))
    if description and not requirement:
        lines.append(f"Defect background: {_clip(description, _MAX_DESCRIPTION_CHARS)}")

    traceability = payload.get("traceability") or {}
    for label, key in (("Feature", "features"), ("Story", "stories"), ("Linked defect", "defects")):
        for item in _named_items(traceability.get(key)):
            lines.append(f"{label}: {item}")

    for gap in list(payload.get("gaps") or [])[:_MAX_LIST_ITEMS]:
        if isinstance(gap, dict):
            gap_type = _clean(gap.get("gap_type"))
            description = _clean(gap.get("description"))
            if gap_type or description:
                lines.append(f"Gap: {_clip(f'{gap_type} - {description}' if description else gap_type, 200)}")

    if not lines:
        return ""

    lines.append("Use this ontology context as factual background for testcase drafting. Missing data is unknown, not zero.")
    return "\n".join(lines)
