"""JSON-lines bridge server for AIChat test-case creation.

Mirrors the protocol of ``scripts/duplicate_search_bridge.py``: read JSON lines from stdin,
write JSON + newline to stdout. The Node runtime (``testcaseBridgeRuntime.cjs``) spawns this
as a persistent child process and sends payloads like ``{"action": "prepare", "defect_id": "2804379"}``.

Actions:
  - ``warmup``  — build the 16K test-case embedding index (one-time, ~3 min first run)
  - ``prepare`` — read defect from local SQLite + RAG retrieve similar test cases + fetch
                  their full bodies (cached) + build ontology context. Returns
                  ``{success, defect_info, similar_cases, few_shot_text, context_text,
                  bodies_fetched}``. No LLM call.
  - ``verify``  — run ``verify_test_case()`` on generated content. Returns verification result.
  - ``commit``  — create test_manual in Octane + write steps. Returns ``{success, test_id, octane_url}``.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def _configure_utf8_stdio() -> None:
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream is not None and hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8")
            except Exception:
                pass


def _read_defect(defect_id: str) -> Dict[str, Any]:
    """Read a defect from the local SQLite store by defect_id."""
    from backend.analytics.config import get_full_picture_source_db_path

    normalized = str(defect_id or "").strip()
    if not normalized:
        raise ValueError("defect_id is required")

    conn = sqlite3.connect(str(get_full_picture_source_db_path()))
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT defect_id, name, severity, software_version, assigned_ecu, "
            "lead_model, project, phase, description FROM octane_defects WHERE defect_id = ?",
            (normalized,),
        ).fetchone()
    finally:
        conn.close()

    if row is None:
        raise ValueError(f"defect {normalized} not found in local SQLite")

    return {
        "defect_id": str(row["defect_id"] or ""),
        "name": str(row["name"] or ""),
        "severity": str(row["severity"] or ""),
        "software_version": str(row["software_version"] or ""),
        "assigned_ecu": str(row["assigned_ecu"] or ""),
        "lead_model": str(row["lead_model"] or ""),
        "project": str(row["project"] or ""),
        "phase": str(row["phase"] or ""),
        "description": str(row["description"] or ""),
    }


def _do_warmup() -> Dict[str, Any]:
    from backend.analytics.test_case_index import get_or_build_test_case_index

    idx = get_or_build_test_case_index()
    return {"success": True, "dataset_size": idx._row_count, "use_embeddings": idx._use_embeddings}


def _do_prepare(payload: Dict[str, Any]) -> Dict[str, Any]:
    from backend.analytics.test_case_bodies import full_bodies_enabled, get_test_bodies
    from backend.analytics.test_case_index import (
        format_few_shot_examples_full,
        retrieve_similar_test_cases,
    )

    defect_id = str(payload.get("defect_id") or "").strip()
    if not defect_id:
        return {"success": False, "error": "defect_id is required"}

    defect = _read_defect(defect_id)
    query = f"{defect['name']} {defect.get('project', '')} {defect.get('assigned_ecu', '')}"
    similar = retrieve_similar_test_cases(query, top_k=5)

    # Full-body few-shot: fetch (and cache) description+steps of the top reference cases so
    # the LLM imitates real step granularity/checkpoint style, not just the test names.
    # Best-effort — Octane unreachable degrades to name-only few-shot.
    bodies: Dict[str, Any] = {}
    if similar and full_bodies_enabled():
        try:
            bodies = get_test_bodies([c.test_id for c in similar[:3]])
        except Exception:
            bodies = {}
    few_shot = format_few_shot_examples_full(similar, bodies, max_cases=3)

    # Ontology context: business scope / run history / traceability / requirement, grounded
    # in the local SQLite store. Also best-effort — failure degrades to no context block.
    context_text = ""
    try:
        from backend.analytics.ontology_context import build_test_case_context_payload
        from backend.analytics.test_case_context import format_ontology_context_for_prompt

        context_payload = build_test_case_context_payload(
            {"anchor": {"type": "defect_id", "value": defect_id}}
        )
        context_text = format_ontology_context_for_prompt(context_payload)
    except Exception:
        context_text = ""

    return {
        "success": True,
        "defect_info": defect,
        "similar_cases": [
            {"testId": c.test_id, "name": c.name, "score": round(c.score, 3)}
            for c in similar
        ],
        "few_shot_text": few_shot,
        "context_text": context_text,
        "bodies_fetched": len(bodies),
    }


def _do_verify(payload: Dict[str, Any]) -> Dict[str, Any]:
    from backend.analytics.test_case_verifier import verify_test_case

    defect_info = payload.get("defect_info") or {}
    description_html = str(payload.get("description_html") or "")
    steps_text = str(payload.get("steps_text") or "")
    test_model = payload.get("test_model") or None
    combination_coverage = payload.get("combination_coverage") or []

    result = verify_test_case(
        defect=defect_info,
        description_html=description_html,
        steps_text=steps_text,
        test_model=test_model,
        combination_coverage=combination_coverage,
    )
    return {
        "success": True,
        "verification": {
            "passed": result.passed,
            "criteria": [
                {"name": c.name, "passed": c.passed, "evidence": c.evidence}
                for c in result.criteria
            ],
            "feedback": result.feedback,
        },
    }


def _do_commit(payload: Dict[str, Any]) -> Dict[str, Any]:
    from backend.analytics.ingest.client import build_default_octane_client

    test_case_data = payload.get("test_case_data") or {}
    feature_id = str(payload.get("feature_id") or "").strip()
    description_html = str(test_case_data.get("description_html") or test_case_data.get("descriptionHtml") or "")
    steps_text = str(test_case_data.get("steps_text") or test_case_data.get("stepsText") or "")
    name = str(test_case_data.get("name") or f"Generated test case from defect {test_case_data.get('defectId', '')}")

    # Resolve owner: read back from a created entity's author (no direct current-user endpoint).
    # For now, use the authenticated cookie identity — create_test_case defaults owner to the
    # authenticated user if omitted. But test_manual requires owner explicitly, so we resolve
    # it by fetching an existing test created by the current user.
    # Simpler: the caller (Node) can pass owner_workspace_user_id in the payload.
    owner_id = str(test_case_data.get("owner_workspace_user_id") or payload.get("owner_workspace_user_id") or "")
    if not owner_id:
        return {"success": False, "error": "owner_workspace_user_id is required for commit"}

    servicepack_id = str(test_case_data.get("servicepack_node_id") or "d1598r3mjrp37by4yjvy1860k")

    covered_ids = ()
    if feature_id:
        covered_ids = (feature_id,)

    client = build_default_octane_client()
    created = client.create_test_case(
        name=name,
        description_html=description_html,
        owner_workspace_user_id=owner_id,
        servicepack_node_id=servicepack_id,
        covered_work_item_ids=covered_ids,
    )
    test_id = str(created.get("id") or "")

    if steps_text and test_id:
        client.write_test_steps(test_id=test_id, steps_text=steps_text)

    octane_url = f"https://octane-prod.bmwgroup.net/ui/?p=1002/2001#/entity-navigation?entityType=work_item&id={test_id}"
    return {"success": True, "test_id": test_id, "octane_url": octane_url}


def _handle_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    action = str(payload.get("action") or "").strip()

    if action == "warmup":
        return _do_warmup()
    if action == "prepare":
        return _do_prepare(payload)
    if action == "verify":
        return _do_verify(payload)
    if action == "commit":
        return _do_commit(payload)
    return {"success": False, "error": f"unknown action: {action}"}


def run_server(
    input_stream: Any = sys.stdin,
    output_stream: Any = sys.stdout,
) -> None:
    for raw_line in input_stream:
        line = str(raw_line or "").strip()
        if not line:
            continue

        try:
            payload = json.loads(line)
        except Exception:
            payload = {}

        try:
            result = _handle_payload(payload)
        except Exception as exc:
            result = {"success": False, "error": str(exc)}

        output_stream.write(json.dumps(result, ensure_ascii=False))
        output_stream.write("\n")
        output_stream.flush()


def main() -> None:
    _configure_utf8_stdio()
    if "--server" in sys.argv[1:]:
        run_server()
        return

    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception:
        payload = {}

    try:
        result = _handle_payload(payload)
    except Exception as exc:
        result = {"success": False, "error": str(exc)}

    sys.stdout.write(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
