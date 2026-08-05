from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from typing import Any
from zoneinfo import ZoneInfo

from backend.analytics.ontology import OntologyCatalog, OntologyLoadError
from backend.analytics.read_models import (
    FullPictureDashboardDataError,
    FullPictureDashboardRequestError,
    build_semantic_defect_payload,
    list_runs,
    list_testcases,
)
from backend.analytics.semantic_analysis_store import (
    AnalysisRefExpired,
    AnalysisRefNotFound,
    AnalysisRefScopeDenied,
    SemanticAnalysisStore,
)
from backend.analytics.traceability_models import build_traceability_analysis_payload


class SemanticQueryError(ValueError):
    def __init__(self, code: str, *, status_code: int = 400, rule_codes: list[str] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code
        self.rule_codes = list(rule_codes or [])


DEFECT_METRICS = frozenset({"defect.count", "defect.created_count", "team.defect_discovery_count"})
TEST_RUN_METRICS = frozenset({"testing.run_count", "testing.passed_run_count", "testing.failed_run_count", "team.execution_count"})
TESTCASE_METRICS = frozenset({"testing.testcase_count"})

DEFECT_DIMENSION_FIELDS = {
    "time.defect_creation_date": "creation_time",
    "org.problem_finder_team": "problem_finder_team",
    "product.project": "project",
    "product.service_pack": "service_pack",
    "product.pu": "pu",
    "product.i_step": "i_step",
    "product.os": "os",
    "product.platform": "platform",
    "product.ecu": "assigned_ecu",
    "vehicle.model_series": "model_series",
    "requirements.aida": "aida",
    "quality.phase": "phase",
    "quality.severity": "problem_severity",
    "quality.status": "status",
    "quality.china_scope": "china_scope",
}

DEFECT_FILTER_PARAMS = {
    "org.problem_finder_team": "problem_finder_teams",
    "product.project": "projects",
    "product.pu": "pus",
    "product.ecu": "assigned_ecus",
    "requirements.aida": "aidas",
    "quality.phase": "phases",
    "quality.china_scope": "china_scopes",
}

TEST_RUN_DIMENSION_FIELDS = {
    "time.test_finished_date": "finished",
    "org.tester": "tester",
    "org.team": "team",
    "product.project": "project",
    "product.pu": "pu",
    "requirements.aida": "aida",
    "testing.run_status": "status",
    "time.test_week": "test_week",
}

TESTCASE_DIMENSION_FIELDS = {
    "product.project": "project",
    "product.pu": "pu",
    "requirements.aida": "aida",
}

RECORD_FIELD_MAPS = {
    "quality.defect": {
        "defect_id": "ticket_id",
        "name": "ticket_name",
        "creation_time": "creation_time",
        "status": "status",
        "severity": "problem_severity",
        "phase": "phase",
        "china_scope": "china_scope",
        "problem_finder_team": "problem_finder_team",
        "project": "project",
        "service_pack": "service_pack",
        "pu": "pu",
        "i_step": "i_step",
        "os": "os",
        "platform": "platform",
        "assigned_ecu": "assigned_ecu",
        "model_series": "model_series",
        "aida": "aida",
        "detected_by": "detected_by",
        "solution_cluster": "solution_cluster",
        "defect_category": "defect_category",
        "lead_model": "lead_model",
        "market": "market",
        "year": "year",
    },
    "testing.test_run": {
        "mr_id": "mr_id",
        "test_id": "test_id",
        "name": "test_name",
        "test_name": "test_name",
        "status": "status",
        "finished": "finished",
        "test_week": "test_week",
        "tester": "tester",
        "team": "team",
        "project": "project",
        "pu": "pu",
        "aida": "aida",
        "defect_id": "defect_id",
        "started": "started",
        "release": "release",
    },
    "testing.test_case": {
        "test_id": "test_id",
        "name": "test_name",
        "test_name": "test_name",
        "project": "project",
        "pu": "pu",
        "aida": "aida",
        "trace_status": "trace_status",
        "run_count": "run_count",
        "scope_team": "scope_team",
        "scope_release": "scope_release",
    },
}

RECORD_IDENTIFIERS = {
    "quality.defect": ("ticket_id", "defect_id"),
    "testing.test_run": ("mr_id", "mr_id"),
    "testing.test_case": ("test_id", "test_id"),
}

QUERY_INTENTS = frozenset({"aggregate", "trend", "compare", "rank", "list", "drilldown", "trace"})
ACTOR_SCOPE_LIST_FIELDS = (
    "workspaceIds",
    "projectIds",
    "teamIds",
    "allowedObjectTypes",
    "allowedPropertyIds",
    "rowPolicyIds",
    "sensitiveFieldPolicyIds",
)
SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")
COMPARISON_PERIOD_FIELD = "__semantic_comparison_period"
TRACE_LINEAGE_RELATIONSHIPS = (
    ("requirements.aida_node", "testing.test_case", "testing.test_case.validates.aida_node"),
    ("testing.test_case", "testing.test_run", "testing.test_run.executes.test_case"),
    ("testing.test_run", "quality.defect", "quality.defect.detected_in.test_run"),
)


def _stable_hash(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _assert_exact_keys(value: dict[str, Any], *, allowed: set[str], required: set[str], label: str) -> None:
    missing = required - set(value)
    unknown = set(value) - allowed
    if missing:
        raise SemanticQueryError(f"SEMANTIC_{label}_MISSING:{','.join(sorted(missing))}")
    if unknown:
        raise SemanticQueryError(f"SEMANTIC_{label}_UNKNOWN:{','.join(sorted(unknown))}")


def _require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SemanticQueryError(f"SEMANTIC_{label}_STRING_REQUIRED")
    return value


def _require_string_list(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise SemanticQueryError(f"SEMANTIC_{label}_STRING_ARRAY_REQUIRED")
    if len(value) != len(set(value)):
        raise SemanticQueryError(f"SEMANTIC_{label}_DUPLICATE")
    return value


def _catalog_metric(catalog: OntologyCatalog, metric_id: str, *, approved_only: bool = False) -> dict[str, Any]:
    try:
        return catalog.get_metric(metric_id, approved_only=approved_only)
    except OntologyLoadError as exc:
        raise SemanticQueryError(str(exc)) from exc


def _catalog_dimension(catalog: OntologyCatalog, dimension_id: str) -> dict[str, Any]:
    try:
        return catalog.get_dimension(dimension_id)
    except OntologyLoadError as exc:
        raise SemanticQueryError(str(exc)) from exc


def _catalog_policy(catalog: OntologyCatalog, policy_id: str) -> dict[str, Any]:
    try:
        return catalog.get_policy(policy_id)
    except OntologyLoadError as exc:
        raise SemanticQueryError(str(exc)) from exc


def _catalog_constraint(catalog: OntologyCatalog, constraint_id: str) -> dict[str, Any]:
    try:
        return catalog.get_constraint(constraint_id)
    except OntologyLoadError as exc:
        raise SemanticQueryError(str(exc)) from exc


def _enforce_business_rule_denials(query: dict[str, Any], catalog: OntologyCatalog) -> None:
    metric_ids = set(query["metricIds"])
    denied_rule_codes: list[str] = []
    for rule in catalog.list_business_rules(kind="deny", approved_only=True):
        applies_to = rule.get("appliesTo") or {}
        rule_metric_ids = set(applies_to.get("metricIds") or [])
        rule_intents = set(applies_to.get("intents") or [])
        if (not rule_metric_ids or metric_ids & rule_metric_ids) and (not rule_intents or query["intent"] in rule_intents):
            denied_rule_codes.append(str((rule.get("effect") or {}).get("denialCode") or f"BUSINESS_RULE_DENY:{rule['id']}"))
    if denied_rule_codes:
        raise SemanticQueryError("SEMANTIC_BUSINESS_RULE_DENIED", status_code=403, rule_codes=denied_rule_codes)


def _time_fields_referenced_by(query: dict[str, Any]) -> set[str]:
    return {
        *(
            str(scope.get("fieldId") or "")
            for scope in query["timeScopes"]
        ),
        *(str(dimension_id) for dimension_id in query["dimensionIds"] if str(dimension_id).startswith("time.")),
        *(
            str(filter_item.get("dimensionId") or "")
            for filter_item in query["filters"]
            if str(filter_item.get("dimensionId") or "").startswith("time.")
        ),
        *(
            str(sort_item.get("fieldId") or "")
            for sort_item in query["sort"]
            if str(sort_item.get("fieldId") or "").startswith("time.")
        ),
    } - {""}


def _enforce_business_rule_requirements(query: dict[str, Any], catalog: OntologyCatalog) -> list[str]:
    metric_ids = set(query["metricIds"])
    referenced_time_fields = _time_fields_referenced_by(query)
    matched_rule_codes: list[str] = []
    unmet_rule_codes: list[str] = []
    for rule in catalog.list_business_rules(kind="require", approved_only=True):
        applies_to = rule.get("appliesTo") or {}
        rule_metric_ids = set(applies_to.get("metricIds") or [])
        rule_intents = set(applies_to.get("intents") or [])
        required_time_field = str((rule.get("effect") or {}).get("requiredTimeField") or "")
        if not (
            (not rule_metric_ids or metric_ids & rule_metric_ids)
            and (not rule_intents or query["intent"] in rule_intents)
        ):
            continue
        rule_code = f"BUSINESS_RULE_REQUIRE:{rule['id']}"
        matched_rule_codes.append(rule_code)
        if any(field_id != required_time_field for field_id in referenced_time_fields):
            unmet_rule_codes.append(rule_code)
    if unmet_rule_codes:
        raise SemanticQueryError(
            "SEMANTIC_BUSINESS_RULE_REQUIREMENT_UNMET",
            status_code=400,
            rule_codes=unmet_rule_codes,
        )
    return matched_rule_codes


def _apply_business_rule_derivations(query: dict[str, Any], catalog: OntologyCatalog) -> tuple[dict[str, Any], list[str]]:
    metric_ids = set(query["metricIds"])
    filters = list(query["filters"])
    applied_rule_codes: list[str] = []
    for rule in catalog.list_business_rules(kind="derive", approved_only=True):
        applies_to = rule.get("appliesTo") or {}
        rule_metric_ids = set(applies_to.get("metricIds") or [])
        rule_intents = set(applies_to.get("intents") or [])
        if not ((not rule_metric_ids or metric_ids & rule_metric_ids) and (not rule_intents or query["intent"] in rule_intents)):
            continue
        derived_filter = dict((rule.get("effect") or {}).get("derivedFilter") or {})
        candidate = {
            "dimensionId": str(derived_filter.get("dimensionId") or ""),
            "operator": str(derived_filter.get("operator") or ""),
            "values": list(derived_filter.get("values") or []),
            "source": "policy",
        }
        if not candidate["dimensionId"] or candidate["operator"] not in {"in", "eq"} or not candidate["values"]:
            raise SemanticQueryError("SEMANTIC_BUSINESS_RULE_DERIVATION_INVALID", status_code=503)
        if not any(
            filter_item.get("source") == "policy"
            and filter_item.get("dimensionId") == candidate["dimensionId"]
            and filter_item.get("operator") == candidate["operator"]
            and filter_item.get("values") == candidate["values"]
            for filter_item in filters
        ):
            filters.append(candidate)
        applied_rule_codes.append(f"BUSINESS_RULE_DERIVE:{rule['id']}")
    return ({**query, "filters": filters}, applied_rule_codes)


def _source_freshness_warnings(
    revision: dict[str, Any],
    catalog: OntologyCatalog,
    *,
    now: datetime | None = None,
) -> list[str]:
    source = next((item for item in catalog.bundle["sources"] if item["id"] == revision.get("sourceId")), None)
    maximum_age = source.get("freshnessSloMinutes") if source else None
    watermark = str(revision.get("ingestionWatermark") or "").strip()
    if not isinstance(maximum_age, int) or not watermark or watermark == "unknown":
        return []
    try:
        instant = datetime.fromisoformat(watermark.replace("Z", "+00:00"))
    except ValueError:
        return [f"SOURCE_WATERMARK_INVALID:{revision.get('sourceId', 'unknown')}"]
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    current_time = now or datetime.now(timezone.utc)
    if current_time.tzinfo is None:
        current_time = current_time.replace(tzinfo=timezone.utc)
    if current_time.astimezone(timezone.utc) - instant.astimezone(timezone.utc) > timedelta(minutes=maximum_age):
        return [f"SOURCE_STALE:{revision.get('sourceId', 'unknown')}"]
    return []


def _query_operation(query: dict[str, Any]) -> str:
    if query["intent"] == "trace":
        return "traceability_query"
    if query["intent"] in {"list", "drilldown"}:
        return "semantic_record_query"
    return "semantic_metric_query"


def _validate_time_scope(scope: Any, catalog: OntologyCatalog) -> None:
    if not isinstance(scope, dict):
        raise SemanticQueryError("SEMANTIC_TIME_SCOPE_OBJECT_REQUIRED")
    _assert_exact_keys(
        scope,
        allowed={"role", "fieldId", "start", "end", "timezone", "relativeText", "anchorAt"},
        required={"role", "fieldId", "start", "end", "timezone", "anchorAt"},
        label="TIME_SCOPE",
    )
    if scope["role"] not in {"primary", "baseline", "comparison"} or scope["timezone"] != "Asia/Shanghai":
        raise SemanticQueryError("SEMANTIC_TIME_SCOPE_INVALID")
    dimension = _catalog_dimension(catalog, _require_string(scope["fieldId"], "TIME_FIELD"))
    if dimension.get("type") != "datetime":
        raise SemanticQueryError("SEMANTIC_TIME_FIELD_INVALID")
    try:
        start = date.fromisoformat(str(scope["start"]))
        end = date.fromisoformat(str(scope["end"]))
        datetime.fromisoformat(str(scope["anchorAt"]).replace("Z", "+00:00"))
    except ValueError as exc:
        raise SemanticQueryError("SEMANTIC_TIME_SCOPE_FORMAT_INVALID") from exc
    if start > end:
        raise SemanticQueryError("SEMANTIC_TIME_SCOPE_RANGE_INVALID")


def _validate_comparison(comparison: Any) -> None:
    if comparison is None:
        return
    if not isinstance(comparison, dict):
        raise SemanticQueryError("SEMANTIC_COMPARISON_OBJECT_REQUIRED")
    _assert_exact_keys(
        comparison,
        allowed={"kind", "dimensionId", "groups"},
        required={"kind", "dimensionId", "groups"},
        label="COMPARISON",
    )
    if comparison["kind"] not in {"dimension_values", "time_periods"}:
        raise SemanticQueryError("SEMANTIC_COMPARISON_KIND_INVALID")
    _require_string(comparison["dimensionId"], "COMPARISON_DIMENSION")
    groups = _require_string_list(comparison["groups"], "COMPARISON_GROUPS")
    if len(groups) < 2:
        raise SemanticQueryError("SEMANTIC_COMPARISON_GROUPS_REQUIRED")


def _validate_request(payload: dict[str, Any], catalog: OntologyCatalog) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
    if not isinstance(payload, dict):
        raise SemanticQueryError("SEMANTIC_REQUEST_OBJECT_REQUIRED")
    _assert_exact_keys(
        payload,
        allowed={"schemaVersion", "queryId", "ontologyVersion", "schemaFingerprint", "query", "actorScope"},
        required={"schemaVersion", "queryId", "ontologyVersion", "schemaFingerprint", "query", "actorScope"},
        label="REQUEST",
    )
    if payload["schemaVersion"] != "1.0":
        raise SemanticQueryError("SEMANTIC_REQUEST_VERSION_INVALID")
    _require_string(payload["queryId"], "QUERY_ID")
    if payload["ontologyVersion"] != catalog.version or payload["schemaFingerprint"] != catalog.fingerprint:
        raise SemanticQueryError("SEMANTIC_ONTOLOGY_VERSION_MISMATCH", status_code=409)

    query = payload["query"]
    actor_scope = payload["actorScope"]
    if not isinstance(query, dict) or not isinstance(actor_scope, dict):
        raise SemanticQueryError("SEMANTIC_QUERY_AND_SCOPE_OBJECTS_REQUIRED")
    _assert_exact_keys(
        query,
        allowed={"schemaVersion", "ontologyVersion", "schemaFingerprint", "intent", "entityIds", "metricIds", "dimensionIds", "filters", "timeScopes", "comparison", "sort", "limit"},
        required={"schemaVersion", "ontologyVersion", "schemaFingerprint", "intent", "entityIds", "metricIds", "dimensionIds", "filters", "timeScopes", "comparison", "sort", "limit"},
        label="QUERY",
    )
    _assert_exact_keys(
        actor_scope,
        allowed={"actorId", "scopeHash", *ACTOR_SCOPE_LIST_FIELDS},
        required={"actorId", "scopeHash", *ACTOR_SCOPE_LIST_FIELDS},
        label="ACTOR_SCOPE",
    )
    if query["ontologyVersion"] != catalog.version or query["schemaFingerprint"] != catalog.fingerprint:
        raise SemanticQueryError("SEMANTIC_QUERY_FINGERPRINT_MISMATCH", status_code=409)
    if query["schemaVersion"] != "1.0" or query["intent"] not in QUERY_INTENTS:
        raise SemanticQueryError("SEMANTIC_QUERY_CONTRACT_INVALID")
    maximum_limit = int(_catalog_constraint(catalog, "query.max_limit")["parameters"]["maximum"])
    if not isinstance(query["limit"], int) or query["limit"] < 1 or query["limit"] > maximum_limit:
        raise SemanticQueryError("SEMANTIC_QUERY_LIMIT_INVALID")

    entity_ids = _require_string_list(query["entityIds"], "ENTITY_IDS")
    metric_ids = _require_string_list(query["metricIds"], "METRIC_IDS")
    dimension_ids = _require_string_list(query["dimensionIds"], "DIMENSION_IDS")
    known_entity_ids = {str(item["id"]) for item in catalog.bundle["entities"]}
    unknown_entities = set(entity_ids) - known_entity_ids
    if unknown_entities:
        raise SemanticQueryError(f"SEMANTIC_ENTITY_NOT_FOUND:{sorted(unknown_entities)[0]}")
    approved_only = _catalog_constraint(catalog, "planner.approved_metric_only")["parameters"].get("enabled", True) is not False
    metrics = [_catalog_metric(catalog, metric_id, approved_only=approved_only) for metric_id in metric_ids]
    for metric in metrics:
        if metric["entityId"] not in entity_ids:
            raise SemanticQueryError(f"SEMANTIC_METRIC_ENTITY_REQUIRED:{metric['id']}:{metric['entityId']}")
        present_filters = {str(item.get("dimensionId")) for item in query.get("filters", []) if isinstance(item, dict) and item.get("values")}
        for required_filter in metric.get("requiredFilters", []):
            if required_filter not in present_filters:
                raise SemanticQueryError(f"SEMANTIC_METRIC_REQUIRED_FILTER_MISSING:{metric['id']}:{required_filter}")
    for dimension_id in dimension_ids:
        _catalog_dimension(catalog, dimension_id)
        if metrics and not any(dimension_id in metric["allowedDimensions"] for metric in metrics):
            raise SemanticQueryError(f"SEMANTIC_DIMENSION_NOT_ALLOWED:{dimension_id}")

    for label in ("filters", "timeScopes", "sort"):
        if not isinstance(query[label], list):
            raise SemanticQueryError(f"SEMANTIC_{label.upper()}_ARRAY_REQUIRED")
    for filter_item in query["filters"]:
        if not isinstance(filter_item, dict):
            raise SemanticQueryError("SEMANTIC_FILTER_OBJECT_REQUIRED")
        _assert_exact_keys(
            filter_item,
            allowed={"dimensionId", "operator", "values", "source"},
            required={"dimensionId", "operator", "values", "source"},
            label="FILTER",
        )
        dimension_id = _require_string(filter_item["dimensionId"], "FILTER_DIMENSION")
        _catalog_dimension(catalog, dimension_id)
        if metrics and not any(dimension_id in metric["allowedDimensions"] for metric in metrics):
            raise SemanticQueryError(f"SEMANTIC_FILTER_DIMENSION_NOT_ALLOWED:{dimension_id}")
        if filter_item["operator"] not in {"in", "not_in", "eq", "neq", "contains"}:
            raise SemanticQueryError("SEMANTIC_FILTER_OPERATOR_INVALID")
        if filter_item["source"] not in {"user", "context", "policy"}:
            raise SemanticQueryError("SEMANTIC_FILTER_SOURCE_INVALID")
        if not isinstance(filter_item["values"], list) or not filter_item["values"] or any(isinstance(value, (dict, list)) or value is None for value in filter_item["values"]):
            raise SemanticQueryError("SEMANTIC_FILTER_VALUES_REQUIRED")

    for scope in query["timeScopes"]:
        _validate_time_scope(scope, catalog)
    _validate_comparison(query["comparison"])
    comparison = query["comparison"]
    if comparison is not None:
        if comparison["dimensionId"] not in dimension_ids:
            raise SemanticQueryError("SEMANTIC_COMPARISON_DIMENSION_REQUIRED")
        if comparison["kind"] == "time_periods":
            period_scopes = [scope for scope in query["timeScopes"] if scope["role"] in {"baseline", "comparison"}]
            expected_groups = [f"{scope['start']}/{scope['end']}" for scope in period_scopes]
            if (
                len(period_scopes) < 2
                or any(scope["fieldId"] != comparison["dimensionId"] for scope in period_scopes)
                or comparison["groups"] != expected_groups
            ):
                raise SemanticQueryError("SEMANTIC_TIME_COMPARISON_MISMATCH")
    for sort_item in query["sort"]:
        if not isinstance(sort_item, dict):
            raise SemanticQueryError("SEMANTIC_SORT_OBJECT_REQUIRED")
        _assert_exact_keys(sort_item, allowed={"fieldId", "direction"}, required={"fieldId", "direction"}, label="SORT")
        field_id = _require_string(sort_item["fieldId"], "SORT_FIELD")
        if field_id not in {*metric_ids, *dimension_ids} or sort_item["direction"] not in {"asc", "desc"}:
            raise SemanticQueryError("SEMANTIC_SORT_INVALID")

    for label in ACTOR_SCOPE_LIST_FIELDS:
        _require_string_list(actor_scope[label], f"ACTOR_{label.upper()}")
    _require_string(actor_scope["actorId"], "ACTOR_ID")
    _require_string(actor_scope["scopeHash"], "ACTOR_SCOPE_HASH")
    if not actor_scope["allowedObjectTypes"]:
        raise SemanticQueryError("SEMANTIC_OBJECT_SCOPE_EMPTY", status_code=403)

    if query["intent"] == "trace" and "testing.test_run" not in entity_ids:
        raise SemanticQueryError("SEMANTIC_TRACE_ENTITY_REQUIRED")
    if query["intent"] != "trace" and not metric_ids:
        raise SemanticQueryError("SEMANTIC_METRIC_REQUIRED")
    allowed_operations = set(_catalog_policy(catalog, "analytics.read_only")["allowedOperations"])
    if _query_operation(query) not in allowed_operations:
        raise SemanticQueryError("SEMANTIC_OPERATION_DENIED", status_code=403)

    _validate_actor_scope(query, actor_scope, catalog)
    _enforce_business_rule_denials(query, catalog)
    requirement_codes = _enforce_business_rule_requirements(query, catalog)
    effective_query, derivation_codes = _apply_business_rule_derivations(query, catalog)
    _validate_actor_scope(effective_query, actor_scope, catalog)
    if effective_query["intent"] == "trace":
        _trace_lineage_path(effective_query, catalog)
    return effective_query, actor_scope, [*requirement_codes, *derivation_codes]


def _object_aliases(entity_id: str) -> set[str]:
    tail = entity_id.rsplit(".", 1)[-1]
    return {entity_id, tail, tail.replace("_", "-")}


def _mandatory_scope_filters(query: dict[str, Any], actor_scope: dict[str, Any], catalog: OntologyCatalog) -> list[tuple[str, list[str]]]:
    policy = _catalog_policy(catalog, "actor.scope.mandatory")
    required: list[tuple[str, list[str]]] = []
    for rule in policy.get("rules", []):
        if rule["entityId"] not in query["entityIds"] or query["intent"] not in rule["intents"]:
            continue
        scope_key = str(rule["scopeKey"])
        values = [str(value).strip() for value in actor_scope.get(scope_key, []) if str(value).strip()]
        if scope_key == "teamIds" and not values:
            continue
        if scope_key == "workspaceIds" and actor_scope.get("teamIds"):
            continue
        if rule.get("normalizer") == "dtsv_team":
            values = ["DTSV_China" if value.casefold() in {"dtsv", "dtsv_china"} else value for value in values]
            if scope_key == "workspaceIds":
                values = [value for value in values if value == "DTSV_China"]
        if values:
            required.append((str(rule["dimensionId"]), list(dict.fromkeys(values))))
    return required


def _validate_actor_scope(query: dict[str, Any], actor_scope: dict[str, Any], catalog: OntologyCatalog) -> None:
    allowed_objects = set(actor_scope["allowedObjectTypes"])
    for entity_id in query["entityIds"]:
        if not (_object_aliases(entity_id) & allowed_objects):
            raise SemanticQueryError(f"SEMANTIC_OBJECT_SCOPE_DENIED:{entity_id}", status_code=403)

    for dimension_id, expected_values in _mandatory_scope_filters(query, actor_scope, catalog):
        policy_values = {
            str(value)
            for item in query["filters"]
            if item["source"] == "policy" and item["dimensionId"] == dimension_id
            for value in item["values"]
        }
        if any(value not in policy_values for value in expected_values):
            raise SemanticQueryError(f"SEMANTIC_POLICY_FILTER_REQUIRED:{dimension_id}", status_code=403)
        allowed_values = set(expected_values)
        for item in query["filters"]:
            if item["dimensionId"] == dimension_id and any(str(value) not in allowed_values for value in item["values"]):
                raise SemanticQueryError("SEMANTIC_SCOPE_FILTER_DENIED", status_code=403)

    allowed_properties = set(actor_scope["allowedPropertyIds"])
    sensitive_policies = set(actor_scope["sensitiveFieldPolicyIds"])
    referenced_dimensions = {
        *query["dimensionIds"],
        *(item["dimensionId"] for item in query["filters"]),
        *(item["fieldId"] for item in query["timeScopes"]),
        *(item["fieldId"] for item in query["sort"] if item["fieldId"] not in query["metricIds"]),
    }
    entities = {str(item["id"]): item for item in catalog.bundle["entities"]}
    dimensions = {str(item["id"]): item for item in catalog.bundle["dimensions"]}
    sensitive_levels = set(_catalog_policy(catalog, "sensitive.property.redaction").get("sensitivityLevels", []))
    for dimension_id in referenced_dimensions:
        dimension = dimensions.get(dimension_id)
        if not dimension:
            continue
        entity = entities.get(str(dimension["entityId"]))
        prop = next((item for item in entity.get("properties", []) if item["id"] == dimension["propertyId"]), None) if entity else None
        if not prop or prop.get("sensitivity") not in sensitive_levels:
            continue
        refs = {dimension_id, str(prop["id"]), f"{entity['id']}.{prop['id']}"}
        policy_allowed = "pseudonymize:confidential" in sensitive_policies or f"pseudonymize:{dimension_id}" in sensitive_policies or "raw:confidential" in sensitive_policies
        if not (refs & allowed_properties) or not policy_allowed:
            raise SemanticQueryError(f"SEMANTIC_SENSITIVE_FIELD_DENIED:{dimension_id}", status_code=403)


def _matches_filter(row: dict[str, Any], item: dict[str, Any], field_map: dict[str, str]) -> bool:
    field = field_map.get(item["dimensionId"])
    if not field:
        raise SemanticQueryError(f"SEMANTIC_DIMENSION_NOT_EXECUTABLE:{item['dimensionId']}")
    current = str(row.get(field) or "")
    values = {str(value) for value in item["values"]}
    operator = item["operator"]
    if operator in {"in", "eq"}:
        return current in values
    if operator in {"not_in", "neq"}:
        return current not in values
    return any(value.casefold() in current.casefold() for value in values)


def _apply_filters(rows: list[dict[str, Any]], filters: list[dict[str, Any]], field_map: dict[str, str]) -> list[dict[str, Any]]:
    filtered = rows
    for item in filters:
        filtered = [row for row in filtered if _matches_filter(row, item, field_map)]
    return filtered


def _source_date(value: Any) -> date | None:
    raw_value = str(value or "").strip()
    if not raw_value:
        return None
    if len(raw_value) == 10:
        try:
            return date.fromisoformat(raw_value)
        except ValueError:
            return None
    try:
        instant = datetime.fromisoformat(raw_value.replace("Z", "+00:00"))
    except ValueError:
        try:
            return date.fromisoformat(raw_value[:10])
        except ValueError:
            return None
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=SHANGHAI_TZ)
    return instant.astimezone(SHANGHAI_TZ).date()


def _apply_time_scopes(
    rows: list[dict[str, Any]],
    time_scopes: list[dict[str, Any]],
    field_map: dict[str, str],
    comparison: dict[str, Any] | None,
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    if not time_scopes:
        return rows, field_map
    field_ids = {str(scope["fieldId"]) for scope in time_scopes}
    if len(field_ids) != 1:
        raise SemanticQueryError("SEMANTIC_TIME_FIELDS_MIXED")
    field_id = next(iter(field_ids))
    source_field = field_map.get(field_id)
    if not source_field:
        raise SemanticQueryError(f"SEMANTIC_TIME_FIELD_NOT_EXECUTABLE:{field_id}")
    if rows and not any(str(row.get(source_field) or "").strip() for row in rows):
        raise SemanticQueryError(f"SEMANTIC_SOURCE_FIELD_UNAVAILABLE:{field_id}", status_code=422)

    parsed_scopes = [
        (scope, date.fromisoformat(scope["start"]), date.fromisoformat(scope["end"]))
        for scope in time_scopes
    ]
    time_comparison = comparison is not None and comparison["kind"] == "time_periods"
    selected: list[dict[str, Any]] = []
    for row in rows:
        row_date = _source_date(row.get(source_field))
        if row_date is None:
            continue
        matched = next((scope for scope, start, end in parsed_scopes if start <= row_date <= end), None)
        if matched is None:
            continue
        selected_row = dict(row)
        if time_comparison:
            selected_row[COMPARISON_PERIOD_FIELD] = f"{matched['start']}/{matched['end']}"
        selected.append(selected_row)

    effective_field_map = dict(field_map)
    if time_comparison:
        effective_field_map[comparison["dimensionId"]] = COMPARISON_PERIOD_FIELD
    return selected, effective_field_map


def _dimension_value(row: dict[str, Any], dimension_id: str, field_map: dict[str, str]) -> str:
    value = row.get(field_map[dimension_id])
    if dimension_id.startswith("time.") and field_map[dimension_id] != COMPARISON_PERIOD_FIELD:
        normalized = _source_date(value)
        return normalized.isoformat() if normalized else "(missing)"
    return str(value or "(missing)")


def _aggregate_rows(
    rows: list[dict[str, Any]],
    *,
    metric_ids: list[str],
    dimension_ids: list[str],
    field_map: dict[str, str],
    identifier: str,
    limit: int,
    sort_items: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, int], list[str]]:
    warnings: list[str] = []
    missing_dimensions = [
        dimension_id
        for dimension_id in dimension_ids
        if not any(str(row.get(field_map.get(dimension_id, "")) or "").strip() for row in rows)
    ]
    if missing_dimensions and rows:
        warnings.append(f"DIMENSION_VALUES_MISSING:{','.join(missing_dimensions)}")
    distinct_rows = {str(row.get(identifier) or ""): row for row in rows if str(row.get(identifier) or "")}
    metric_values: dict[str, int] = {}
    for metric_id in metric_ids:
        if metric_id == "testing.passed_run_count":
            metric_values[metric_id] = len({key for key, row in distinct_rows.items() if str(row.get("status") or "").casefold() == "passed"})
        elif metric_id == "testing.failed_run_count":
            metric_values[metric_id] = len({key for key, row in distinct_rows.items() if str(row.get("status") or "").casefold() == "failed"})
        else:
            metric_values[metric_id] = len(distinct_rows)

    if not dimension_ids:
        return [], metric_values, warnings
    grouped: dict[tuple[str, ...], set[str]] = defaultdict(set)
    for key, row in distinct_rows.items():
        group = tuple(_dimension_value(row, dimension_id, field_map) for dimension_id in dimension_ids)
        grouped[group].add(key)
    data = []
    for group, identifiers in grouped.items():
        record = {dimension_id: group[index] for index, dimension_id in enumerate(dimension_ids)}
        for metric_id in metric_ids:
            if metric_id == "testing.passed_run_count":
                record[metric_id] = sum(1 for key in identifiers if str(distinct_rows[key].get("status") or "").casefold() == "passed")
            elif metric_id == "testing.failed_run_count":
                record[metric_id] = sum(1 for key in identifiers if str(distinct_rows[key].get("status") or "").casefold() == "failed")
            else:
                record[metric_id] = len(identifiers)
        data.append(record)
    primary_metric = metric_ids[0] if metric_ids else identifier
    data.sort(key=lambda item: (-int(item.get(primary_metric) or 0), tuple(str(item.get(dimension_id) or "") for dimension_id in dimension_ids)))
    for sort_item in reversed(sort_items):
        field_id = sort_item["fieldId"]
        if field_id in metric_ids:
            data.sort(key=lambda item: float(item.get(field_id) or 0), reverse=sort_item["direction"] == "desc")
        else:
            data.sort(key=lambda item: str(item.get(field_id) or ""), reverse=sort_item["direction"] == "desc")
    return data[:limit], metric_values, warnings


def _defect_provider(query_filters: dict[str, Any]) -> dict[str, Any]:
    try:
        return build_semantic_defect_payload(**query_filters)
    except FullPictureDashboardRequestError as exc:
        status_code = 409 if "snapshot" in str(exc).casefold() else 400
        raise SemanticQueryError("SEMANTIC_ANALYSIS_REVISION_STALE" if status_code == 409 else "SEMANTIC_DEFECT_QUERY_INVALID", status_code=status_code) from exc
    except FullPictureDashboardDataError as exc:
        raise SemanticQueryError("SEMANTIC_DEFECT_DATA_UNAVAILABLE", status_code=503) from exc


def _defect_provider_kwargs(query: dict[str, Any]) -> dict[str, Any]:
    kwargs: dict[str, Any] = {}
    for item in query["filters"]:
        parameter = DEFECT_FILTER_PARAMS.get(item["dimensionId"])
        if parameter and item["operator"] in {"in", "eq"}:
            kwargs[parameter] = item["values"]
    if query["timeScopes"]:
        if any(scope["fieldId"] != "time.defect_creation_date" for scope in query["timeScopes"]):
            raise SemanticQueryError("SEMANTIC_TIME_FIELD_NOT_EXECUTABLE:time.defect_creation_date")
        kwargs["creation_time_start"] = min(scope["start"] for scope in query["timeScopes"])
        kwargs["creation_time_end"] = max(scope["end"] for scope in query["timeScopes"])
        kwargs["years"] = sorted({year for scope in query["timeScopes"] for year in (scope["start"][:4], scope["end"][:4])})
    return kwargs


def _execute_defects(query: dict[str, Any], provider: Callable[[dict[str, Any]], dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any], list[str]]:
    kwargs = _defect_provider_kwargs(query)
    payload = provider(kwargs)
    rows = [dict(row) for row in payload.get("ticket_rows", [])]
    rows = _apply_filters(rows, query["filters"], DEFECT_DIMENSION_FIELDS)
    rows, field_map = _apply_time_scopes(rows, query["timeScopes"], DEFECT_DIMENSION_FIELDS, query["comparison"])
    data, metric_values, warnings = _aggregate_rows(
        rows,
        metric_ids=query["metricIds"],
        dimension_ids=query["dimensionIds"],
        field_map=field_map,
        identifier="ticket_id",
        limit=query["limit"],
        sort_items=query["sort"],
    )
    revision = {
        "sourceId": "analytics.full_picture_defects",
        "revisionId": str(payload.get("snapshot_version") or _stable_hash(payload.get("generated_from", {}))),
        "status": "pinned" if payload.get("snapshot_version") else "unpinned",
        "asOf": datetime.now(timezone.utc).isoformat(),
        "ingestionWatermark": str(payload.get("generated_from", {}).get("fetched_at") or "unknown"),
    }
    return data, {"metrics": metric_values, "rowCount": len(rows)}, revision, warnings


def _execute_test_runs(query: dict[str, Any], provider: Callable[[], list[dict[str, Any]]]) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any], list[str]]:
    source_rows = [dict(row) for row in provider()]
    rows = source_rows
    rows = _apply_filters(rows, query["filters"], TEST_RUN_DIMENSION_FIELDS)
    rows, field_map = _apply_time_scopes(rows, query["timeScopes"], TEST_RUN_DIMENSION_FIELDS, query["comparison"])
    data, metric_values, warnings = _aggregate_rows(
        rows,
        metric_ids=query["metricIds"],
        dimension_ids=query["dimensionIds"],
        field_map=field_map,
        identifier="mr_id",
        limit=query["limit"],
        sort_items=query["sort"],
    )
    revision = {"sourceId": "analytics.testing_coverage", "revisionId": _stable_hash(source_rows), "status": "unpinned", "asOf": datetime.now(timezone.utc).isoformat(), "ingestionWatermark": "unknown"}
    return data, {"metrics": metric_values, "rowCount": len(rows)}, revision, warnings


