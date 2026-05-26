from __future__ import annotations

import re
import sqlite3
from pathlib import Path


def _normalize_text(value: object) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _normalize_project_name(value: object) -> str:
    text = _normalize_text(value)
    if not text:
        return ""

    normalized = text.upper().replace(" ", "")
    if normalized in {"UNKNOWN", "UNCLASSIFIED"}:
        return "Unknown"
    if "IDCEVO" in normalized:
        return "IDCEVO"
    if normalized in {"IDC", "IDC23"} or "IDC23" in normalized:
        return "IDC"
    if normalized in {"MGU", "MGU22"} or "BMWMGU" in normalized:
        return "MGU"
    if normalized.startswith("APP"):
        return "App"
    if "RSU" in normalized or "RSE" in normalized:
        return "RSU"
    return text


def _software_version_tokens(value: object) -> set[str]:
    text = _normalize_text(value).upper()
    if not text:
        return set()

    base_tokens = {token for token in re.split(r"[^A-Z0-9]+", text) if token}
    tokens = set(base_tokens)
    for token in list(base_tokens):
        if token.startswith("BMW") and len(token) > 3:
            tokens.add(token[3:])
    return tokens


def _project_from_software_version(value: object) -> str:
    tokens = _software_version_tokens(value)
    if not tokens:
        return ""

    if "IDCEVO" in tokens or "CDE" in tokens:
        return "IDCEVO"
    if "IDC23" in tokens:
        return "IDC"
    if "MGU22" in tokens:
        return "MGU"
    if "RSE26" in tokens:
        return "RSU"
    if tokens.intersection({"MOBILE", "ANDROID", "IOS", "HARMONYOS"}):
        return "App"
    return ""


def infer_defect_project(row: dict[str, object]) -> str:
    existing_project = _normalize_project_name(row.get("project"))
    if existing_project and existing_project != "Unknown":
        return existing_project

    top_aida = _normalize_text(row.get("top_aida"))
    product_areas = _normalize_text(row.get("product_areas"))
    solution_cluster = _normalize_text(row.get("solution_cluster"))
    feature_area = top_aida or product_areas

    if feature_area == "Use Rear Seat Entertainment [01.04.01.09.02]":
        return "RSU"
    if feature_area in {
        "Provide Navigation 2.0 [01.04.03.01.03.06]",
        "Use Speech operation [01.04.02.01.01.05]",
    }:
        return "IDCEVO"
    if solution_cluster == "Navigation Asia":
        return "MGU"

    assigned_ecu = _normalize_text(row.get("assigned_ecu")).upper()
    ecu_to_modul = _normalize_text(row.get("ecu_to_modul")).upper()
    function_responsible = _normalize_text(row.get("function_responsible")).upper()
    software_version = _normalize_text(row.get("software_version"))
    lead_model = _normalize_text(row.get("lead_model")).upper()
    software_version_project = _project_from_software_version(software_version)

    idcevo_signals = ["IDCEVO", "CDE-01", "ICON-25", "BMTH-01", "IPN-10", "IPN-10_DE", "SD-AMAP"]
    idc_signals = ["IDC23", "HU-MGU_02_A"]
    mgu_signals = ["MGU", "HU-MGU_02_L", "HU-MGU_01", "SP_NAVINFO", "BMT"]
    rsu_signals = ["RSE", "RSU"]
    app_signals = ["APP", "MOBILE", "MY BMW", "ANDROID", "IOS", "HARMONYOS"]

    if assigned_ecu == "IPN-15":
        return "IDCEVO"
    if assigned_ecu == "UCAP-10":
        return "MGU"
    if any(signal in assigned_ecu for signal in idcevo_signals):
        return "IDCEVO"
    if any(signal in assigned_ecu for signal in idc_signals):
        return "IDC"
    if any(signal in assigned_ecu for signal in mgu_signals):
        return "MGU"
    if any(signal in assigned_ecu for signal in rsu_signals):
        return "RSU"
    if any(signal in assigned_ecu for signal in app_signals):
        return "App"
    if software_version_project:
        return software_version_project

    if lead_model == "G78" and ecu_to_modul in {"CC", "KH"}:
        return "MGU"
    if lead_model == "G70" and ecu_to_modul == "FH":
        return "IDCEVO"
    if lead_model == "G68" and ecu_to_modul in {"CC", "FH"}:
        return "MGU"

    if lead_model == "G70" and function_responsible in {"RAINER FUNKE", "MARIJKE BRINKMANN"}:
        return "IDCEVO"

    if lead_model in {"U11", "U12"}:
        return "IDC"
    if lead_model in {"G50", "G58", "NA5", "NA6", "NA8"}:
        return "IDCEVO"
    if lead_model in {"G18", "G28"}:
        return "MGU"

    return "Unknown"


