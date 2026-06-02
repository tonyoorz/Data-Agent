from __future__ import annotations

from backend.analytics.config import get_full_picture_source_db_path
from backend.analytics.processor import run_processor_pipeline


def sync_processed_fields_to_db(
    defect_df=None,
    manual_df=None,
    db_path=None,
    sync_defects: bool = True,
    sync_manual_runs: bool = True,
):
    summary = run_processor_pipeline(db_path or get_full_picture_source_db_path())
    return {
        "db_path": str(db_path or get_full_picture_source_db_path()),
        "defect_updates": int(summary.get("defect_updates") or 0),
        "manual_run_updates": int(summary.get("run_updates") or 0),
        "defect_years": [],
    }


def sync_processed_project_to_db(defect_df=None, manual_df=None, db_path=None):
    return sync_processed_fields_to_db(defect_df=defect_df, manual_df=manual_df, db_path=db_path)