def _execute_testcases(query: dict[str, Any], provider: Callable[[], list[dict[str, Any]]]) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any], list[str]]:
    source_rows = [dict(row) for row in provider()]
    rows = source_rows
    unsupported = [dimension_id for dimension_id in query["dimensionIds"] if dimension_id not in TESTCASE_DIMENSION_FIELDS]
    if unsupported:
        raise SemanticQueryError(f"SEMANTIC_DIMENSION_NOT_EXECUTABLE:{unsupported[0]}")
    rows = _apply_filters(rows, query["filters"], TESTCASE_DIMENSION_FIELDS)
    data, metric_values, warnings = _aggregate_rows(
        rows,
        metric_ids=query["metricIds"],
        dimension_ids=query["dimensionIds"],
        field_map=TESTCASE_DIMENSION_FIELDS,
        identifier="test_id",
        limit=query["limit"],
        sort_items=query["sort"],
    )
    revision = {"sourceId": "analytics.testing_coverage", "revisionId": _stable_hash(source_rows), "status": "unpinned", "asOf": datetime.now(timezone.utc).isoformat(), "ingestionWatermark": "unknown"}
    return data, {"metrics": metric_values, "rowCount": len(rows)}, revision, warnings


def _trace_provider(query_params: Any) -> dict[str, Any]:
    return build_traceability_analysis_payload({**dict(query_params or {}), "__include_internal_fields": True})


