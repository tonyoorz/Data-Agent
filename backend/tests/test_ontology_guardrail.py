"""Tests for OntologyGuardrail — pre-execution validation."""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock

from backend.analytics.ontology_guardrail import (
    ConstraintGuardrail,
    GuardrailResult,
    GuardrailViolation,
    _parse_target,
    _check_threshold,
)


def _mock_catalog(
    constraints=None,
    metrics=None,
    actions=None,
):
    """Build a mock OntologyCatalog for testing."""
    catalog = MagicMock()
    bundle = {
        "constraints": constraints or [],
        "metrics": metrics or [],
        "actions": actions or [],
    }
    catalog.bundle = bundle
    return catalog


# --- _parse_target tests ---

class TestParseTarget:
    def test_percentage_gte(self):
        op, val = _parse_target(">=99%")
        assert op == ">="
        assert val == 0.99

    def test_percentage_lte(self):
        op, val = _parse_target("<=10%")
        assert op == "<="
        assert val == 0.10

    def test_plain_percentage(self):
        op, val = _parse_target("100%")
        assert val == 1.0

    def test_plain_number(self):
        op, val = _parse_target(">=0.95")
        assert op == ">="
        assert val == 0.95

    def test_empty(self):
        op, val = _parse_target("")
        assert op is None
        assert val is None


# --- _check_threshold tests ---

class TestCheckThreshold:
    def test_gte_pass(self):
        assert _check_threshold(">=", 0.99, 0.995) is True

    def test_gte_fail(self):
        assert _check_threshold(">=", 0.99, 0.98) is False

    def test_lte_pass(self):
        assert _check_threshold("<=", 0.10, 0.05) is True

    def test_lte_fail(self):
        assert _check_threshold("<=", 0.10, 0.15) is False


# --- ConstraintGuardrail tests ---

