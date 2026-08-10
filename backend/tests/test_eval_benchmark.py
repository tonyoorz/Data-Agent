"""Tests for backend.analytics.eval_benchmark — NL2SQL evaluation benchmark."""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from backend.analytics.eval_benchmark import (
    DEFAULT_GOLDEN_PATH,
    VALID_DIFFICULTIES,
    VALID_INTENTS,
    EvalReport,
    EvalResult,
    EvalRunner,
    GoldenCase,
    NLClassifier,
    GoldenTestSuite,
    _check_filters_summary,
    main as cli_main,
)
from backend.analytics.ontology import load_ontology
from backend.analytics.semantic_query import SemanticQueryError

REPO_ROOT = Path(__file__).resolve().parents[2]


# ─── Fixtures ──────────────────────────────────────────────────


@pytest.fixture(scope="module")
def catalog():
    return load_ontology(root=REPO_ROOT)


@pytest.fixture(scope="module")
def golden_suite() -> GoldenTestSuite:
    return GoldenTestSuite.load_from_json(DEFAULT_GOLDEN_PATH)


def _make_case(
    case_id: str = "test-001",
    *,
    natural_question: str = "多少缺陷？",
    entity_ids: list[str] | None = None,
    metric_ids: list[str] | None = None,
    dimension_ids: list[str] | None = None,
    intent: str = "aggregate",
    tags: list[str] | None = None,
    difficulty: str = "easy",
    expected_data_count: int | None = None,
    expected_filters_summary: dict[str, Any] | None = None,
    ontology_query: dict[str, Any] | None = None,
) -> GoldenCase:
    if entity_ids is None:
        entity_ids = ["quality.defect"]
    if metric_ids is None:
        metric_ids = ["defect.count"]
    if dimension_ids is None:
        dimension_ids = []
    if ontology_query is None:
        ontology_query = {
            "schemaVersion": "1.0",
            "queryId": f"q-{case_id}",
            "ontologyVersion": "v1",
            "schemaFingerprint": "fake-fingerprint",
            "query": {
                "schemaVersion": "1.0",
                "ontologyVersion": "v1",
                "schemaFingerprint": "fake-fingerprint",
                "intent": intent,
                "entityIds": entity_ids,
                "metricIds": metric_ids,
                "dimensionIds": dimension_ids,
                "filters": [
                    {
                        "dimensionId": "org.problem_finder_team",
                        "operator": "in",
                        "values": ["DTSV_China"],
                        "source": "policy",
                    }
                ],
                "timeScopes": [],
                "comparison": None,
                "sort": [],
                "limit": 20,
            },
            "actorScope": {
                "actorId": "test-bot",
                "scopeHash": "test-scope",
                "workspaceIds": ["DTSV"],
                "projectIds": [],
                "teamIds": ["DTSV"],
                "allowedObjectTypes": ["quality.defect"],
                "allowedPropertyIds": [],
                "rowPolicyIds": ["dtsv"],
                "sensitiveFieldPolicyIds": [],
            },
        }
    return GoldenCase(
        id=case_id,
        natural_question=natural_question,
        ontology_query=ontology_query,
        expected_entity_ids=entity_ids,
        expected_metric_ids=metric_ids,
        expected_dimension_ids=dimension_ids,
        tags=tags or ["test"],
        difficulty=difficulty,
        expected_data_count=expected_data_count,
        expected_filters_summary=expected_filters_summary,
    )


def _mock_executor_returning(data: list[dict[str, Any]]) -> Any:
    """Create a mock query executor that returns the given data list."""
    def _executor(payload, *, catalog=None, **kwargs):
        return {"data": data, "summary": {"rowCount": len(data)}, "quality": {}}
    return _executor


def _mock_executor_raising(error: Exception) -> Any:
    """Create a mock query executor that raises the given error."""
    def _executor(payload, *, catalog=None, **kwargs):
        raise error
    return _executor


# ═══════════════════════════════════════════════════════════════
# 1. GoldenCase dataclass tests
# ═══════════════════════════════════════════════════════════════