def _table_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    return {
        str(row[1]).strip()
        for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    }


def backfill_defect_projects(
    db_path: Path | str,
    *,
    apply: bool = False,
    only_unknown: bool = True,
) -> dict[str, object]:
    conn = sqlite3.connect(db_path)
    try:
        columns = _table_columns(conn, "octane_defects")
        required_columns = {"defect_id", "project", "top_aida", "assigned_ecu", "software_version", "lead_model"}
        missing_columns = sorted(required_columns - columns)
        if missing_columns:
            raise ValueError(f"octane_defects missing required columns: {', '.join(missing_columns)}")

        where_clause = "WHERE 1=1"
        if only_unknown:
            where_clause += " AND UPPER(TRIM(COALESCE(project, ''))) IN ('', 'UNKNOWN')"

        product_areas_select = "product_areas" if "product_areas" in columns else "'' AS product_areas"
        solution_cluster_select = (
            "solution_cluster" if "solution_cluster" in columns else "'' AS solution_cluster"
        )
        ecu_to_modul_select = "ecu_to_modul" if "ecu_to_modul" in columns else "'' AS ecu_to_modul"
        function_responsible_select = (
            "function_responsible"
            if "function_responsible" in columns
            else "'' AS function_responsible"
        )

        rows = conn.execute(
            f"""
            SELECT
                defect_id,
                project,
                top_aida,
                assigned_ecu,
                software_version,
                lead_model,
                {product_areas_select},
                {solution_cluster_select},
                {ecu_to_modul_select},
                {function_responsible_select}
            FROM octane_defects
            {where_clause}
            ORDER BY defect_id
            """
        ).fetchall()

        predicted_counts: dict[str, int] = {}
        updates: list[tuple[str, str]] = []
        for (
            defect_id,
            project,
            top_aida,
            assigned_ecu,
            software_version,
            lead_model,
            product_areas,
            solution_cluster,
            ecu_to_modul,
            function_responsible,
        ) in rows:
            predicted = infer_defect_project(
                {
                    "project": project,
                    "top_aida": top_aida,
                    "assigned_ecu": assigned_ecu,
                    "software_version": software_version,
                    "lead_model": lead_model,
                    "product_areas": product_areas,
                    "solution_cluster": solution_cluster,
                    "ecu_to_modul": ecu_to_modul,
                    "function_responsible": function_responsible,
                }
            )
            predicted_counts[predicted] = predicted_counts.get(predicted, 0) + 1
            if predicted != "Unknown":
                updates.append((predicted, str(defect_id)))

        if apply and updates:
            if "tproject" in columns:
                conn.executemany(
                    """
                    UPDATE octane_defects
                    SET project=?, tproject=?
                    WHERE defect_id=?
                    """,
                    [(project_name, project_name, defect_id) for project_name, defect_id in updates],
                )
            else:
                conn.executemany(
                    """
                    UPDATE octane_defects
                    SET project=?
                    WHERE defect_id=?
                    """,
                    updates,
                )
            conn.commit()

        return {
            "candidate_rows": len(rows),
            "updated_rows": len(updates) if apply else 0,
            "predicted_counts": dict(sorted(predicted_counts.items())),
        }
    finally:
        conn.close()


def sync_dimension_fields(
    db_path: Path | str,
    defect_dimension_rows: list[dict],
    run_dimension_rows: list[dict],
) -> dict[str, int]:
    conn = sqlite3.connect(db_path)
    try:
        defect_payload = [
            (
                row.get("project", ""),
                row.get("market", ""),
                row.get("pu", ""),
                row.get("fv", ""),
                row.get("fvp", ""),
                row.get("team", ""),
                row.get("lead_model", ""),
                row["id"],
            )
            for row in defect_dimension_rows
        ]
        run_payload = [
            (
                row.get("project", ""),
                row.get("fv", ""),
                row.get("fvp", ""),
                row.get("team", ""),
                row.get("lead_model", ""),
                row["id"],
            )
            for row in run_dimension_rows
        ]

        conn.executemany(
            """
            UPDATE octane_defects
            SET project=?, market=?, pu=?, fv=?, fvp=?, team=?, lead_model=?
            WHERE defect_id=?
            """,
            defect_payload,
        )
        defect_updates = conn.total_changes
        conn.executemany(
            """
            UPDATE octane_manual_runs
            SET project=?, fv=?, fvp=?, team=?, lead_model=?
            WHERE mr_id=?
            """,
            run_payload,
        )
        run_updates = conn.total_changes - defect_updates
        conn.commit()
        return {"defect_updates": defect_updates, "run_updates": run_updates}
    finally:
        conn.close()