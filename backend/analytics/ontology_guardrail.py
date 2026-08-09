"""
Ontology Constraint Guardrail — pre-execution validation.

Validates agent queries and actions against ontology constraints
before execution. Provides metric target checking and rule listing.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from backend.analytics.ontology import OntologyCatalog, OntologyLoadError, load_ontology


@dataclass
class GuardrailViolation:
    severity: str  # "error", "warning"
    rule_id: str
    message: str
    constraint_id: str | None = None


@dataclass
class GuardrailResult:
    passed: bool
    violations: list[GuardrailViolation] = field(default_factory=list)
    warnings: list[GuardrailViolation] = field(default_factory=list)

    @property
    def has_errors(self) -> bool:
        return any(v.severity == "error" for v in self.violations)

    @property
    def has_warnings(self) -> bool:
        return len(self.warnings) > 0 or any(v.severity == "warning" for v in self.violations)

    @property
    def messages(self) -> list[str]:
        msgs = [v.message for v in self.violations]
        msgs.extend(v.message for v in self.warnings)
        return msgs


def _parse_target(target_str: str) -> tuple[str | None, float | None]:
    """Parse a target value string like '>=99%', '<=10%', '100%', '>=0.95'.

    Returns (operator, numeric_value).
    """
    if not target_str:
        return None, None

    cleaned = str(target_str).strip()
    # Match operator + number + optional %
    m = re.match(r'^([<>=!]+)\s*(\d+\.?\d*)\s*%?$', cleaned)
    if m:
        op = m.group(1)
        val = float(m.group(2))
        if '%' in cleaned:
            val = val / 100.0 if val > 1 else val
        return op, val

    # Just a number
    m = re.match(r'^(\d+\.?\d*)\s*%?$', cleaned)
    if m:
        val = float(m.group(1))
        if '%' in cleaned:
            val = val / 100.0 if val > 1 else val
        return None, val

    return None, None


def _check_threshold(op: str | None, threshold: float, actual: float) -> bool:
    """Check if actual value passes the threshold."""
    if op == ">=":
        return actual >= threshold
    elif op == "<=":
        return actual <= threshold
    elif op == ">":
        return actual > threshold
    elif op == "<":
        return actual < threshold
    elif op == "==" or op == "=":
        return abs(actual - threshold) < 1e-9
    elif op is None:
        # No operator means "should be this value"
        return abs(actual - threshold) < 1e-9
    return True


class ConstraintGuardrail:
    """Pre-execution validator using ontology constraints, metrics, and actions."""

    def __init__(self, catalog: OntologyCatalog | None = None):
        try:
            self._catalog = catalog or load_ontology()
        except OntologyLoadError:
            self._catalog = None
            self._constraints: list[dict[str, Any]] = []
            self._metrics: dict[str, dict[str, Any]] = {}
            self._actions: list[dict[str, Any]] = []
            return

        bundle = self._catalog.bundle
        self._constraints = [
            c for c in bundle.get("constraints", [])
            if c.get("governance", {}).get("status") == "approved"
        ]
        self._metrics = {
            m["id"]: m for m in bundle.get("metrics", [])
        }
        self._actions = [
            a for a in bundle.get("actions", [])
            if a.get("governance", {}).get("status") == "approved"
        ]

    def validate_query(
        self,
        metric_id: str,
        dimensions: list[str] | None = None,
        filters: dict | None = None,
    ) -> GuardrailResult:
        """Validate a query against business constraints.

        Checks:
        1. Metric exists and governance status
        2. Dimensions are valid for the metric
        3. No constraint violations based on filters
        """
        violations: list[GuardrailViolation] = []
        warnings: list[GuardrailViolation] = []

        # Check metric exists
        metric = self._metrics.get(metric_id)
        if metric is None:
            violations.append(GuardrailViolation(
                severity="error",
                rule_id="unknown_metric",
                message=f"Unknown metric: '{metric_id}'. Available metrics: {', '.join(sorted(self._metrics.keys())[:10])}...",
            ))
            return GuardrailResult(passed=False, violations=violations)

        # Check metric governance
        gov_status = metric.get("governance", {}).get("status", "")
        if gov_status == "draft":
            warnings.append(GuardrailViolation(
                severity="warning",
                rule_id="draft_metric",
                message=f"Metric '{metric_id}' is in draft status — results may not be reliable.",
                constraint_id=None,
            ))

        # Check applicable dimensions
        applicable_dims = set(metric.get("applicableDimensions", []))
        if applicable_dims and dimensions:
            for dim in dimensions:
                if dim not in applicable_dims:
                    warnings.append(GuardrailViolation(
                        severity="warning",
                        rule_id="unmapped_dimension",
                        message=f"Dimension '{dim}' is not in the applicable dimensions for metric '{metric_id}'.",
                    ))

        # Check constraints relevant to this metric
        relevant_constraints = [
            c for c in self._constraints
            if metric_id in c.get("condition", "") or metric_id in str(c.get("parameters", {}))
        ]
        for constraint in relevant_constraints:
            enforcement = constraint.get("enforcement", "plan")
            if enforcement == "block":
                violations.append(GuardrailViolation(
                    severity="error",
                    rule_id=constraint.get("id", "constraint"),
                    message=constraint.get("description", "Constraint violated."),
                    constraint_id=constraint.get("id"),
                ))

        return GuardrailResult(
            passed=len(violations) == 0,
            violations=violations,
            warnings=warnings,
        )

    def validate_action(
        self,
        action_id: str,
        params: dict | None = None,
    ) -> GuardrailResult:
        """Validate if an action is permitted.

        Checks:
        1. Action exists
        2. Governance approved
        3. Execution mode enabled
        4. Human approval requirements
        """
        violations: list[GuardrailViolation] = []
        warnings: list[GuardrailViolation] = []

        action = None
        for a in self._actions:
            if a.get("id") == action_id:
                action = a
                break

        if action is None:
            violations.append(GuardrailViolation(
                severity="error",
                rule_id="unknown_action",
                message=f"Unknown action: '{action_id}'.",
            ))
            return GuardrailResult(passed=False, violations=violations)

        # Check execution mode
        execution = action.get("execution", {})
        mode = execution.get("mode", "")
        if mode != "enabled":
            violations.append(GuardrailViolation(
                severity="error",
                rule_id="action_disabled",
                message=f"Action '{action_id}' has execution mode '{mode}' — not enabled.",
                constraint_id=action_id,
            ))

        # Check if human approval required
        if execution.get("requiresHumanApproval", False):
            warnings.append(GuardrailViolation(
                severity="warning",
                rule_id="approval_required",
                message=f"Action '{action_id}' requires human approval before execution.",
            ))

        # Check if dry run required
        if execution.get("requiresDryRun", False):
            warnings.append(GuardrailViolation(
                severity="warning",
                rule_id="dry_run_required",
                message=f"Action '{action_id}' requires a dry run before execution.",
            ))

        return GuardrailResult(
            passed=len(violations) == 0,
            violations=violations,
            warnings=warnings,
        )

    def check_metric_target(
        self,
        metric_id: str,
        value: float,
    ) -> GuardrailResult:
        """Compare a computed value against the metric's target/threshold.

        Parses targetValue strings like '>=99%', '<=10%', '100%'.
        """
        violations: list[GuardrailViolation] = []
        warnings: list[GuardrailViolation] = []

        metric = self._metrics.get(metric_id)
        if metric is None:
            violations.append(GuardrailViolation(
                severity="error",
                rule_id="unknown_metric",
                message=f"Unknown metric: '{metric_id}'.",
            ))
            return GuardrailResult(passed=False, violations=violations)

        target_str = metric.get("targetValue", "")
        if not target_str:
            # No target defined — nothing to check
            return GuardrailResult(passed=True)

        op, threshold = _parse_target(str(target_str))
        if threshold is None:
            # Can't parse target — skip
            return GuardrailResult(passed=True)

        if op and not _check_threshold(op, threshold, value):
            warnings.append(GuardrailViolation(
                severity="warning",
                rule_id="metric_target_missed",
                message=(
                    f"Metric '{metric_id}' value {value:.4f} does not meet "
                    f"target '{target_str}'."
                ),
            ))

        return GuardrailResult(
            passed=True,
            warnings=warnings,
        )

    def list_active_rules(self) -> list[str]:
        """Return human-readable list of all active guardrail rules."""
        rules: list[str] = []
        for c in self._constraints:
            desc = c.get("description", c.get("id", "unknown rule"))
            enforcement = c.get("enforcement", "plan")
            rules.append(f"{desc} (enforcement: {enforcement})")
        return rules

    def list_available_actions(self) -> list[dict[str, Any]]:
        """Return all approved actions with their metadata."""
        return [
            {
                "id": a.get("id"),
                "operation": a.get("operation"),
                "target_entity": a.get("targetEntityId"),
                "capability_state": a.get("capabilityState"),
                "execution_mode": a.get("execution", {}).get("mode"),
                "approval_required": bool(a.get("execution", {}).get("requiresHumanApproval")),
                "dry_run_required": bool(a.get("execution", {}).get("requiresDryRun")),
            }
            for a in self._actions
        ]

    @property
    def constraint_count(self) -> int:
        return len(self._constraints)

    @property
    def action_count(self) -> int:
        return len(self._actions)