class TestGoldenCase:
    def test_from_dict_round_trip(self) -> None:
        case = _make_case()
        d = case.to_dict()
        restored = GoldenCase.from_dict(d)
        assert restored.id == case.id
        assert restored.natural_question == case.natural_question
        assert restored.expected_entity_ids == case.expected_entity_ids
        assert restored.expected_metric_ids == case.expected_metric_ids

    def test_from_dict_with_defaults(self) -> None:
        minimal = {
            "id": "x-1",
            "natural_question": "?",
            "ontology_query": {},
            "expected_entity_ids": [],
            "expected_metric_ids": [],
            "expected_dimension_ids": [],
        }
        case = GoldenCase.from_dict(minimal)
        assert case.tags == []
        assert case.difficulty == "easy"
        assert case.expected_data_count is None
        assert case.expected_filters_summary is None

    def test_optional_fields_preserved(self) -> None:
        case = _make_case(
            expected_data_count=42,
            expected_filters_summary={"quality.status": ["Open"]},
        )
        d = case.to_dict()
        assert d["expected_data_count"] == 42
        assert d["expected_filters_summary"] == {"quality.status": ["Open"]}


# ═══════════════════════════════════════════════════════════════
# 2. GoldenTestSuite — load / save / filter
# ═══════════════════════════════════════════════════════════════


class TestGoldenTestSuite:
    def test_load_golden_cases(self, golden_suite: GoldenTestSuite) -> None:
        assert len(golden_suite) == 20
        ids = {c.id for c in golden_suite}
        assert len(ids) == 20

    def test_save_and_reload_round_trip(self, tmp_path: Path) -> None:
        case_a = _make_case("a-1")
        case_b = _make_case("a-2", natural_question="How many tests?", entity_ids=["testing.test_run"], metric_ids=["testing.run_count"])
        suite = GoldenTestSuite([case_a, case_b])
        path = tmp_path / "cases.json"
        suite.save_to_json(path)
        loaded = GoldenTestSuite.load_from_json(path)
        assert len(loaded) == 2
        assert {c.id for c in loaded} == {"a-1", "a-2"}

    def test_add_case(self) -> None:
        suite = GoldenTestSuite()
        suite.add_case(_make_case("x-1"))
        suite.add_case(_make_case("x-2"))
        assert len(suite) == 2

    def test_add_duplicate_case_raises(self) -> None:
        suite = GoldenTestSuite([_make_case("dup-1")])
        with pytest.raises(ValueError, match="Duplicate case id"):
            suite.add_case(_make_case("dup-1"))

    def test_filter_by_tags(self, golden_suite: GoldenTestSuite) -> None:
        filtered = golden_suite.filter(tags=["defect"])
        assert len(filtered) > 0
        for case in filtered:
            assert "defect" in case.tags

    def test_filter_by_difficulty(self, golden_suite: GoldenTestSuite) -> None:
        filtered = golden_suite.filter(difficulty="hard")
        assert len(filtered) > 0
        for case in filtered:
            assert case.difficulty == "hard"

    def test_filter_by_difficulty_list(self, golden_suite: GoldenTestSuite) -> None:
        filtered = golden_suite.filter(difficulty=["easy", "medium"])
        for case in filtered:
            assert case.difficulty in {"easy", "medium"}

    def test_filter_combined_tags_and_difficulty(self, golden_suite: GoldenTestSuite) -> None:
        filtered = golden_suite.filter(tags=["testing"], difficulty="medium")
        for case in filtered:
            assert "testing" in case.tags
            assert case.difficulty == "medium"

    def test_filter_no_match(self, golden_suite: GoldenTestSuite) -> None:
        filtered = golden_suite.filter(tags=["nonexistent-tag"])
        assert len(filtered) == 0

    def test_iteration(self) -> None:
        suite = GoldenTestSuite([_make_case("i-1"), _make_case("i-2")])
        ids = [c.id for c in suite]
        assert ids == ["i-1", "i-2"]

    def test_empty_suite_len(self) -> None:
        assert len(GoldenTestSuite()) == 0