def _execute_traceability(query: dict[str, Any], provider: Callable[[Any], dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any], list[str]]:
    query_params: dict[str, Any] = {}
    trace_status = "Traced"
    for item in query["filters"]:
        if item["dimensionId"] == "org.team" and item["operator"] in {"in", "eq"}:
            query_params["teams"] = [str(value) for value in item["values"]]
        elif item["dimensionId"] == "testing.run_status" and item["operator"] in {"in", "eq"}:
            query_params["statuses"] = [str(value) for value in item["values"]]
        elif item["dimensionId"] == "requirements.aida" and item["operator"] in {"in", "eq"}:
            query_params["aidas"] = [str(value) for value in item["values"]]
        elif item["dimensionId"] == "testing.trace_status" and item["operator"] in {"in", "eq"}:
            values = {str(value) for value in item["values"]}
            if values != {"Untraced"}:
                raise SemanticQueryError("SEMANTIC_TRACE_STATUS_UNSUPPORTED")
            trace_status = "Untraced"
        else:
            raise SemanticQueryError(f"SEMANTIC_DIMENSION_NOT_EXECUTABLE:{item['dimensionId']}")
    trace = provider(query_params)
    rows = [dict(row) for row in trace.get("gap_rows" if trace_status == "Untraced" else "traceability_chain_rows", [])]
    if "teams" in query_params:
        allowed_teams = set(query_params["teams"])
        rows = [row for row in rows if str(row.get("team") or row.get("scope_team") or "") in allowed_teams]
    if "statuses" in query_params:
        allowed_statuses = {value.casefold() for value in query_params["statuses"]}
        rows = [row for row in rows if str(row.get("run_status") or "").casefold() in allowed_statuses]
    if "aidas" in query_params:
        allowed_aidas = set(query_params["aidas"])
        rows = [
            row
            for row in rows
            if allowed_aidas
            & {
                value.strip()
                for field in ("epic_ids", "feature_ids", "story_ids")
                for value in str(row.get(field) or "").split(",")
                if value.strip()
            }
        ]
    if query["timeScopes"]:
        primary = next((scope for scope in query["timeScopes"] if scope["role"] == "primary"), query["timeScopes"][0])
        if primary["fieldId"] != "time.test_finished_date":
            raise SemanticQueryError(f"SEMANTIC_TIME_FIELD_NOT_EXECUTABLE:{primary['fieldId']}")
        if rows and not any(str(row.get("run_finished") or "").strip() for row in rows):
            raise SemanticQueryError("SEMANTIC_SOURCE_FIELD_UNAVAILABLE:time.test_finished_date", status_code=422)
        start = date.fromisoformat(primary["start"])
        end = date.fromisoformat(primary["end"])
        scoped_rows: list[dict[str, Any]] = []
        for row in rows:
            finished_date = _source_date(row.get("run_finished"))
            if finished_date is None:
                continue
            if start <= finished_date <= end:
                scoped_rows.append(row)
        rows = scoped_rows
    data = rows[: query["limit"]]
    summary = dict(trace.get("summary", {}))
    summary["rowCount"] = len(rows)
    revision = {"sourceId": "analytics.traceability", "revisionId": _stable_hash(trace), "status": "unpinned", "asOf": datetime.now(timezone.utc).isoformat(), "ingestionWatermark": "unknown"}
    return data, summary, revision, []


