from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class MappingAssets:
    aida_rows: list[dict[str, str]]
    vin_project_rows: list[dict[str, str]]
    nonstandard_platform_ids: set[str]


def get_asset_data_root() -> Path:
    return Path(__file__).resolve().parent / "assets" / "data"


def _read_json(path: Path) -> object:
    if not path.exists():
        raise FileNotFoundError(f"Missing mapping asset: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def load_mapping_assets(root: Path | str | None = None) -> MappingAssets:
    data_root = Path(root) if root is not None else get_asset_data_root()
    aida_rows = list(_read_json(data_root / "top_aida_project_fv_mapping.json"))
    vin_project_rows = list(_read_json(data_root / "vin_project_mapping.json"))
    nonstandard_platform_ids = {
        str(value).strip()
        for value in _read_json(data_root / "mr_nonstandard_platform_ids.json")
        if str(value).strip()
    }
    return MappingAssets(
        aida_rows=aida_rows,
        vin_project_rows=vin_project_rows,
        nonstandard_platform_ids=nonstandard_platform_ids,
    )