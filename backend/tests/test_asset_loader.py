from __future__ import annotations

import json
from pathlib import Path

from backend.analytics.asset_loader import load_mapping_assets


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