def _trace_lineage_path(query: dict[str, Any], catalog: OntologyCatalog) -> list[dict[str, Any]]:
    entity_ids = set(query["entityIds"])
    relationships_by_id = {str(relationship.get("id") or ""): relationship for relationship in catalog.bundle.get("relationships", [])}
    path: list[dict[str, Any]] = []
    for source_entity, target_entity, relationship_id in TRACE_LINEAGE_RELATIONSHIPS:
        if source_entity not in entity_ids or target_entity not in entity_ids:
            continue
        relationship = relationships_by_id.get(relationship_id)
        connects_entities = relationship and (
            (relationship.get("sourceEntity") == source_entity and relationship.get("targetEntity") == target_entity)
            or (
                relationship.get("reversible") is True
                and relationship.get("sourceEntity") == target_entity
                and relationship.get("targetEntity") == source_entity
            )
        )
        if not connects_entities or relationship.get("governance", {}).get("status") != "approved":
            raise SemanticQueryError(f"SEMANTIC_UNSUPPORTED_JOIN:{source_entity}:{target_entity}", status_code=422)
        path.append(relationship)
    unbounded = next(
        (
            relationship
            for relationship in path
            if relationship.get("cardinality") == "many_to_many" and not relationship.get("explosionPolicy")
        ),
        None,
    )
    if unbounded is not None:
        raise SemanticQueryError(f"SEMANTIC_UNBOUNDED_CARDINALITY:{unbounded['id']}", status_code=422)
    return path