# ═══════════════════════════════════════════════════════════════
# 3. EvalResult — scoring logic
# ═══════════════════════════════════════════════════════════════


class TestEvalResult:
    def test_to_dict_round_trip(self) -> None:
        r = EvalResult(
            case_id="r-1",
            status="pass",
            entity_match=True,
            metric_match=True,
            dimension_match=True,
            data_count_match=True,
            expected_count=10,
            actual_count=10,
            error_message=None,
            execution_time_ms=5.2,
        )
        d = r.to_dict()
        assert d["case_id"] == "r-1"
        assert d["status"] == "pass"
        assert d["actual_count"] == 10


# ═══════════════════════════════════════════════════════════════
# 4. EvalRunner — single case execution
# ═══════════════════════════════════════════════════════════════


class TestEvalRunner:
    def test_run_case_pass(self) -> None:
        """All entity/metric/dimension match and no expected_data_count → pass."""
        case = _make_case()
        runner = EvalRunner(query_executor=_mock_executor_returning([{"a": 1}]))
        result = runner.run_case(case)
        assert result.status == "pass"
        assert result.entity_match is True
        assert result.metric_match is True
        assert result.dimension_match is True
        assert result.error_message is None
        assert result.actual_count == 1
        assert result.execution_time_ms >= 0

    def test_run_case_fail_on_semantic_error(self) -> None:
        """SemanticQueryError → fail with error message."""
        case = _make_case()
        runner = EvalRunner(
            query_executor=_mock_executor_raising(SemanticQueryError("SEMANTIC_ERROR")),
        )
        result = runner.run_case(case)
        assert result.status == "fail"
        assert "SEMANTIC_ERROR" in (result.error_message or "")

    def test_run_case_fail_on_unexpected_error(self) -> None:
        """Unexpected exception → fail with UNEXPECTED_ERROR prefix."""
        case = _make_case()
        runner = EvalRunner(
            query_executor=_mock_executor_raising(RuntimeError("boom")),
        )
        result = runner.run_case(case)
        assert result.status == "fail"
        assert "UNEXPECTED_ERROR" in (result.error_message or "")

    def test_run_case_partial_on_entity_mismatch(self) -> None:
        """Entity mismatch but metric match → partial."""
        case = _make_case(
            entity_ids=["quality.defect"],
            metric_ids=["defect.count"],
        )
        # Build a query whose query.entityIds differ from expected
        modified_query = json.loads(json.dumps(case.ontology_query))
        modified_query["query"]["entityIds"] = ["testing.test_run"]
        case.ontology_query = modified_query
        case.expected_entity_ids = ["testing.test_run"]  # metric still matches
        # Actually we want entity mismatch but metric match
        # Let's make expected have different entity but same metric
        case.expected_entity_ids = ["quality.defect"]  # actual query has testing.test_run
        # metric_ids match (both defect.count in query), but that metric belongs to defect not test_run
        # For partial: entity_match=False, metric_match=True
        runner = EvalRunner(query_executor=_mock_executor_returning([]))
        result = runner.run_case(case)
        assert result.entity_match is False
        # metric should still "match" since both expected and query have defect.count
        assert result.metric_match is True
        assert result.status == "partial"

    def test_run_case_data_count_match_within_tolerance(self) -> None:
        """expected_data_count=100, actual=105 → within 10% tolerance → pass."""
        case = _make_case(expected_data_count=100)
        data = [{"x": i} for i in range(105)]
        runner = EvalRunner(query_executor=_mock_executor_returning(data))
        result = runner.run_case(case)
        assert result.data_count_match is True
        assert result.status == "pass"

    def test_run_case_data_count_mismatch_beyond_tolerance(self) -> None:
        """expected_data_count=100, actual=200 → beyond 10% tolerance."""
        case = _make_case(expected_data_count=100)
        data = [{"x": i} for i in range(200)]
        runner = EvalRunner(query_executor=_mock_executor_returning(data))
        result = runner.run_case(case)
        assert result.data_count_match is False
        # Since entity/metric/dim all match but count doesn't → still pass (not in status determination alone)
        # Actually status = pass requires data_count_match too
        assert result.status == "partial"  # entity/metric match but count doesn't

    def test_run_case_data_count_zero_expected(self) -> None:
        """expected_data_count=0, actual=0 → match."""
        case = _make_case(expected_data_count=0)
        runner = EvalRunner(query_executor=_mock_executor_returning([]))
        result = runner.run_case(case)
        assert result.data_count_match is True

    def test_run_case_filters_summary_match(self) -> None:
        """expected_filters_summary with matching filter → no error."""
        case = _make_case(
            expected_filters_summary={"org.problem_finder_team": ["DTSV_China"]},
        )
        runner = EvalRunner(query_executor=_mock_executor_returning([{"a": 1}]))
        result = runner.run_case(case)
        assert result.error_message is None
        assert result.status == "pass"

    def test_run_case_filters_summary_mismatch(self) -> None:
        """expected_filters_summary with non-matching filter → FILTERS_SUMMARY_MISMATCH."""
        case = _make_case(
            expected_filters_summary={"quality.status": ["Open"]},
        )
        runner = EvalRunner(query_executor=_mock_executor_returning([{"a": 1}]))
        result = runner.run_case(case)
        assert result.error_message is not None
        assert "FILTERS_SUMMARY_MISMATCH" in result.error_message
        assert result.status == "fail"

    def test_run_suite(self) -> None:
        """Run a full suite and check the report."""
        suite = GoldenTestSuite([_make_case("s-1"), _make_case("s-2")])
        runner = EvalRunner(query_executor=_mock_executor_returning([{"a": 1}]))
        report = runner.run_suite(suite)
        assert report.summary["total"] == 2
        assert report.summary["passed"] == 2
        assert report.summary["pass_rate"] == 1.0

    def test_run_suite_with_tag_filter(self) -> None:
        """Run suite with tag filter — only matching cases run."""
        suite = GoldenTestSuite([
            _make_case("t-1", tags=["group_a"]),
            _make_case("t-2", tags=["group_b"]),
        ])
        runner = EvalRunner(query_executor=_mock_executor_returning([]))
        report = runner.run_suite(suite, tags=["group_a"])
        assert report.summary["total"] == 1


