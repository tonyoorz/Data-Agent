"""Build structured test-case content from an Octane defect.

The generated description follows the workspace 2001 convention observed in real hand-written
test cases (e.g. test 152393): a single ``<html><body><p>...</p></body></html>`` block with
ordered sections — Objective, Reference, Preconditions, baseline/regression data tables,
procedure (numbered steps), expected results, and pass/fail criteria.

Test steps are NOT a separate collection in this workspace (``/test_steps`` returns 404), so the
full procedure lives in the ``description`` field of the ``test_manual`` entity.
"""
from __future__ import annotations

from html import escape
from typing import Any, Mapping, Sequence

OCTANE_WORK_ITEM_URL = (
    "https://octane-prod.bmwgroup.net/ui/?p=1002/2001"
    "#/entity-navigation?entityType=work_item&id={defect_id}"
)


def _text(value: Any, *, max_chars: int = 0) -> str:
    text = str(value or "").strip()
    if max_chars and len(text) > max_chars:
        text = text[: max_chars - 3].rstrip() + "..."
    return text


def _para(text: str) -> str:
    return f"<p>{text}</p>"


def _row(cells: Sequence[str]) -> str:
    return "<tr>" + "".join(f"<td>{escape(c)}</td>" for c in cells) + "</tr>"


def _header_row(cells: Sequence[str]) -> str:
    return "<tr>" + "".join(f"<th>{escape(c)}</th>" for c in cells) + "</tr>"


def _table(header: Sequence[str], rows: Sequence[Sequence[str]]) -> str:
    parts = [
        '<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse">',
        _header_row(header),
        *[_row(r) for r in rows],
        "</table>",
    ]
    return "".join(parts)


def build_test_case_description(
    *,
    defect: Mapping[str, Any],
    procedure_steps: Sequence[str],
    expected: Sequence[str],
    preconditions: Sequence[str] | None = None,
    pass_criteria: str = "",
    fail_criteria: str = "",
    baseline_table: Sequence[Sequence[str]] | None = None,
    regression_table: Sequence[Sequence[str]] | None = None,
    extra_notes: str = "",
) -> str:
    """Render the full HTML description for a ``test_manual`` from a defect.

    Args:
        defect: a mapping with at least ``defect_id``, ``name``, ``severity``,
            ``software_version``, ``assigned_ecu``, ``lead_model``. Used to populate the
            Objective and Reference sections.
        procedure_steps: ordered test steps (already numbered or plain; numbering is applied).
        expected: expected-result bullet lines.
        preconditions: optional precondition bullet lines.
        pass_criteria / fail_criteria: explicit verdict criteria.
        baseline_table / regression_table: optional (header, rows...) rendered as HTML tables
            for before/after quantitative comparison.
        extra_notes: free-form trailing notes paragraph.
    """
    defect_id = _text(defect.get("defect_id"))
    defect_name = _text(defect.get("name"), max_chars=180)
    severity = _text(defect.get("severity"))
    sw = _text(defect.get("software_version"))
    ecu = _text(defect.get("assigned_ecu"))
    model = _text(defect.get("lead_model"))

    parts: list[str] = ["<html><body>"]

    parts.append(
        _para(
            f"<b>Objective:</b> Regression test derived from defect D{defect_id}"
            + (f" ({severity})" if severity else "")
            + f". {defect_name}."
        )
    )
    parts.append("<p>&nbsp;</p>")

    # Reference
    ref_lines = [
        f"- Defect: <a href=\"{OCTANE_WORK_ITEM_URL.format(defect_id=defect_id)}\">D{defect_id} - {escape(defect_name)}</a>"
    ]
    if sw:
        ref_lines.append(f"- Software under test: {escape(sw)}")
    if ecu:
        ref_lines.append(f"- ECU: {escape(ecu)}")
    if model:
        ref_lines.append(f"- Test vehicle: {escape(model)}")
    parts.append(_para("<b>Reference:</b>"))
    parts.extend(_para(line) for line in ref_lines)
    parts.append("<p>&nbsp;</p>")

    # Preconditions
    if preconditions:
        parts.append(_para("<b>Preconditions:</b>"))
        parts.extend(_para(f"- {escape(line)}") for line in preconditions)
        parts.append("<p>&nbsp;</p>")

    # Quantitative tables
    if baseline_table:
        parts.append(_para("<b>Baseline reference:</b>"))
        parts.append(_table(baseline_table[0], baseline_table[1:]))
        parts.append("<p>&nbsp;</p>")
    if regression_table:
        parts.append(_para("<b>Regression observed:</b>"))
        parts.append(_table(regression_table[0], regression_table[1:]))
        parts.append("<p>&nbsp;</p>")

    # Procedure
    parts.append(_para("<b>procedure:</b>"))
    for index, step in enumerate(procedure_steps, start=1):
        parts.append(_para(f"{index}. {escape(step)}"))
    parts.append("<p>&nbsp;</p>")

    # Expected
    parts.append(_para("<b>expected:</b>"))
    parts.extend(_para(f"- {escape(line)}") for line in expected)
    parts.append("<p>&nbsp;</p>")

    # Pass / fail criteria
    if pass_criteria:
        parts.append(_para(f"<b>Pass criteria:</b> {escape(pass_criteria)}"))
    if fail_criteria:
        parts.append(_para(f"<b>Fail criteria:</b> {escape(fail_criteria)}"))
    if extra_notes:
        parts.append("<p>&nbsp;</p>")
        parts.append(_para(escape(extra_notes)))

    parts.append("</body></html>")
    return "".join(parts)


# Workspace-local constants discovered empirically (workspace 1002/2001).
# These are the required list_node / phase ids for test_manual creation. They are stable
# workspace metadata; override via env if a workspace differs.
DEFAULT_SERVICEPACK_NODE_ID = "d1598r3mjrp37by4yjvy1860k"  # SP2021
DEFAULT_TEST_PHASE_ID = "phase.test_manual.new"  # New / In Design


def build_test_steps_script(
    *,
    preconditions: Sequence[str] = (),
    steps: Sequence[str] = (),
    checkpoints: Sequence[str] = (),
) -> str:
    """Render the plain-text steps script for the ``/tests/{id}/script`` sub-resource.

    Follows the workspace convention observed in hand-written test 1414874: each line is one
    step, prefixed by its kind — ``[PreCon]`` (precondition), unprefixed (action), ``?``
    (checkpoint / expected result). The leading ``- `` is added per line. The script is NOT HTML;
    it is plain text stored at ``/tests/{id}/script`` (separate from the ``description`` field).
    """
    lines: list[str] = []
    for pre in preconditions:
        lines.append(f"- [PreCon] {pre}")
    for step in steps:
        lines.append(f"- {step}")
    for checkpoint in checkpoints:
        lines.append(f"- ? {checkpoint}")
    return "\n".join(lines)