def _trace_lineage_payload(
    query: dict[str, Any],
    catalog: OntologyCatalog,
    data: list[dict[str, Any]],
    revision: dict[str, Any],
) -> dict[str, Any]:
    path = _trace_lineage_path(query, catalog)
    relationship_ids = [str(relationship["id"]) for relationship in path]
    return {
        "path": [
            {
                "id": str(relationship["id"]),
                "predicate": str(relationship["predicate"]),
                "sourceEntity": str(relationship["sourceEntity"]),
                "targetEntity": str(relationship["targetEntity"]),
                "cardinality": str(relationship["cardinality"]),
                "joinPath": list(relationship["allowedJoinPaths"][0]),
                **({"explosionPolicy": str(relationship["explosionPolicy"])} if relationship.get("explosionPolicy") else {}),
            }
            for relationship in path
        ],
        "sourceRevision": revision,
        "evidence": {
            "rowCount": len(data),
            "rowIndexes": list(range(len(data))),
            "relationshipIds": relationship_ids,
        },
    }


def _redact_sensitive_dimensions(
    data: list[dict[str, Any]],
    query: dict[str, Any],
    actor_scope: dict[str, Any],
    catalog: OntologyCatalog,
) -> tuple[list[dict[str, Any]], list[str], str]:
    if "raw:confidential" in actor_scope["sensitiveFieldPolicyIds"]:
        return data, [], "not_required"
    entities = {str(item["id"]): item for item in catalog.bundle["entities"]}
    redaction_policy = _catalog_policy(catalog, "sensitive.property.redaction")
    sensitive_levels = set(redaction_policy.get("sensitivityLevels", []))
    if _query_operation(query) not in set(redaction_policy["allowedOperations"]):
        raise SemanticQueryError("SEMANTIC_REDACTION_OPERATION_DENIED", status_code=403)
    confidential_dimensions: set[str] = set()
    for dimension_id in query["dimensionIds"]:
        dimension = _catalog_dimension(catalog, dimension_id)
        entity = entities.get(str(dimension["entityId"]))
        prop = next((item for item in entity.get("properties", []) if item["id"] == dimension["propertyId"]), None) if entity else None
        if prop and prop.get("sensitivity") in sensitive_levels:
            confidential_dimensions.add(dimension_id)
    if not confidential_dimensions:
        return data, [], "not_required"
    redacted: list[dict[str, Any]] = []
    for row in data:
        safe_row = dict(row)
        for dimension_id in confidential_dimensions:
            raw_value = str(safe_row.get(dimension_id) or "")
            if raw_value:
                digest = hashlib.sha256(f"{actor_scope['actorId']}:{dimension_id}:{raw_value}".encode("utf-8")).hexdigest()[:12]
                safe_row[dimension_id] = f"pseudonym-{digest}"
        redacted.append(safe_row)
    warnings = [f"SENSITIVE_FIELD_PSEUDONYMIZED:{dimension_id}" for dimension_id in sorted(confidential_dimensions)]
    return redacted, warnings, "applied"