# ═══════════════════════════════════════════════════════════════
# 5. EvalReport — summary, save, compare
# ═══════════════════════════════════════════════════════════════


class TestEvalReport:
    def test_summary_computation(self) -> None:
        results = [
            EvalResult("c1", "pass", True, True, True, True, None, 5, None, 1.0),
            EvalResult("c2", "fail", False, False, False, True, None, 0, "err", 2.0),
            EvalResult("c3", "partial", True, False, True, True, None, 3, None, 3.0),
        ]
        report = EvalReport(results=results)
        assert report.summary["total"] == 3
        assert report.summary["passed"] == 1
        assert report.summary["failed"] == 1
        assert report.summary["partial"] == 1
        assert report.summary["pass_rate"] == round(1 / 3, 4)
        assert "c2" in report.failed_cases
        assert "c3" in report.failed_cases
        assert "c1" not in report.failed_cases

    def test_empty_report(self) -> None:
        report = EvalReport(results=[])
        assert report.summary["total"] == 0
        assert report.summary["pass_rate"] == 0.0
        assert report.failed_cases == []

    def test_save_and_load_report(self, tmp_path: Path) -> None:
        results = [
            EvalResult("c1", "pass", True, True, True, True, 10, 10, None, 5.0),
        ]
        report = EvalReport(results=results)
        path = tmp_path / "report.json"
        report.save_report(path)
        loaded = EvalReport.load(path)
        assert loaded.summary["total"] == 1
        assert loaded.results[0].case_id == "c1"

    def test_to_dict_json_serializable(self) -> None:
        results = [EvalResult("c1", "pass", True, True, True, True, 1, 1, None, 1.0)]
        report = EvalReport(results=results)
        d = report.to_dict()
        # Verify it's JSON serializable
        json.dumps(d)

    def test_compare_with_no_regressions(self) -> None:
        """All same results → no regressions."""
        results = [EvalResult("c1", "pass", True, True, True, True, 1, 1, None, 1.0)]
        current = EvalReport(results=results)
        previous = EvalReport(results=[EvalResult("c1", "pass", True, True, True, True, 1, 1, None, 1.0)])
        diff = current.compare_with(previous)
        assert diff["regressions"] == []
        assert diff["improvements"] == []
        assert diff["pass_rate_delta"] == 0.0

    def test_compare_with_regression(self) -> None:
        """c1 passed before, now fails → regression."""
        current = EvalReport(results=[EvalResult("c1", "fail", False, True, True, True, 1, 0, "err", 1.0)])
        previous = EvalReport(results=[EvalResult("c1", "pass", True, True, True, True, 1, 1, None, 1.0)])
        diff = current.compare_with(previous)
        assert "c1" in diff["regressions"]
        assert diff["pass_rate_delta"] < 0

    def test_compare_with_improvement(self) -> None:
        """c1 failed before, now passes → improvement."""
        current = EvalReport(results=[EvalResult("c1", "pass", True, True, True, True, 1, 1, None, 1.0)])
        previous = EvalReport(results=[EvalResult("c1", "fail", False, True, True, True, 1, 0, "err", 1.0)])
        diff = current.compare_with(previous)
        assert "c1" in diff["improvements"]
        assert diff["pass_rate_delta"] > 0

    def test_compare_with_dict(self) -> None:
        """Compare with a raw dict report."""
        current = EvalReport(results=[EvalResult("c1", "pass", True, True, True, True, 1, 1, None, 1.0)])
        prev_dict = {
            "results": [{"case_id": "c1", "status": "fail"}],
            "summary": {"pass_rate": 0.0},
        }
        diff = current.compare_with(prev_dict)
        assert "c1" in diff["improvements"]


