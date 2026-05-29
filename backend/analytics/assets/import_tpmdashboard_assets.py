from __future__ import annotations

import json
from pathlib import Path

import pandas as pd


def _normalize_columns(frame: pd.DataFrame) -> pd.DataFrame:
    frame.columns = [str(column).strip().lower().replace(" ", "_") for column in frame.columns]
    return frame


def import_tpmdashboard_assets(tpmdashboard_root: Path | str, output_root: Path | str) -> dict[str, int]:
    source_root = Path(tpmdashboard_root)
    target_root = Path(output_root)
    target_root.mkdir(parents=True, exist_ok=True)

    aida_frame = _normalize_columns(
        pd.read_excel(source_root / "aida" / "top_aida_project_fv_mapping.xlsx")
    )
    vin_frame = _normalize_columns(
        pd.read_excel(source_root / "project" / "vin_project_mapping.xlsx")
    )
    platform_frame = _normalize_columns(
        pd.read_csv(source_root / "project" / "mr_nonstandard_platform_ids.csv")
    )

    aida_rows = [
        {
            "top_aida": str(row.get("top_aida") or row.get("top_aida_name") or "").strip(),
            "project": str(row.get("project") or "").strip(),
            "fv": str(row.get("fv") or "").strip(),
            "fvp": str(row.get("fvp") or "").strip(),
        }
        for row in aida_frame.to_dict(orient="records")
        if str(row.get("top_aida") or row.get("top_aida_name") or "").strip()
    ]
    vin_rows = [
        {
            "vin_prefix": str(row.get("vin_prefix") or row.get("vin") or "").strip(),
            "project": str(row.get("project") or "").strip(),
            "market": str(row.get("market") or "").strip(),
        }
        for row in vin_frame.to_dict(orient="records")
        if str(row.get("vin_prefix") or row.get("vin") or "").strip()
    ]
    platform_rows = [
        str(row.get("platform_id") or row.get("mr_id") or "").strip()
        for row in platform_frame.to_dict(orient="records")
        if str(row.get("platform_id") or row.get("mr_id") or "").strip()
    ]

    (target_root / "top_aida_project_fv_mapping.json").write_text(
        json.dumps(aida_rows, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (target_root / "vin_project_mapping.json").write_text(
        json.dumps(vin_rows, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (target_root / "mr_nonstandard_platform_ids.json").write_text(
        json.dumps(platform_rows, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    return {
        "aida_rows": len(aida_rows),
        "vin_project_rows": len(vin_rows),
        "nonstandard_platform_rows": len(platform_rows),
    }