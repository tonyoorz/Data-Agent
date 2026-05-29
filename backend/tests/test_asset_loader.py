from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from backend.analytics.asset_loader import load_mapping_assets
from backend.analytics.assets.import_tpmdashboard_assets import import_tpmdashboard_assets


def test_load_mapping_assets_reads_repo_local_json(tmp_path: Path) -> None:
    data_root = tmp_path / "data"
    data_root.mkdir(parents=True)
    (data_root / "top_aida_project_fv_mapping.json").write_text(
        json.dumps(
            [
                {
                    "top_aida": "Use Speech operation [01.04.02.01.01.05]",
                    "project": "IDCEVO",
                    "fv": "Speech",
                    "fvp": "Voice Experience",
                }
            ]
        ),
        encoding="utf-8",
    )
    (data_root / "vin_project_mapping.json").write_text(
        json.dumps(
            [
                {"vin_prefix": "WBA71", "project": "IDC", "market": "China"}
            ]
        ),
        encoding="utf-8",
    )
    (data_root / "mr_nonstandard_platform_ids.json").write_text(
        json.dumps(["PLATFORM-1", "PLATFORM-2"]),
        encoding="utf-8",
    )

    assets = load_mapping_assets(data_root)

    assert assets.aida_rows[0]["fv"] == "Speech"
    assert assets.vin_project_rows[0]["project"] == "IDC"
    assert assets.nonstandard_platform_ids == {"PLATFORM-1", "PLATFORM-2"}


def test_import_tpmdashboard_assets_normalizes_source_files(tmp_path: Path) -> None:
    tpmd_root = tmp_path / "TPMDashbaord"
    (tpmd_root / "aida").mkdir(parents=True)
    (tpmd_root / "project").mkdir(parents=True)

    pd.DataFrame(
        [
            {
                "Top AIDA": "Use Speech operation [01.04.02.01.01.05]",
                "Project": "IDCEVO",
                "FV": "Speech",
                "FVP": "Voice Experience",
            }
        ]
    ).to_excel(tpmd_root / "aida" / "top_aida_project_fv_mapping.xlsx", index=False)

    pd.DataFrame(
        [
            {"vin_prefix": "WBA71", "project": "IDC", "market": "China"}
        ]
    ).to_excel(tpmd_root / "project" / "vin_project_mapping.xlsx", index=False)

    pd.DataFrame([{"platform_id": "PLATFORM-1"}]).to_csv(
        tpmd_root / "project" / "mr_nonstandard_platform_ids.csv",
        index=False,
    )

    output_root = tmp_path / "repo_assets"
    summary = import_tpmdashboard_assets(tpmd_root, output_root)

    assert summary == {
        "aida_rows": 1,
        "vin_project_rows": 1,
        "nonstandard_platform_rows": 1,
    }
    assert (output_root / "top_aida_project_fv_mapping.json").exists()
    assert (output_root / "vin_project_mapping.json").exists()
    assert (output_root / "mr_nonstandard_platform_ids.json").exists()