# ═══════════════════════════════════════════════════════════════
# 6. NLClassifier — intent classification
# ═══════════════════════════════════════════════════════════════


class TestNLClassifier:
    @pytest.fixture(scope="class")
    def classifier(self) -> NLClassifier:
        return NLClassifier()

    @pytest.mark.parametrize(
        "question, expected",
        [
            ("缺陷趋势变化", "trend"),
            ("Trend over time for defects", "trend"),
            ("对比不同项目的缺陷", "compare"),
            ("Compare passed vs failed", "compare"),
            ("排名前10的ECU", "rank"),
            ("Top 5 teams by count", "rank"),
            ("列出所有缺陷", "list"),
            ("Show me all failed tests", "list"),
            ("按ECU细分下钻", "drilldown"),
            ("Breakdown by team", "drilldown"),
            ("追溯测试链路", "trace"),
            ("Traceability analysis", "trace"),
            ("当前有多少个缺陷", "aggregate"),
            ("How many defects in total", "aggregate"),
            ("defect count statistics", "aggregate"),
        ],
    )
    def test_classify_intent_accuracy(
        self, classifier: NLClassifier, question: str, expected: str
    ) -> None:
        predicted = classifier.classify_intent(question)
        assert predicted == expected, f"Expected {expected} for '{question}', got {predicted}"

    def test_classify_default_fallback(self) -> None:
        """No keyword match → aggregate."""
        clf = NLClassifier(resolver=MagicMock())
        assert clf.classify_intent("xyz random gibberish") == "aggregate"

    def test_extract_entities_returns_list(self) -> None:
        """extract_entities returns a list (may be empty if resolver is None)."""
        clf = NLClassifier(resolver=MagicMock())
        # With a mock resolver that has resolve return empty
        clf._resolver = MagicMock()
        clf._resolver.resolve.return_value = []
        result = clf.extract_entities("some question")
        assert isinstance(result, list)

    def test_extract_entities_from_resolver(self) -> None:
        """extract_entities pulls entityId from resolver matches."""
        mock_resolver = MagicMock()
        mock_match = MagicMock()
        mock_match.resolution = {"entityId": "quality.defect"}
        mock_resolver.resolve.return_value = [mock_match]
        clf = NLClassifier(resolver=mock_resolver)
        entities = clf.extract_entities("缺陷数量")
        assert "quality.defect" in entities

    def test_extract_metrics_from_resolver(self) -> None:
        """extract_metrics pulls metricId from resolver matches."""
        mock_resolver = MagicMock()
        mock_match = MagicMock()
        mock_match.resolution = {"metricId": "defect.count"}
        mock_resolver.resolve.return_value = [mock_match]
        clf = NLClassifier(resolver=mock_resolver)
        metrics = clf.extract_metrics("缺陷数量")
        assert "defect.count" in metrics

    def test_extract_dimensions_from_resolver(self) -> None:
        """extract_dimensions pulls dimensionId from resolver matches."""
        mock_resolver = MagicMock()
        mock_match = MagicMock()
        mock_match.resolution = {"dimensionId": "product.ecu"}
        mock_resolver.resolve.return_value = [mock_match]
        clf = NLClassifier(resolver=mock_resolver)
        dims = clf.extract_dimensions("按ECU")
        assert "product.ecu" in dims

    def test_extract_entities_dedup(self) -> None:
        """Duplicate entity IDs are deduplicated."""
        mock_resolver = MagicMock()
        m1 = MagicMock()
        m1.resolution = {"entityId": "quality.defect"}
        m2 = MagicMock()
        m2.resolution = {"entityId": "quality.defect"}
        m3 = MagicMock()
        m3.resolution = {"entityId": "testing.test_run"}
        mock_resolver.resolve.return_value = [m1, m2, m3]
        clf = NLClassifier(resolver=mock_resolver)
        entities = clf.extract_entities("defects and tests")
        assert entities == ["quality.defect", "testing.test_run"]