def execute_semantic_query(
    payload: dict[str, Any],
    *,
    catalog: OntologyCatalog,
    defect_provider: Callable[[dict[str, Any]], dict[str, Any]] = _defect_provider,
    run_provider: Callable[[], list[dict[str, Any]]] = list_runs,
    testcase_provider: Callable[[], list[dict[str, Any]]] = list_testcases,
    trace_provider: Callable[[Any], dict[str, Any]] = _trace_provider,
    analysis_store: SemanticAnalysisStore | None = None,
    now: Callable[[], datetime] | None = None,
) -> dict[str, Any]:
    query, actor_scope, business_rule_codes = _validate_request(payload, catalog)
    metric_ids = set(query["metricIds"])
    if query["intent"] == "trace":
        data, summary, revision, warnings = _execute_traceability(query, trace_provider)
    elif metric_ids and metric_ids.issubset(DEFECT_METRICS):
        data, summary, revision, warnings = _execute_defects(query, defect_provider)
    elif metric_ids and metric_ids.issubset(TEST_RUN_METRICS):
        data, summary, revision, warnings = _execute_test_runs(query, run_provider)
    elif metric_ids and metric_ids.issubset(TESTCASE_METRICS):
        data, summary, revision, warnings = _execute_testcases(query, testcase_provider)
    else:
        raise SemanticQueryError("SEMANTIC_METRIC_SET_NOT_EXECUTABLE")

    data, redaction_warnings, redaction_status = _redact_sensitive_dimensions(data, query, actor_scope, catalog)
    warnings = [*warnings, *_source_freshness_warnings(revision, catalog, now=now() if now else None), *redaction_warnings]

    row_count = int(summary.get("rowCount", len(data)) or 0)
    has_missing_warning = any("MISSING" in warning or "UNAVAILABLE" in warning for warning in warnings)
    missingness = "zero" if row_count == 0 and metric_ids else "missing" if has_missing_warning and row_count > 0 else "not_applicable"
    result = {
        "schemaVersion": "1.0",
        "queryId": str(payload["queryId"]),
        "ontologyVersion": catalog.version,
        "schemaFingerprint": catalog.fingerprint,
        "sourceRevision": revision,
        "scope": {
            "actorScopeHash": actor_scope["scopeHash"],
            "filters": query["filters"],
            "timeScopes": query["timeScopes"],
            "grain": [_catalog_metric(catalog, metric_id)["grain"] for metric_id in query["metricIds"]],
        },
        "data": data,
        "summary": summary,
        "quality": {
            "completeness": "partial" if warnings else "complete",
            "missingness": missingness,
            "truncated": len(data) >= query["limit"],
            "warnings": warnings,
            "redactionStatus": redaction_status,
        },
        "businessRules": {"applied": business_rule_codes},
    }
    if analysis_store is not None and query["intent"] != "trace":
        evidence = {
            "kind": "semantic_metric_result",
            "sourceRevisionId": str(revision.get("revisionId") or ""),
            "rowCount": row_count,
            "metricValues": dict(summary.get("metrics", {})),
            "groupRows": data,
        }
        analysis_ref = analysis_store.create(
            actor_scope_hash=actor_scope["scopeHash"],
            ontology_version=catalog.version,
            schema_fingerprint=catalog.fingerprint,
            query=query,
            source_revision=revision,
            evidence=evidence,
        )
        evidence = {**evidence, "analysisRef": analysis_ref}
        result["analysisRef"] = analysis_ref
        result["evidence"] = evidence
    if query["intent"] == "trace":
        result["lineage"] = _trace_lineage_payload(query, catalog, data, revision)
    return result


