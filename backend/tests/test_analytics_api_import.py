import importlib
import sys


def test_analytics_api_module_imports_without_legacy_top_issue_builder() -> None:
    sys.modules.pop("backend.analytics.api", None)

    module = importlib.import_module("backend.analytics.api")

    assert module.app.title == "Vizion Analytics API"