# ═══════════════════════════════════════════════════════════════
# 7. _check_filters_summary helper
# ═══════════════════════════════════════════════════════════════


class TestCheckFiltersSummary:
    def test_matching_filter(self) -> None:
        filters = [{"dimensionId": "quality.status", "values": ["Open", "Closed"]}]
        expected = {"quality.status": ["Open"]}
        assert _check_filters_summary(filters, expected) is True

    def test_non_matching_filter(self) -> None:
        filters = [{"dimensionId": "quality.severity", "values": ["Critical"]}]
        expected = {"quality.status": ["Open"]}
        assert _check_filters_summary(filters, expected) is False

    def test_single_value_expected(self) -> None:
        """expected_filters_summary with scalar value (not list)."""
        filters = [{"dimensionId": "quality.status", "values": ["Open"]}]
        expected = {"quality.status": "Open"}
        assert _check_filters_summary(filters, expected) is True

    def test_empty_expected(self) -> None:
        assert _check_filters_summary([], {}) is True


# ═══════════════════════════════════════════════════════════════
# 8. Golden cases format validation
# ═══════════════════════════════════════════════════════════════


class TestGoldenCasesValidation:
    def test_golden_file_exists(self) -> None:
        assert DEFAULT_GOLDEN_PATH.is_file()

    def test_golden_case_count(self, golden_suite: GoldenTestSuite) -> None:
        assert len(golden_suite) == 20

    def test_all_cases_have_required_fields(self, golden_suite: GoldenTestSuite) -> None:
        required = {
            "id", "natural_question", "ontology_query",
            "expected_entity_ids", "expected_metric_ids", "expected_dimension_ids",
            "tags", "difficulty",
        }
        for case in golden_suite:
            case_dict = case.to_dict()
            missing = required - set(case_dict.keys())
            assert not missing, f"Case {case.id} missing fields: {missing}"

    def test_intent_distribution(self, golden_suite: GoldenTestSuite) -> None:
        from collections import Counter
        intents = Counter(c.ontology_query["query"]["intent"] for c in golden_suite)
        assert intents["aggregate"] == 3
        assert intents["trend"] == 3
        assert intents["compare"] == 3
        assert intents["rank"] == 3
        assert intents["list"] == 3
        assert intents["drilldown"] == 2
        assert intents["trace"] == 3

    def test_difficulty_distribution(self, golden_suite: GoldenTestSuite) -> None:
        from collections import Counter
        diffs = Counter(c.difficulty for c in golden_suite)
        assert diffs["easy"] == 7
        assert diffs["medium"] == 8
        assert diffs["hard"] == 5

    def test_all_intents_valid(self, golden_suite: GoldenTestSuite) -> None:
        for case in golden_suite:
            intent = case.ontology_query["query"]["intent"]
            assert intent in VALID_INTENTS, f"Case {case.id} has invalid intent: {intent}"

    def test_all_difficulties_valid(self, golden_suite: GoldenTestSuite) -> None:
        for case in golden_suite:
            assert case.difficulty in VALID_DIFFICULTIES, f"Case {case.id}: bad difficulty {case.difficulty}"

    def test_unique_case_ids(self, golden_suite: GoldenTestSuite) -> None:
        ids = [c.id for c in golden_suite]
        assert len(ids) == len(set(ids))

    def test_queries_have_valid_structure(self, golden_suite: GoldenTestSuite) -> None:
        """Each ontology_query must have the required top-level keys."""
        required_top = {"schemaVersion", "queryId", "ontologyVersion", "schemaFingerprint", "query", "actorScope"}
        required_query = {"schemaVersion", "ontologyVersion", "schemaFingerprint", "intent", "entityIds", "metricIds", "dimensionIds", "filters", "timeScopes", "comparison", "sort", "limit"}
        for case in golden_suite:
            top_keys = set(case.ontology_query.keys())
            assert required_top <= top_keys, f"Case {case.id}: missing top keys {required_top - top_keys}"
            query_keys = set(case.ontology_query["query"].keys())
            assert required_query <= query_keys, f"Case {case.id}: missing query keys {required_query - query_keys}"

    def test_has_chinese_and_english_questions(self, golden_suite: GoldenTestSuite) -> None:
        """At least one Chinese and one English question."""
        has_chinese = any(any('\u4e00' <= ch <= '\u9fff' for ch in c.natural_question) for c in golden_suite)
        has_english = any(all(ord(ch) < 128 or ch.isspace() for ch in c.natural_question.replace('？', '?').replace('（', '(').replace('）', ')')) for c in golden_suite)
        assert has_chinese, "No Chinese questions found"
        assert has_english, "No English-only questions found"