def _analysis_record_or_error(
    analysis_store: SemanticAnalysisStore,
    analysis_ref: str,
    actor_scope_hash: str,
) -> dict[str, Any]:
    try:
        return analysis_store.load(analysis_ref, actor_scope_hash=actor_scope_hash)
    except AnalysisRefScopeDenied as exc:
        raise SemanticQueryError(str(exc), status_code=403) from exc
    except AnalysisRefExpired as exc:
        raise SemanticQueryError(str(exc), status_code=410) from exc
    except AnalysisRefNotFound as exc:
        raise SemanticQueryError(str(exc), status_code=404) from exc


def _validate_record_request(
    payload: dict[str, Any],
    catalog: OntologyCatalog,
    analysis_store: SemanticAnalysisStore | None,
) -> tuple[dict[str, Any], dict[str, Any], list[str], int, int, str | None, dict[str, Any] | None, list[str]]:
    if not isinstance(payload, dict):
        raise SemanticQueryError("SEMANTIC_RECORD_REQUEST_OBJECT_REQUIRED")
    _assert_exact_keys(
        payload,
        allowed={
            "schemaVersion", "queryId", "ontologyVersion", "schemaFingerprint", "query",
            "analysisRef", "actorScope", "selections", "fields", "page", "pageSize",
        },
        required={
            "schemaVersion", "queryId", "ontologyVersion", "schemaFingerprint", "query",
            "analysisRef", "actorScope", "selections", "fields", "page", "pageSize",
        },
        label="RECORD_REQUEST",
    )
    if payload["schemaVersion"] != "1.0":
        raise SemanticQueryError("SEMANTIC_RECORD_REQUEST_VERSION_INVALID")
    _require_string(payload["queryId"], "RECORD_QUERY_ID")
    if payload["ontologyVersion"] != catalog.version or payload["schemaFingerprint"] != catalog.fingerprint:
        raise SemanticQueryError("SEMANTIC_ONTOLOGY_VERSION_MISMATCH", status_code=409)
    actor_scope = payload["actorScope"]
    if not isinstance(actor_scope, dict):
        raise SemanticQueryError("SEMANTIC_ACTOR_SCOPE_OBJECT_REQUIRED")
    scope_hash = str(actor_scope.get("scopeHash") or "")
    query_value = payload["query"]
    analysis_ref = str(payload["analysisRef"] or "").strip() or None
    if (isinstance(query_value, dict)) == bool(analysis_ref):
        raise SemanticQueryError("SEMANTIC_RECORD_QUERY_OR_ANALYSIS_REF_REQUIRED")
    if analysis_ref and analysis_store is None:
        raise SemanticQueryError("SEMANTIC_ANALYSIS_STORE_REQUIRED", status_code=503)

    stored: dict[str, Any] | None = None
    if analysis_ref:
        stored = _analysis_record_or_error(analysis_store, analysis_ref, scope_hash)
        if stored["ontology_version"] != catalog.version or stored["schema_fingerprint"] != catalog.fingerprint:
            raise SemanticQueryError("SEMANTIC_ANALYSIS_ONTOLOGY_STALE", status_code=409)
        base_query = stored["query"]
    else:
        base_query = query_value
        if base_query.get("intent") not in {"list", "drilldown"}:
            raise SemanticQueryError("SEMANTIC_RECORD_INTENT_REQUIRED")

    selections = payload["selections"]
    if not isinstance(selections, list):
        raise SemanticQueryError("SEMANTIC_RECORD_SELECTIONS_ARRAY_REQUIRED")
    selection_filters: list[dict[str, Any]] = []
    for selection in selections:
        if not isinstance(selection, dict):
            raise SemanticQueryError("SEMANTIC_RECORD_SELECTION_OBJECT_REQUIRED")
        _assert_exact_keys(
            selection,
            allowed={"dimensionId", "operator", "values"},
            required={"dimensionId", "operator", "values"},
            label="RECORD_SELECTION",
        )
        dimension_id = _require_string(selection["dimensionId"], "RECORD_SELECTION_DIMENSION")
        if dimension_id not in base_query.get("dimensionIds", []):
            raise SemanticQueryError(f"SEMANTIC_RECORD_SELECTION_NOT_IN_ANALYSIS:{dimension_id}")
        if selection["operator"] not in {"in", "eq"}:
            raise SemanticQueryError("SEMANTIC_RECORD_SELECTION_OPERATOR_INVALID")
        if not isinstance(selection["values"], list) or not selection["values"]:
            raise SemanticQueryError("SEMANTIC_RECORD_SELECTION_VALUES_REQUIRED")
        selection_filters.append({
            "dimensionId": dimension_id,
            "operator": selection["operator"],
            "values": selection["values"],
            "source": "context",
        })

    derived_query = {
        **base_query,
        "intent": "drilldown",
        "filters": [*base_query.get("filters", []), *selection_filters],
        "comparison": None,
        "sort": [],
    }
    validated_query, validated_scope, business_rule_codes = _validate_request(
        {
            "schemaVersion": "1.0",
            "queryId": payload["queryId"],
            "ontologyVersion": catalog.version,
            "schemaFingerprint": catalog.fingerprint,
            "query": derived_query,
            "actorScope": actor_scope,
        },
        catalog,
    )
    if len(validated_query["entityIds"]) != 1:
        raise SemanticQueryError("SEMANTIC_RECORD_SINGLE_ENTITY_REQUIRED")

    fields = _require_string_list(payload["fields"], "RECORD_FIELDS")
    if not fields or len(fields) > 20:
        raise SemanticQueryError("SEMANTIC_RECORD_FIELDS_INVALID")
    page = payload["page"]
    page_size = payload["pageSize"]
    maximum = int(_catalog_constraint(catalog, "query.max_limit")["parameters"]["maximum"])
    if not isinstance(page, int) or page < 1:
        raise SemanticQueryError("SEMANTIC_RECORD_PAGE_INVALID")
    if not isinstance(page_size, int) or page_size < 1 or page_size > maximum:
        raise SemanticQueryError("SEMANTIC_RECORD_PAGE_SIZE_INVALID")
    return validated_query, validated_scope, fields, page, page_size, analysis_ref, stored, business_rule_codes


