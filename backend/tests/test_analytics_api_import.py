import importlib


def test_analytics_api_module_imports_without_legacy_top_issue_builder() -> None:
    module = importlib.reload(importlib.import_module("backend.analytics.api"))

    assert module.app.title == "Vizion Analytics API"