# ═══════════════════════════════════════════════════════════════
# 9. CLI smoke tests
# ═══════════════════════════════════════════════════════════════


class TestCLI:
    def test_cli_no_args_prints_help(self, capsys: pytest.CaptureFixture) -> None:
        rc = cli_main([])
        assert rc == 1
        captured = capsys.readouterr()
        assert "usage:" in captured.out.lower() or "usage:" in captured.err.lower()

    def test_cli_list(self, capsys: pytest.CaptureFixture) -> None:
        rc = cli_main(["list", "--suite", "default"])
        assert rc == 0
        captured = capsys.readouterr()
        assert "Total:" in captured.out

    def test_cli_list_with_difficulty(self, capsys: pytest.CaptureFixture) -> None:
        rc = cli_main(["list", "--suite", "default", "--difficulty", "hard"])
        assert rc == 0
        captured = capsys.readouterr()
        assert "Total:" in captured.out

    def test_cli_run_default_suite_missing_file(self, tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
        """Run with a non-existent suite file → returns 1."""
        rc = cli_main(["run", "--suite", str(tmp_path / "nonexistent.json")])
        assert rc == 1

    def test_cli_compare_missing_files(self, capsys: pytest.CaptureFixture) -> None:
        rc = cli_main([
            "compare",
            "--report", "/tmp/does_not_exist_a.json",
            "--baseline", "/tmp/does_not_exist_b.json",
        ])
        assert rc == 1