def _record_revision(
    query: dict[str, Any],
    *,
    defect_provider: Callable[[dict[str, Any]], dict[str, Any]],
    run_provider: Callable[[], list[dict[str, Any]]],
    testcase_provider: Callable[[], list[dict[str, Any]]],
    requested_revision_id: str = "",
) -> tuple[list[dict[str, Any]], dict[str, Any], list[str], dict[str, str]]:
    entity_id = query["entityIds"][0]
    warnings: list[str] = []
    if entity_id == "quality.defect":
        kwargs = _defect_provider_kwargs(query)
        if requested_revision_id:
            kwargs["snapshot_version"] = requested_revision_id
        payload = defect_provider(kwargs)
        source_rows = [dict(row) for row in payload.get("ticket_rows", [])]
        rows = _apply_filters(source_rows, query["filters"], DEFECT_DIMENSION_FIELDS)
        rows, field_map = _apply_time_scopes(rows, query["timeScopes"], DEFECT_DIMENSION_FIELDS, None)
        revision_id = str(payload.get("snapshot_version") or _stable_hash(payload.get("generated_from", {})))
        revision = {
            "sourceId": "analytics.full_picture_defects",
            "revisionId": revision_id,
            "status": "pinned" if payload.get("snapshot_version") else "unpinned",
            "asOf": datetime.now(timezone.utc).isoformat(),
            "ingestionWatermark": str(payload.get("generated_from", {}).get("fetched_at") or "unknown"),
        }
        return rows, revision, warnings, field_map
    if entity_id == "testing.test_run":
        source_rows = [dict(row) for row in run_provider()]
        rows = _apply_filters(source_rows, query["filters"], TEST_RUN_DIMENSION_FIELDS)
        rows, field_map = _apply_time_scopes(rows, query["timeScopes"], TEST_RUN_DIMENSION_FIELDS, None)
        revision = {
            "sourceId": "analytics.testing_coverage",
            "revisionId": _stable_hash(source_rows),
            "status": "unpinned",
            "asOf": datetime.now(timezone.utc).isoformat(),
            "ingestionWatermark": "unknown",
        }
        return rows, revision, warnings, field_map
    if entity_id == "testing.test_case":
        source_rows = [dict(row) for row in testcase_provider()]
        rows = _apply_filters(source_rows, query["filters"], TESTCASE_DIMENSION_FIELDS)
        revision = {
            "sourceId": "analytics.testing_coverage",
            "revisionId": _stable_hash(source_rows),
            "status": "unpinned",
            "asOf": datetime.now(timezone.utc).isoformat(),
            "ingestionWatermark": "unknown",
        }
        return rows, revision, warnings, TESTCASE_DIMENSION_FIELDS
    raise SemanticQueryError(f"SEMANTIC_RECORD_ENTITY_NOT_EXECUTABLE:{entity_id}")


def _record_field_projection(
    rows: list[dict[str, Any]],
    *,
    entity_id: str,
    fields: list[str],
    actor_scope: dict[str, Any],
    catalog: OntologyCatalog,
) -> tuple[list[dict[str, Any]], list[str], str]:
    field_map = RECORD_FIELD_MAPS.get(entity_id, {})
    entities = {str(item["id"]): item for item in catalog.bundle["entities"]}
    entity = entities.get(entity_id)
    properties = {str(item["id"]): item for item in entity.get("properties", [])} if entity else {}
    allowed_properties = set(actor_scope["allowedPropertyIds"])
    sensitive_policies = set(actor_scope["sensitiveFieldPolicyIds"])
    sensitive_levels = set(_catalog_policy(catalog, "sensitive.property.redaction").get("sensitivityLevels", []))
    redact_fields: set[str] = set()
    for field in fields:
        source_field = field_map.get(field)
        prop = properties.get(field)
        if source_field is None or prop is None:
            raise SemanticQueryError(f"SEMANTIC_RECORD_FIELD_DENIED:{field}", status_code=403)
        refs = {field, f"{entity_id}.{field}"}
        if allowed_properties and not (refs & allowed_properties):
            raise SemanticQueryError(f"SEMANTIC_RECORD_FIELD_DENIED:{field}", status_code=403)
        if rows and not any(source_field in row for row in rows):
            raise SemanticQueryError(f"SEMANTIC_RECORD_SOURCE_FIELD_UNAVAILABLE:{field}", status_code=422)
        if prop.get("sensitivity") in sensitive_levels and "raw:confidential" not in sensitive_policies:
            if "pseudonymize:confidential" not in sensitive_policies or (allowed_properties and not (refs & allowed_properties)):
                raise SemanticQueryError(f"SEMANTIC_SENSITIVE_FIELD_DENIED:{field}", status_code=403)
            redact_fields.add(field)

    projected: list[dict[str, Any]] = []
    for row in rows:
        item: dict[str, Any] = {}
        for field in fields:
            value = row.get(field_map[field])
            if field in redact_fields and value not in {None, ""}:
                digest = hashlib.sha256(f"{actor_scope['actorId']}:{entity_id}:{field}:{value}".encode("utf-8")).hexdigest()[:12]
                value = f"pseudonym-{digest}"
            item[field] = value
        projected.append(item)
    warnings = [f"SENSITIVE_FIELD_PSEUDONYMIZED:{field}" for field in sorted(redact_fields)]
    return projected, warnings, "applied" if redact_fields else "not_required"


def execute_semantic_records(
    payload: dict[str, Any],
    *,
    catalog: OntologyCatalog,
    analysis_store: SemanticAnalysisStore | None = None,
    defect_provider: Callable[[dict[str, Any]], dict[str, Any]] = _defect_provider,
    run_provider: Callable[[], list[dict[str, Any]]] = list_runs,
    testcase_provider: Callable[[], list[dict[str, Any]]] = list_testcases,
    now: Callable[[], datetime] | None = None,
) -> dict[str, Any]:
    query, actor_scope, fields, page, page_size, analysis_ref, stored, business_rule_codes = _validate_record_request(
        payload,
        catalog,
        analysis_store,
    )
    entity_id = query["entityIds"][0]
    _record_field_projection(
        [],
        entity_id=entity_id,
        fields=fields,
        actor_scope=actor_scope,
        catalog=catalog,
    )
    expected_revision = str(stored.get("source_revision", {}).get("revisionId") or "") if stored else ""
    rows, revision, warnings, _dimension_field_map = _record_revision(
        query,
        defect_provider=defect_provider,
        run_provider=run_provider,
        testcase_provider=testcase_provider,
        requested_revision_id=expected_revision,
    )
    if expected_revision and str(revision.get("revisionId") or "") != expected_revision:
        raise SemanticQueryError("SEMANTIC_ANALYSIS_REVISION_STALE", status_code=409)

    source_identifier, _output_identifier = RECORD_IDENTIFIERS[entity_id]
    distinct = {str(row.get(source_identifier) or ""): row for row in rows if str(row.get(source_identifier) or "")}
    ordered_rows = [distinct[key] for key in sorted(distinct)]
    total_rows = len(ordered_rows)
    total_pages = max((total_rows + page_size - 1) // page_size, 1)
    start = (page - 1) * page_size
    page_rows = ordered_rows[start : start + page_size]
    data, redaction_warnings, redaction_status = _record_field_projection(
        page_rows,
        entity_id=entity_id,
        fields=fields,
        actor_scope=actor_scope,
        catalog=catalog,
    )
    warnings = [*warnings, *_source_freshness_warnings(revision, catalog, now=now() if now else None), *redaction_warnings]
    evidence_seed = {
        "kind": "semantic_record_set",
        "sourceRevisionId": str(revision.get("revisionId") or ""),
        "rowCount": len(data),
        "totalRows": total_rows,
        "fieldIds": fields,
    }
    if analysis_ref is None:
        if analysis_store is None:
            raise SemanticQueryError("SEMANTIC_ANALYSIS_STORE_REQUIRED", status_code=503)
        analysis_ref = analysis_store.create(
            actor_scope_hash=actor_scope["scopeHash"],
            ontology_version=catalog.version,
            schema_fingerprint=catalog.fingerprint,
            query=query,
            source_revision=revision,
            evidence=evidence_seed,
        )
    evidence = {**evidence_seed, "analysisRef": analysis_ref}
    return {
        "schemaVersion": "1.0",
        "queryId": str(payload["queryId"]),
        "ontologyVersion": catalog.version,
        "schemaFingerprint": catalog.fingerprint,
        "analysisRef": analysis_ref,
        "sourceRevision": revision,
        "scope": {
            "actorScopeHash": actor_scope["scopeHash"],
            "filters": query["filters"],
            "timeScopes": query["timeScopes"],
            "entityId": entity_id,
        },
        "data": data,
        "pagination": {"page": page, "pageSize": page_size, "totalRows": total_rows, "totalPages": total_pages},
        "quality": {
            "completeness": "partial" if warnings else "complete",
            "missingness": "zero" if total_rows == 0 else "not_applicable",
            "truncated": start + len(data) < total_rows,
            "warnings": warnings,
            "redactionStatus": redaction_status,
        },
        "businessRules": {"applied": business_rule_codes},
        "evidence": evidence,
    }