class TestConstraintGuardrail:
    def test_loads_approved_constraints(self):
        catalog = _mock_catalog(
            constraints=[
                {"id": "c1", "description": "Rule 1", "governance": {"status": "approved"}, "enforcement": "plan"},
                {"id": "c2", "description": "Rule 2", "governance": {"status": "draft"}, "enforcement": "plan"},
            ],
        )
        guard = ConstraintGuardrail(catalog=catalog)
        assert guard.constraint_count == 1  # only approved

    def test_validate_query_valid(self):
        catalog = _mock_catalog(
            metrics=[{
                "id": "defect.count",
                "governance": {"status": "approved"},
                "applicableDimensions": ["product.project", "quality.phase"],
            }],
        )
        guard = ConstraintGuardrail(catalog=catalog)
        result = guard.validate_query("defect.count", dimensions=["product.project"])
        assert result.passed is True
        assert len(result.violations) == 0

    def test_validate_query_unknown_metric(self):
        catalog = _mock_catalog(metrics=[])
        guard = ConstraintGuardrail(catalog=catalog)
        result = guard.validate_query("nonexistent.metric")
        assert result.passed is False
        assert "unknown_metric" in result.violations[0].rule_id

    def test_validate_query_draft_metric_warning(self):
        catalog = _mock_catalog(
            metrics=[{
                "id": "test.metric",
                "governance": {"status": "draft"},
                "applicableDimensions": [],
            }],
        )
        guard = ConstraintGuardrail(catalog=catalog)
        result = guard.validate_query("test.metric")
        assert result.passed is True  # passes but with warning
        assert result.has_warnings is True

    def test_validate_query_wrong_dimension(self):
        catalog = _mock_catalog(
            metrics=[{
                "id": "defect.count",
                "governance": {"status": "approved"},
                "applicableDimensions": ["product.project"],
            }],
        )
        guard = ConstraintGuardrail(catalog=catalog)
        result = guard.validate_query("defect.count", dimensions=["unknown.dim"])
        assert result.has_warnings is True

    def test_check_metric_target_within(self):
        catalog = _mock_catalog(
            metrics=[{
                "id": "kpi.cwa_rate",
                "targetValue": "<=10%",
                "governance": {"status": "approved"},
            }],
        )
        guard = ConstraintGuardrail(catalog=catalog)
        result = guard.check_metric_target("kpi.cwa_rate", 0.05)
        assert result.passed is True
        assert len(result.warnings) == 0

    def test_check_metric_target_exceeds(self):
        catalog = _mock_catalog(
            metrics=[{
                "id": "kpi.cwa_rate",
                "targetValue": "<=10%",
                "governance": {"status": "approved"},
            }],
        )
        guard = ConstraintGuardrail(catalog=catalog)
        result = guard.check_metric_target("kpi.cwa_rate", 0.15)
        assert result.has_warnings is True
        assert "target" in result.warnings[0].message.lower()

    def test_check_metric_target_ddp_below(self):
        catalog = _mock_catalog(
            metrics=[{
                "id": "kpi.ddp",
                "targetValue": ">=99%",
                "governance": {"status": "approved"},
            }],
        )
        guard = ConstraintGuardrail(catalog=catalog)
        result = guard.check_metric_target("kpi.ddp", 0.95)
        assert result.has_warnings is True

    def test_check_metric_target_no_target(self):
        catalog = _mock_catalog(
            metrics=[{"id": "defect.count", "governance": {"status": "approved"}}],
        )
        guard = ConstraintGuardrail(catalog=catalog)
        result = guard.check_metric_target("defect.count", 42.0)
        assert result.passed is True

    def test_validate_action_approved(self):
        catalog = _mock_catalog(
            actions=[{
                "id": "action.query_defects",
                "operation": "read",
                "targetEntityId": "quality.defect",
                "capabilityState": "available",
                "execution": {"mode": "enabled", "requiresHumanApproval": False, "requiresDryRun": False},
                "governance": {"status": "approved"},
            }],
        )
        guard = ConstraintGuardrail(catalog=catalog)
        result = guard.validate_action("action.query_defects")
        assert result.passed is True

    def test_validate_action_disabled(self):
        catalog = _mock_catalog(
            actions=[{
                "id": "action.delete",
                "execution": {"mode": "disabled"},
                "governance": {"status": "approved"},
            }],
        )
        guard = ConstraintGuardrail(catalog=catalog)
        result = guard.validate_action("action.delete")
        assert result.passed is False
        assert "action_disabled" in result.violations[0].rule_id

    def test_validate_action_unknown(self):
        catalog = _mock_catalog(actions=[])
        guard = ConstraintGuardrail(catalog=catalog)
        result = guard.validate_action("nonexistent")
        assert result.passed is False

    def test_validate_action_approval_required(self):
        catalog = _mock_catalog(
            actions=[{
                "id": "action.write",
                "execution": {"mode": "enabled", "requiresHumanApproval": True, "requiresDryRun": False},
                "governance": {"status": "approved"},
            }],
        )
        guard = ConstraintGuardrail(catalog=catalog)
        result = guard.validate_action("action.write")
        assert result.passed is True  # still passes but warns
        assert result.has_warnings is True

    def test_list_active_rules(self):
        catalog = _mock_catalog(
            constraints=[
                {"id": "r1", "description": "DDP target >= 99%", "enforcement": "plan", "governance": {"status": "approved"}},
                {"id": "r2", "description": "CWA rate <= 10%", "enforcement": "alert", "governance": {"status": "approved"}},
                {"id": "r3", "description": "Draft rule", "enforcement": "plan", "governance": {"status": "draft"}},
            ],
        )
        guard = ConstraintGuardrail(catalog=catalog)
        rules = guard.list_active_rules()
        assert len(rules) == 2
        assert "DDP" in rules[0]

    def test_list_available_actions(self):
        catalog = _mock_catalog(
            actions=[{
                "id": "action.query",
                "operation": "read",
                "targetEntityId": "quality.defect",
                "capabilityState": "available",
                "execution": {"mode": "enabled", "requiresHumanApproval": False, "requiresDryRun": False},
                "governance": {"status": "approved"},
            }],
        )
        guard = ConstraintGuardrail(catalog=catalog)
        actions = guard.list_available_actions()
        assert len(actions) == 1
        assert actions[0]["id"] == "action.query"

    def test_empty_catalog_no_crash(self):
        catalog = _mock_catalog()
        guard = ConstraintGuardrail(catalog=catalog)
        assert guard.validate_query("any.metric").passed is False  # unknown metric
        assert guard.validate_action("any.action").passed is False  # unknown action
        assert guard.check_metric_target("any.metric", 0.5).passed is False
        assert guard.list_active_rules() == []
        assert guard.constraint_count == 0
        assert guard.action_count == 0

    def test_guardrail_result_structure(self):
        result = GuardrailResult(passed=True)
        assert result.passed is True
        assert result.violations == []
        assert result.warnings == []
        assert result.has_errors is False
        assert result.has_warnings is False
        assert result.messages == []

        v = GuardrailViolation(severity="error", rule_id="test", message="msg")
        result2 = GuardrailResult(passed=False, violations=[v])
        assert result2.has_errors is True
        assert result2.messages == ["msg"]
