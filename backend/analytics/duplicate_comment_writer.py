from __future__ import annotations

from html import escape
from typing import Any


def _ticket_url(ticket_id: str) -> str:
    return (
        "https://octane-prod.bmwgroup.net/ui/?p=1002/2001"
        f"#/entity-navigation?entityType=work_item&id={escape(ticket_id, quote=True)}"
    )


def _format_int(value: object) -> str:
    try:
        return f"{int(value):,}"
    except (TypeError, ValueError):
        return "unknown"


def _format_score(value: object) -> str:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return "-"
    if numeric.is_integer():
        return str(int(numeric))
    return f"{numeric:.1f}".rstrip("0").rstrip(".")


def _candidate_confidence(candidate: dict[str, Any]) -> str:
    score = _format_score(candidate.get("confidenceScore1to10") or candidate.get("score1to10"))
    return f"{score}/10"


def _candidate_similarity(candidate: dict[str, Any]) -> str:
    score = _format_score(candidate.get("score1to10"))
    return f"{score}/10"


def _numeric_score(value: object) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _ordered_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        candidates,
        key=lambda candidate: (
            _numeric_score(candidate.get("confidenceScore1to10") or candidate.get("score1to10")),
            _numeric_score(candidate.get("score1to10")),
            _numeric_score(candidate.get("similarity")),
        ),
        reverse=True,
    )


def _short_text(value: object, *, max_chars: int = 150) -> str:
    text = " ".join(str(value or "").split())
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."


def _summary_html(value: object, *, max_chars: int = 360) -> str:
    text = _short_text(value, max_chars=max_chars)
    if not text:
        return ""
    return f"\n  <tr><td><strong>Analysis</strong></td><td>{escape(text)}</td></tr>"


def _candidate_focus(candidate: dict[str, Any]) -> str:
    review_focus = _short_text(candidate.get("reviewFocus"), max_chars=140)
    if review_focus:
        return f"Review focus: {review_focus}"
    evidence = [item for item in list(candidate.get("evidenceSnippets") or []) if _short_text(item, max_chars=20)]
    if evidence:
        return f"Review focus: {_short_text(evidence[0], max_chars=120)}"
    snippet = _short_text(candidate.get("snippet"), max_chars=95)
    if snippet:
        return f"Review focus: {snippet}"
    return "Review focus: compare platform, trigger path, timestamp and logs."


def _assessment_text(top_score: object) -> str:
    try:
        score = float(top_score)
    except (TypeError, ValueError):
        score = 0
    if score >= 8:
        return "High confidence — review the top candidate first before linking or closing."
    if score >= 6:
        return "Medium confidence — related historical defects found; no automatic duplicate confirmation."
    if score >= 4:
        return "Low confidence — use these candidates only as review hints."
    return "Weak match — no strong duplicate signal found."


def ensure_duplicate_summary(duplicate_result: dict[str, Any]) -> dict[str, Any]:
    if _short_text(duplicate_result.get("summaryText"), max_chars=20):
        return duplicate_result
    candidates = _ordered_candidates([item for item in list(duplicate_result.get("candidates") or []) if isinstance(item, dict)])
    if not candidates:
        return {**duplicate_result, "summaryText": "No duplicate candidate found. Add more defect context and rerun duplicate search."}

    top = candidates[0]
    top_id = str(top.get("ticketId") or "N/A")
    top_name = _short_text(top.get("name"), max_chars=90)
    top_score = _format_score(top.get("score1to10"))
    top_snippet = _short_text(top.get("snippet"), max_chars=150)
    evidence = [
        _short_text(item, max_chars=120)
        for item in list(top.get("evidenceSnippets") or [])
        if _short_text(item, max_chars=120)
    ][:2]
    parts = [
        f"Most likely candidate: D{top_id} ({top_name}), score {top_score}/10.",
        "Assessment: medium confidence; review before linking because no high-confidence duplicate is confirmed.",
    ]
    if top_snippet:
        parts.append(f"Similarity signal: {top_snippet}")
    if evidence:
        parts.append(f"Evidence: {'; '.join(evidence)}")
    parts.append("Next check: compare platform, I-step, trigger path, voice assistant variant, timestamp and logs.")
    return {**duplicate_result, "summaryText": " ".join(parts)}


def build_compact_duplicate_comment_html(
    *,
    ticket_id: str,
    ticket_name: str,
    duplicate_result: dict[str, Any],
    marker: str = "",
    max_candidates: int = 5,
) -> str:
    duplicate_result = ensure_duplicate_summary(duplicate_result)
    candidates = _ordered_candidates([item for item in list(duplicate_result.get("candidates") or []) if isinstance(item, dict)])
    top_confidence = candidates[0].get("confidenceScore1to10") or candidates[0].get("score1to10") if candidates else None
    top_similarity = candidates[0].get("score1to10") if candidates else None
    model_phase = escape(str(duplicate_result.get("modelPhase") or "unknown"))
    dataset_size = _format_int(duplicate_result.get("dataset_size"))
    context = f"{model_phase} · {dataset_size} defects · top confidence {_format_score(top_confidence)}/10 · top similarity {_format_score(top_similarity)}/10"
    marker_comment = f"<!-- {escape(marker)} -->" if marker else ""
    analysis_row = _summary_html(duplicate_result.get("summaryText"))

    candidate_lines: list[str] = []
    for candidate in candidates[:max_candidates]:
        candidate_id = escape(str(candidate.get("ticketId") or "N/A"))
        candidate_name = escape(_short_text(candidate.get("name"), max_chars=80))
        confidence = escape(_candidate_confidence(candidate))
        similarity = escape(_candidate_similarity(candidate))
        review_focus = escape(_candidate_focus(candidate))
        focus_text = f" — {review_focus}" if review_focus else ""
        candidate_lines.append(
            "<div>"
            f"<a href=\"{_ticket_url(candidate_id)}\"><strong>D{candidate_id}</strong></a>: "
            f"<strong>(review confidence {confidence}; similarity {similarity})</strong> {candidate_name}{focus_text}"
            "</div>"
        )
    candidates_html = "\n    ".join(candidate_lines) or "No duplicate candidate found."

    return f"""<html><body>{marker_comment}
<table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;border-color:#d0d7de;width:100%;max-width:760px;table-layout:fixed;">
  <colgroup><col style="width:145px;"><col></colgroup>
  <tr><td><strong>🤖 Agent</strong></td><td><strong>Duplicate Search Agent</strong></td></tr>
  <tr><td><strong>Defect name</strong></td><td>{escape(ticket_name)}</td></tr>
    <tr><td><strong>Assessment</strong></td><td>{escape(_assessment_text(top_confidence))}</td></tr>
  <tr><td><strong>Search context</strong></td><td>{context}</td></tr>
    {analysis_row}
  <tr><td><strong>Duplicate candidates</strong></td><td>
    {candidates_html}
  </td></tr>
  <tr><td><strong>Recommended next step</strong></td><td>Add platform, PU / I-step, wake-up trigger path, voice assistant variant, timestamp and logs. Current description may be too short for high-confidence duplicate classification.</td></tr>
</table>
</body></html>"""
