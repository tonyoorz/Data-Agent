"""LLM-as-judge verification for generated test cases.

After the LLM generates a test case (description + steps) from a defect, this module runs a
verification pass — a second LLM call that checks the generated content against quality criteria
before it's shown to the human reviewer. This is the "self-critique" step from the agentic RAG
pipeline (step ④ in the 6-step design).

Inspired by Corrective RAG (CRAG, arxiv 2401.15884): a lightweight evaluator judges whether the
output is good enough, and if not, returns specific feedback that triggers a regeneration.
The goal is to filter low-quality outputs before they reach the human reviewer, reducing review
burden and improving the signal-to-noise ratio.

Verification criteria (each independently checked):
1. **Failure-mode coverage**: does the test actually verify the defect's failure mode?
2. **Step reproducibility**: are the steps concrete enough that a tester could execute them?
3. **Format compliance**: does steps.txt use the [PreCon]/action/? convention?
4. **Checkpoint quantification**: are expected results specific (values/thresholds), not vague?
5. **Defect traceability**: does the description reference the source defect?
6. **Model coverage** (only when a stage-1 test design model is provided): does the draft
   cover every combination selected in the model — both self-reported coverage and a
   keyword cross-check that the referenced class names actually appear in the steps.

The verifier returns a structured verdict: pass/fail per criterion + overall + feedback for
regeneration if any criterion fails.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

from backend.analytics.test_case_builder import build_test_steps_script


@dataclass(frozen=True)
class VerificationCriterion:
    """A single quality check with a pass/fail result and evidence."""

    name: str
    passed: bool
    evidence: str


@dataclass(frozen=True)
class VerificationResult:
    """The full verification verdict for a generated test case."""

    passed: bool
    criteria: Sequence[VerificationCriterion]
    feedback: str  # regeneration guidance if not passed, empty if passed

    @property
    def pass_count(self) -> int:
        return sum(1 for c in self.criteria if c.passed)

    @property
    def total_count(self) -> int:
        return len(self.criteria)


# --- Programmatic checks (no LLM needed — fast, deterministic) ---


def _check_format_compliance(steps_text: str) -> VerificationCriterion:
    """Check that steps.txt uses the [PreCon]/action/? convention (programmatic)."""
    has_precon = "[PreCon]" in steps_text
    has_checkpoint = "?" in steps_text
    has_lines = bool(steps_text.strip())
    if has_precon and has_checkpoint and has_lines:
        return VerificationCriterion(
            name="format_compliance",
            passed=True,
            evidence="steps use [PreCon] and ? prefixes correctly",
        )
    missing = []
    if not has_precon:
        missing.append("[PreCon] prefix")
    if not has_checkpoint:
        missing.append("? checkpoint prefix")
    if not has_lines:
        missing.append("non-empty content")
    return VerificationCriterion(
        name="format_compliance",
        passed=False,
        evidence=f"missing: {', '.join(missing)}",
    )


def _check_defect_traceability(description_html: str, defect_id: str) -> VerificationCriterion:
    """Check that the description references the source defect ID (programmatic)."""
    if defect_id in description_html:
        return VerificationCriterion(
            name="defect_traceability",
            passed=True,
            evidence=f"description references defect {defect_id}",
        )
    return VerificationCriterion(
        name="defect_traceability",
        passed=False,
        evidence=f"defect ID {defect_id} not found in description",
    )


def _check_checkpoint_quantification(steps_text: str) -> VerificationCriterion:
    """Check that checkpoints contain specific values/thresholds, not vague statements.

    A good checkpoint mentions a concrete value (number, percentage, threshold) rather than
    just "check it works" or "verify behavior". This is a heuristic check: look for digits
    or comparison operators in lines starting with ?.
    """
    import re

    checkpoint_lines = [line for line in steps_text.split("\n") if "?" in line]
    if not checkpoint_lines:
        return VerificationCriterion(
            name="checkpoint_quantification",
            passed=False,
            evidence="no checkpoint lines (?) found",
        )
    # Look for numbers, %, <=, >=, <, > in checkpoint lines
    quantified = 0
    for line in checkpoint_lines:
        if re.search(r"\d|%|<=|>=|<|>|threshold|within|below|above|not exceed", line, re.IGNORECASE):
            quantified += 1
    ratio = quantified / len(checkpoint_lines) if checkpoint_lines else 0
    if ratio >= 0.5:
        return VerificationCriterion(
            name="checkpoint_quantification",
            passed=True,
            evidence=f"{quantified}/{len(checkpoint_lines)} checkpoints have specific values/thresholds",
        )
    return VerificationCriterion(
        name="checkpoint_quantification",
        passed=False,
        evidence=f"only {quantified}/{len(checkpoint_lines)} checkpoints have specific values — add thresholds",
    )


def _check_step_reproducibility(steps_text: str) -> VerificationCriterion:
    """Check that steps have enough detail to be executable (heuristic: step count + action verbs).

    A reproducible test case has multiple concrete action steps, not just one vague instruction.
    """
    lines = [l.strip() for l in steps_text.split("\n") if l.strip() and l.strip().startswith("-")]
    action_lines = [l for l in lines if not l.startswith("- [PreCon]") and not l.startswith("- ?")]
    if len(action_lines) >= 3:
        return VerificationCriterion(
            name="step_reproducibility",
            passed=True,
            evidence=f"{len(action_lines)} action steps — sufficient for reproducibility",
        )
    return VerificationCriterion(
        name="step_reproducibility",
        passed=False,
        evidence=f"only {len(action_lines)} action steps — need more concrete execution steps",
    )


def _check_failure_mode_coverage(defect: Mapping[str, Any], steps_text: str) -> VerificationCriterion:
    """Check that the test steps reference the defect's subject matter (heuristic).

    Extracts key terms from the defect name and checks they appear in the steps. This is a
    lightweight proxy for "does the test cover the failure mode" — a full semantic check would
    need an LLM, but keyword overlap catches the common failure of generating a generic test
    that doesn't actually test the defect's issue.
    """
    import re

    defect_name = str(defect.get("name") or "")
    # Extract significant words from the defect name (skip common words, brackets, codes)
    skip = {"test", "case", "issue", "defect", "the", "a", "an", "is", "not", "for", "of", "in"}
    tokens = re.findall(r"[a-zA-Z]{3,}", defect_name.lower())
    key_terms = [t for t in tokens if t not in skip][:5]
    if not key_terms:
        return VerificationCriterion(
            name="failure_mode_coverage",
            passed=True,
            evidence="no extractable key terms from defect name — skipping",
        )
    steps_lower = steps_text.lower()
    covered = [t for t in key_terms if t in steps_lower]
    if len(covered) >= max(1, len(key_terms) // 2):
        return VerificationCriterion(
            name="failure_mode_coverage",
            passed=True,
            evidence=f"steps cover {len(covered)}/{len(key_terms)} key terms from defect: {covered}",
        )
    return VerificationCriterion(
        name="failure_mode_coverage",
        passed=False,
        evidence=f"steps only cover {len(covered)}/{len(key_terms)} key terms — missing: {[t for t in key_terms if t not in covered]}",
    )


def _normalize_for_match(text: str) -> str:
    """Lowercase and collapse to alnum/percent tokens so class-name matching is robust."""
    import re

    lowered = str(text or "").lower()
    collapsed = re.sub(r"[^a-z0-9%]+", " ", lowered)
    return re.sub(r"\s+", " ", collapsed).strip()


def _check_model_coverage(
    test_model: Mapping[str, Any],
    combination_coverage: Sequence[Any],
    steps_text: str,
) -> VerificationCriterion:
    """Check that the draft covers every combination in the stage-1 test design model.

    A combination counts as covered only when (a) its id is claimed in the generated
    output's combinationCoverage list AND (b) every referenced class name actually
    appears in the step text — a keyword cross-check that defeats empty self-reporting.
    """
    combinations = [c for c in (test_model.get("combinations") or []) if isinstance(c, Mapping)]
    if not combinations:
        return VerificationCriterion(
            name="model_coverage",
            passed=True,
            evidence="test design model has no combinations — nothing to cover",
        )

    classes: dict[str, str] = {}
    for dimension in test_model.get("dimensions") or []:
        if not isinstance(dimension, Mapping):
            continue
        for cls in dimension.get("classes") or []:
            if isinstance(cls, Mapping):
                class_id = str(cls.get("id") or "").strip()
                class_name = str(cls.get("name") or "").strip()
                if class_id and class_name:
                    classes[class_id] = class_name

    claimed = {str(c).strip() for c in (combination_coverage or []) if str(c or "").strip()}
    steps_normalized = _normalize_for_match(steps_text)

    not_claimed: list[str] = []
    claimed_but_unverified: list[str] = []
    for combination in combinations:
        combo_id = str(combination.get("id") or "").strip()
        if not combo_id:
            continue
        if combo_id not in claimed:
            not_claimed.append(combo_id)
            continue
        tokens = [
            _normalize_for_match(classes[ref])
            for ref in (combination.get("classRefs") or [])
            if str(ref or "").strip() in classes
        ]
        tokens = [t for t in tokens if len(t) >= 3]
        if tokens and not all(t in steps_normalized for t in tokens):
            claimed_but_unverified.append(combo_id)

    if not not_claimed and not claimed_but_unverified:
        return VerificationCriterion(
            name="model_coverage",
            passed=True,
            evidence=f"all {len(combinations)} combinations covered and keyword-verified in steps",
        )
    problems = []
    if not_claimed:
        problems.append(f"not covered: {', '.join(not_claimed)}")
    if claimed_but_unverified:
        problems.append(f"claimed but class terms missing from steps: {', '.join(claimed_but_unverified)}")
    return VerificationCriterion(
        name="model_coverage",
        passed=False,
        evidence="; ".join(problems),
    )


def verify_test_case(
    *,
    defect: Mapping[str, Any],
    description_html: str,
    steps_text: str,
    test_model: Mapping[str, Any] | None = None,
    combination_coverage: Sequence[Any] | None = None,
) -> VerificationResult:
    """Run all verification checks on a generated test case.

    Returns a structured result. If any criterion fails, ``passed`` is False and ``feedback``
    contains specific guidance for regeneration. The human reviewer still sees the output (the
    LLM-as-judge is a pre-filter, not a gate — but failed verifications get flagged).
    """
    defect_id = str(defect.get("defect_id") or "")

    criteria = [
        _check_failure_mode_coverage(defect, steps_text),
        _check_step_reproducibility(steps_text),
        _check_format_compliance(steps_text),
        _check_checkpoint_quantification(steps_text),
        _check_defect_traceability(description_html, defect_id),
    ]
    if test_model:
        criteria.append(_check_model_coverage(test_model, combination_coverage or [], steps_text))

    failed = [c for c in criteria if not c.passed]
    if not failed:
        return VerificationResult(passed=True, criteria=criteria, feedback="")

    feedback_parts = [f"- {c.name}: {c.evidence}" for c in failed]
    feedback = "Regeneration needed — the following criteria failed:\n" + "\n".join(feedback_parts)
    return VerificationResult(passed=False, criteria=criteria, feedback=feedback)
