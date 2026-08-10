"""NL2SQL evaluation benchmark for the Data-Agent semantic query pipeline.

Provides golden test-case management, automated evaluation against
``execute_semantic_query``, intent classification, and regression reporting.

CLI usage::

    python -m backend.analytics.eval_benchmark run --suite default
    python -m backend.analytics.eval_benchmark run --tags "defect,basic"
    python -m backend.analytics.eval_benchmark compare --report latest.json --baseline baseline.json
    python -m backend.analytics.eval_benchmark add-case --question "..." --intent aggregate ...
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Sequence

from backend.analytics.ontology import OntologyCatalog, OntologyLoadError, load_ontology
from backend.analytics.ontology_term_resolver import OntologyTermResolver
from backend.analytics.semantic_query import SemanticQueryError, execute_semantic_query

# ─── Paths ─────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_GOLDEN_PATH = REPO_ROOT / "backend" / "tests" / "golden" / "eval_cases.json"

VALID_INTENTS = frozenset({"aggregate", "trend", "compare", "rank", "list", "drilldown", "trace"})
VALID_DIFFICULTIES = frozenset({"easy", "medium", "hard"})

# ─── Data classes ──────────────────────────────────────────────


@dataclass
class GoldenCase:
    """A single golden test case for NL2SQL evaluation."""

    id: str
    natural_question: str
    ontology_query: dict[str, Any]
    expected_entity_ids: list[str]
    expected_metric_ids: list[str]
    expected_dimension_ids: list[str]
    tags: list[str] = field(default_factory=list)
    difficulty: str = "easy"
    expected_data_count: int | None = None
    expected_filters_summary: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> GoldenCase:
        return cls(
            id=data["id"],
            natural_question=data["natural_question"],
            ontology_query=data["ontology_query"],
            expected_entity_ids=data["expected_entity_ids"],
            expected_metric_ids=data["expected_metric_ids"],
            expected_dimension_ids=data["expected_dimension_ids"],
            tags=data.get("tags", []),
            difficulty=data.get("difficulty", "easy"),
            expected_data_count=data.get("expected_data_count"),
            expected_filters_summary=data.get("expected_filters_summary"),
        )


@dataclass
class EvalResult:
    """Result of evaluating a single golden case."""

    case_id: str
    status: str  # "pass", "fail", "partial"
    entity_match: bool
    metric_match: bool
    dimension_match: bool
    data_count_match: bool
    expected_count: int | None
    actual_count: int | None
    error_message: str | None
    execution_time_ms: float

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class EvalReport:
    """Aggregate evaluation report over multiple cases."""

    results: list[EvalResult]
    summary: dict[str, Any] = field(default_factory=dict)
    failed_cases: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self._compute_summary()

    def _compute_summary(self) -> None:
        total = len(self.results)
        passed = sum(1 for r in self.results if r.status == "pass")
        failed = sum(1 for r in self.results if r.status == "fail")
        partial = sum(1 for r in self.results if r.status == "partial")
        self.summary = {
            "total": total,
            "passed": passed,
            "failed": failed,
            "partial": partial,
            "pass_rate": round(passed / total, 4) if total else 0.0,
            "avg_execution_ms": round(sum(r.execution_time_ms for r in self.results) / total, 2) if total else 0.0,
        }
        self.failed_cases = [r.case_id for r in self.results if r.status in {"fail", "partial"}]

    def to_dict(self) -> dict[str, Any]:
        self._compute_summary()
        return {
            "results": [r.to_dict() for r in self.results],
            "summary": self.summary,
            "failed_cases": self.failed_cases,
        }

    def save_report(self, path: str | Path) -> None:
        """Save this report as JSON to *path*."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")

    def compare_with(self, previous_report: EvalReport | dict[str, Any]) -> dict[str, Any]:
        """Compare with a previous report to detect regressions.

        Returns a dict with:

        - ``regressions`` — case IDs that passed before but now fail/partial.
        - ``improvements`` — case IDs that failed/partial before but now pass.
        - ``pass_rate_delta`` — current pass rate minus previous pass rate.
        - ``new_failures`` — same as regressions but excluding partial→fail.
        """
        if isinstance(previous_report, dict):
            prev_results = {r["case_id"]: r["status"] for r in previous_report.get("results", [])}
            prev_pass_rate = previous_report.get("summary", {}).get("pass_rate", 0.0)
        else:
            prev_results = {r.case_id: r.status for r in previous_report.results}
            prev_pass_rate = previous_report.summary.get("pass_rate", 0.0)

        current_results = {r.case_id: r.status for r in self.results}
        pass_statuses = {"pass"}
        fail_statuses = {"fail", "partial"}

        regressions = sorted(
            cid for cid, status in current_results.items()
            if prev_results.get(cid) in pass_statuses and status in fail_statuses
        )
        improvements = sorted(
            cid for cid, status in current_results.items()
            if prev_results.get(cid) in fail_statuses and status in pass_statuses
        )
        return {
            "regressions": regressions,
            "improvements": improvements,
            "pass_rate_delta": round(self.summary.get("pass_rate", 0.0) - prev_pass_rate, 4),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> EvalReport:
        results = [EvalResult(**r) for r in data.get("results", [])]
        report = cls.__new__(cls)
        report.results = results
        report.summary = data.get("summary", {})
        report.failed_cases = data.get("failed_cases", [])
        return report

    @classmethod
    def load(cls, path: str | Path) -> EvalReport:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls.from_dict(data)


# ─── Test suite management ─────────────────────────────────────


class GoldenTestSuite:
    """A collection of golden test cases with load/save/filter utilities."""

    def __init__(self, cases: list[GoldenCase] | None = None) -> None:
        self.cases: list[GoldenCase] = list(cases) if cases else []

    def __len__(self) -> int:
        return len(self.cases)

    def __iter__(self):
        return iter(self.cases)

    def add_case(self, case: GoldenCase) -> None:
        """Add a single golden case to the suite."""
        ids = {c.id for c in self.cases}
        if case.id in ids:
            raise ValueError(f"Duplicate case id: {case.id}")
        self.cases.append(case)

    def save_to_json(self, path: str | Path) -> None:
        """Persist the test suite as JSON."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {"cases": [c.to_dict() for c in self.cases]}
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    @classmethod
    def load_from_json(cls, path: str | Path) -> GoldenTestSuite:
        """Load a test suite from a JSON file."""
        path = Path(path)
        data = json.loads(path.read_text(encoding="utf-8"))
        cases_data = data.get("cases", data) if isinstance(data, dict) else data
        if isinstance(cases_data, list):
            return cls([GoldenCase.from_dict(c) for c in cases_data])
        return cls([GoldenCase.from_dict(c) for c in cases_data])

    def filter(
        self,
        *,
        tags: Sequence[str] | None = None,
        difficulty: str | Sequence[str] | None = None,
    ) -> GoldenTestSuite:
        """Return a filtered sub-suite.

        - ``tags`` matches if any of the provided tags are present in the case.
        - ``difficulty`` matches if the case difficulty equals the provided value
          (or is in the provided sequence).
        """
        difficulties = {difficulty} if isinstance(difficulty, str) else (set(difficulty) if difficulty else None)
        tag_set = set(tags) if tags else None
        filtered = [
            case for case in self.cases
            if (tag_set is None or (set(case.tags) & tag_set))
            and (difficulties is None or case.difficulty in difficulties)
        ]
        return GoldenTestSuite(filtered)


# ─── Evaluation runner ─────────────────────────────────────────


class EvalRunner:
    """Runs golden cases through ``execute_semantic_query`` and scores results."""

    def __init__(
        self,
        catalog: OntologyCatalog | None = None,
        *,
        query_executor: Callable[..., dict[str, Any]] | None = None,
        count_tolerance: float = 0.1,
    ) -> None:
        self._catalog = catalog
        self._query_executor = query_executor or execute_semantic_query
        self._count_tolerance = count_tolerance

    @property
    def catalog(self) -> OntologyCatalog:
        if self._catalog is None:
            self._catalog = load_ontology(root=REPO_ROOT)
        return self._catalog

    def run_case(self, case: GoldenCase) -> EvalResult:
        """Execute a single golden case and produce an :class:`EvalResult`."""
        start = time.perf_counter()
        error_message: str | None = None
        actual_data: list[dict[str, Any]] = []
        try:
            result = self._query_executor(
                case.ontology_query,
                catalog=self.catalog,
            )
            actual_data = result.get("data", [])
        except SemanticQueryError as exc:
            error_message = str(exc)
        except Exception as exc:  # noqa: BLE001
            error_message = f"UNEXPECTED_ERROR:{type(exc).__name__}:{exc}"
        elapsed_ms = (time.perf_counter() - start) * 1000

        actual_count = len(actual_data)
        # Entity / metric / dimension match
        query = case.ontology_query.get("query", {})
        actual_entity_ids = set(query.get("entityIds", []))
        actual_metric_ids = set(query.get("metricIds", []))
        actual_dimension_ids = set(query.get("dimensionIds", []))

        entity_match = actual_entity_ids == set(case.expected_entity_ids)
        metric_match = actual_metric_ids == set(case.expected_metric_ids)
        dimension_match = actual_dimension_ids == set(case.expected_dimension_ids)

        # Data count match
        if case.expected_data_count is not None:
            expected = case.expected_data_count
            if expected == 0:
                data_count_match = actual_count == 0
            else:
                ratio = abs(actual_count - expected) / expected
                data_count_match = ratio <= self._count_tolerance
        else:
            data_count_match = True  # no assertion

        # Filters summary check (lightweight)
        if case.expected_filters_summary and not error_message:
            filters_ok = _check_filters_summary(query.get("filters", []), case.expected_filters_summary)
            if not filters_ok:
                error_message = (error_message or "") + " FILTERS_SUMMARY_MISMATCH"

        # Status determination
        if error_message and "UNEXPECTED_ERROR" in error_message:
            status = "fail"
        elif error_message:
            status = "fail"
        elif entity_match and metric_match and dimension_match and data_count_match:
            status = "pass"
        elif entity_match or metric_match:
            status = "partial"
        else:
            status = "fail"

        return EvalResult(
            case_id=case.id,
            status=status,
            entity_match=entity_match,
            metric_match=metric_match,
            dimension_match=dimension_match,
            data_count_match=data_count_match,
            expected_count=case.expected_data_count,
            actual_count=actual_count,
            error_message=error_message,
            execution_time_ms=round(elapsed_ms, 2),
        )

    def run_suite(
        self,
        suite: GoldenTestSuite,
        *,
        tags: Sequence[str] | None = None,
    ) -> EvalReport:
        """Run all (optionally tag-filtered) cases in *suite* and return a report."""
        cases = suite.filter(tags=tags) if tags else suite
        results = [self.run_case(case) for case in cases]
        return EvalReport(results=results)


def _check_filters_summary(filters: list[dict[str, Any]], expected: dict[str, Any]) -> bool:
    """Check that expected filter dimensionId→values are present."""
    for dim_id, expected_values in expected.items():
        found = False
        expected_set = {str(v) for v in (expected_values if isinstance(expected_values, list) else [expected_values])}
        for f in filters:
            if f.get("dimensionId") == dim_id:
                actual_set = {str(v) for v in f.get("values", [])}
                if expected_set <= actual_set:
                    found = True
                    break
        if not found:
            return False
    return True


# ─── NL Intent Classifier ──────────────────────────────────────


class NLClassifier:
    """Rule-based intent classifier and entity extractor for natural-language questions.

    Uses keyword matching (no LLM) to predict intents and delegates entity
    extraction to :class:`OntologyTermResolver`.
    """

    INTENT_KEYWORDS: dict[str, list[str]] = {
        "trend": [
            "趋势", "变化", "trend", "over time", "时间", "走势",
            "月度", "周度", "每日", "monthly", "weekly", "daily",
            "growth", "增长", "变化趋势",
        ],
        "compare": [
            "对比", "比较", "compare", "versus", "vs", "差异",
            "difference", "differ", "同比", "环比", "按比",
        ],
        "rank": [
            "排名", "排行", "rank", "top", "排序", "最多", "最少",
            "最高", "最低", "bottom", "最大", "最小", "前几",
        ],
        "list": [
            "列表", "明细", "list", "详情", "哪些", "show me",
            "display", "查看", "列出", "记录", "records",
        ],
        "drilldown": [
            "下钻", "钻取", "drill", "下探", "细分", "breakdown",
            "拆分", "具体",
        ],
        "trace": [
            "追溯", "traceability", "trace", "追踪", "链路",
            "可追溯", " linkage", "覆盖",
        ],
        "aggregate": [
            "总数", "多少", "count", "total", "汇总", "统计",
            "how many", "数量", "sum", "百分比", "占比", "rate",
            "比例", "平均", "average",
        ],
    }

    def __init__(self, resolver: OntologyTermResolver | None = None) -> None:
        self._resolver = resolver
        self._init_resolver()

    def _init_resolver(self) -> None:
        if self._resolver is not None:
            return
        try:
            self._resolver = OntologyTermResolver()
        except Exception:  # noqa: BLE001
            self._resolver = None  # type: ignore[assignment]

    def classify_intent(self, natural_question: str) -> str:
        """Predict the intent of *natural_question*.

        Returns one of: aggregate, trend, compare, rank, list, drilldown, trace.
        Scoring: each keyword match contributes 1 point; highest score wins.
        Ties are broken by the INTENT_KEYWORDS insertion order priority
        (aggregate last as a fallback).
        """
        text_lower = natural_question.lower()
        scores: dict[str, int] = {}
        for intent, keywords in self.INTENT_KEYWORDS.items():
            score = 0
            for kw in keywords:
                if kw.lower() in text_lower:
                    score += 1
            if score > 0:
                scores[intent] = score
        if not scores:
            return "aggregate"  # safe default
        max_score = max(scores.values())
        # Priority order for tie-breaking (more specific intents first)
        priority = ["trace", "trend", "compare", "rank", "drilldown", "list", "aggregate"]
        for intent in priority:
            if scores.get(intent, 0) == max_score:
                return intent
        return "aggregate"

    def extract_entities(self, natural_question: str) -> list[str]:
        """Extract ontology entity IDs from *natural_question* via the resolver."""
        if self._resolver is None:
            return []
        matches = self._resolver.resolve(natural_question)
        entity_ids: list[str] = []
        seen: set[str] = set()
        for m in matches:
            entity_id = m.resolution.get("entityId")
            if entity_id and entity_id not in seen:
                entity_ids.append(entity_id)
                seen.add(entity_id)
        return entity_ids

    def extract_metrics(self, natural_question: str) -> list[str]:
        """Extract ontology metric IDs from *natural_question*."""
        if self._resolver is None:
            return []
        matches = self._resolver.resolve(natural_question)
        metric_ids: list[str] = []
        seen: set[str] = set()
        for m in matches:
            metric_id = m.resolution.get("metricId")
            if metric_id and metric_id not in seen:
                metric_ids.append(metric_id)
                seen.add(metric_id)
        return metric_ids

    def extract_dimensions(self, natural_question: str) -> list[str]:
        """Extract ontology dimension IDs from *natural_question*."""
        if self._resolver is None:
            return []
        matches = self._resolver.resolve(natural_question)
        dim_ids: list[str] = []
        seen: set[str] = set()
        for m in matches:
            dim_id = m.resolution.get("dimensionId")
            if dim_id and dim_id not in seen:
                dim_ids.append(dim_id)
                seen.add(dim_id)
        return dim_ids


# ─── CLI ───────────────────────────────────────────────────────


def _build_actor_scope() -> dict[str, Any]:
    return {
        "actorId": "eval-bot",
        "scopeHash": "eval-scope",
        "workspaceIds": ["DTSV"],
        "projectIds": [],
        "teamIds": ["DTSV"],
        "allowedObjectTypes": [
            "quality.defect",
            "testing.test_run",
            "testing.test_case",
            "requirements.aida_node",
            "defect",
            "test_run",
            "test_case",
            "aida",
        ],
        "allowedPropertyIds": [],
        "rowPolicyIds": ["dtsv"],
        "sensitiveFieldPolicyIds": [],
    }


def _make_query(
    catalog: OntologyCatalog,
    *,
    intent: str,
    entity_ids: list[str],
    metric_ids: list[str],
    dimension_ids: list[str],
    filters: list[dict[str, Any]] | None = None,
    time_scopes: list[dict[str, Any]] | None = None,
    comparison: dict[str, Any] | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    """Build a valid ontology query payload."""
    policy_dimension = "org.team" if "testing.test_run" in entity_ids else "org.problem_finder_team"
    all_filters = [{"dimensionId": policy_dimension, "operator": "in", "values": ["DTSV_China"], "source": "policy"}]
    if filters:
        all_filters.extend(filters)
    return {
        "schemaVersion": "1.0",
        "queryId": f"eval-{intent}-{entity_ids[0]}",
        "ontologyVersion": catalog.version,
        "schemaFingerprint": catalog.fingerprint,
        "query": {
            "schemaVersion": "1.0",
            "ontologyVersion": catalog.version,
            "schemaFingerprint": catalog.fingerprint,
            "intent": intent,
            "entityIds": entity_ids,
            "metricIds": metric_ids,
            "dimensionIds": dimension_ids,
            "filters": all_filters,
            "timeScopes": time_scopes or [],
            "comparison": comparison,
            "sort": [],
            "limit": limit,
        },
        "actorScope": _build_actor_scope(),
    }


def _cli_run(args: argparse.Namespace) -> int:
    suite_path = Path(args.suite) if args.suite != "default" else DEFAULT_GOLDEN_PATH
    if not suite_path.exists():
        print(f"Suite file not found: {suite_path}", file=sys.stderr)
        return 1
    suite = GoldenTestSuite.load_from_json(suite_path)
    if args.tags:
        tag_list = [t.strip() for t in args.tags.split(",")]
        suite = suite.filter(tags=tag_list)
    if args.difficulty:
        suite = suite.filter(difficulty=args.difficulty)
    print(f"Running {len(suite)} cases ...")
    try:
        catalog = load_ontology(root=REPO_ROOT)
    except OntologyLoadError as exc:
        print(f"Cannot load ontology: {exc}", file=sys.stderr)
        return 1
    runner = EvalRunner(catalog=catalog)
    report = runner.run_suite(suite)
    output_path = Path(args.output) if args.output else REPO_ROOT / "eval_reports" / f"report_{int(time.time())}.json"
    report.save_report(output_path)
    print(f"Total: {report.summary['total']}  Pass: {report.summary['passed']}  "
          f"Fail: {report.summary['failed']}  Partial: {report.summary['partial']}")
    print(f"Pass rate: {report.summary['pass_rate']:.1%}")
    print(f"Avg execution: {report.summary['avg_execution_ms']:.1f}ms")
    if report.failed_cases:
        print(f"Failed/partial cases: {', '.join(report.failed_cases)}")
    print(f"Report saved to: {output_path}")
    return 0


def _cli_compare(args: argparse.Namespace) -> int:
    report_path = Path(args.report)
    baseline_path = Path(args.baseline)
    if not report_path.exists() or not baseline_path.exists():
        print("Report or baseline file not found", file=sys.stderr)
        return 1
    current = EvalReport.load(report_path)
    baseline = EvalReport.load(baseline_path)
    diff = current.compare_with(baseline)
    print(f"Pass rate delta: {diff['pass_rate_delta']:+.1%}")
    if diff["regressions"]:
        print(f"Regressions ({len(diff['regressions'])}): {', '.join(diff['regressions'])}")
    else:
        print("No regressions detected.")
    if diff["improvements"]:
        print(f"Improvements ({len(diff['improvements'])}): {', '.join(diff['improvements'])}")
    return 0 if not diff["regressions"] else 1


def _cli_add_case(args: argparse.Namespace) -> int:
    suite_path = Path(args.suite) if args.suite != "default" else DEFAULT_GOLDEN_PATH
    suite = GoldenTestSuite.load_from_json(suite_path) if suite_path.exists() else GoldenTestSuite()
    try:
        catalog = load_ontology(root=REPO_ROOT)
    except OntologyLoadError as exc:
        print(f"Cannot load ontology: {exc}", file=sys.stderr)
        return 1
    entity_ids = [e.strip() for e in args.entities.split(",")] if args.entities else []
    metric_ids = [m.strip() for m in args.metrics.split(",")] if args.metrics else []
    dimension_ids = [d.strip() for d in (args.dimensions or "").split(",") if d.strip()] if args.dimensions else []
    tags_list = [t.strip() for t in args.tags.split(",")] if args.tags else []
    query = _make_query(
        catalog,
        intent=args.intent,
        entity_ids=entity_ids,
        metric_ids=metric_ids,
        dimension_ids=dimension_ids,
    )
    case = GoldenCase(
        id=args.id or f"case-{len(suite) + 1:03d}",
        natural_question=args.question,
        ontology_query=query,
        expected_entity_ids=entity_ids,
        expected_metric_ids=metric_ids,
        expected_dimension_ids=dimension_ids,
        tags=tags_list,
        difficulty=args.difficulty or "easy",
    )
    suite.add_case(case)
    suite.save_to_json(suite_path)
    print(f"Added case {case.id} to {suite_path}")
    return 0


def _cli_list(args: argparse.Namespace) -> int:
    suite_path = Path(args.suite) if args.suite != "default" else DEFAULT_GOLDEN_PATH
    if not suite_path.exists():
        print(f"Suite file not found: {suite_path}", file=sys.stderr)
        return 1
    suite = GoldenTestSuite.load_from_json(suite_path)
    if args.tags:
        suite = suite.filter(tags=[t.strip() for t in args.tags.split(",")])
    if args.difficulty:
        suite = suite.filter(difficulty=args.difficulty)
    for case in suite:
        print(f"  [{case.id}] ({case.difficulty}) {case.natural_question}")
        print(f"    tags={','.join(case.tags)}  intent={case.ontology_query['query']['intent']}")
    print(f"\nTotal: {len(suite)} cases")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="eval_benchmark",
        description="NL2SQL evaluation benchmark for the Data-Agent semantic query pipeline.",
    )
    sub = parser.add_subparsers(dest="command")

    # run
    p_run = sub.add_parser("run", help="Run the evaluation suite.")
    p_run.add_argument("--suite", default="default", help="Path to the suite JSON (or 'default').")
    p_run.add_argument("--tags", default=None, help="Comma-separated tags to filter.")
    p_run.add_argument("--difficulty", default=None, choices=sorted(VALID_DIFFICULTIES))
    p_run.add_argument("--output", "-o", default=None, help="Output report path.")
    p_run.set_defaults(func=_cli_run)

    # compare
    p_cmp = sub.add_parser("compare", help="Compare two reports for regression.")
    p_cmp.add_argument("--report", required=True, help="Current report JSON.")
    p_cmp.add_argument("--baseline", required=True, help="Baseline report JSON.")
    p_cmp.set_defaults(func=_cli_compare)

    # add-case
    p_add = sub.add_parser("add-case", help="Add a golden case to the suite.")
    p_add.add_argument("--question", required=True, help="Natural-language question.")
    p_add.add_argument("--intent", required=True, choices=sorted(VALID_INTENTS))
    p_add.add_argument("--entities", required=True, help="Comma-separated entity IDs.")
    p_add.add_argument("--metrics", required=True, help="Comma-separated metric IDs.")
    p_add.add_argument("--dimensions", default="", help="Comma-separated dimension IDs.")
    p_add.add_argument("--tags", default=None, help="Comma-separated tags.")
    p_add.add_argument("--difficulty", default=None, choices=sorted(VALID_DIFFICULTIES))
    p_add.add_argument("--id", default=None, help="Case ID (auto if omitted).")
    p_add.add_argument("--suite", default="default", help="Suite file path (or 'default').")
    p_add.set_defaults(func=_cli_add_case)

    # list
    p_list = sub.add_parser("list", help="List golden cases.")
    p_list.add_argument("--suite", default="default")
    p_list.add_argument("--tags", default=None)
    p_list.add_argument("--difficulty", default=None, choices=sorted(VALID_DIFFICULTIES))
    p_list.set_defaults(func=_cli_list)

    args = parser.parse_args(argv)
    if not hasattr(args, "func"):
        parser.print_help()
        return 1
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
