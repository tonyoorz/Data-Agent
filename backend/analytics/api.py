from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse

from backend.analytics.config import get_analytics_db_path, get_full_picture_hot_db_path
from backend.analytics.dashboard_snapshot import read_active_snapshot_state
from backend.analytics.read_models import (
    FullPictureDashboardDataError,
    FullPictureDashboardRequestError,
    build_defect_high_frequency_analysis_payload,
    build_defect_test_correlation,
    build_filter_metadata,
    build_full_picture_payload,
    build_full_picture_summary_payload,
    build_long_runner_analysis_payload,
    build_top_issue_analysis_payload,
    build_testing_summary,
    list_full_picture_ticket_rows,
    list_runs,
    list_testcases,
)
from backend.analytics.qgate_weekly_report import build_qgate_weekly_report_payload
from backend.analytics.testing_coverage_models import (
    TestingCoverageDataNotReadyError,
    build_aida_status_rows,
    build_project_status_rows,
    build_test_team_analysis_payload,
    build_testing_coverage_filters,
    build_testcase_detail_rows,
)
from backend.analytics.traceability_models import build_traceability_analysis_payload
from backend.analytics.schema import ensure_schema


@asynccontextmanager
async def analytics_lifespan(_app: FastAPI) -> AsyncIterator[None]:
    ensure_schema(get_analytics_db_path())
    yield


app = FastAPI(title="Vizion Analytics API", lifespan=analytics_lifespan)


def _full_picture_query_params(request: Request) -> dict[str, object]:
    aggregated: dict[str, object] = {}
    for key, value in request.query_params.multi_items():
        existing = aggregated.get(key)
        if existing is None:
            aggregated[key] = value
        elif isinstance(existing, list):
            existing.append(value)
        else:
            aggregated[key] = [existing, value]
    return aggregated


@app.get("/health")
def health() -> dict[str, object]:
    return {"ok": True, "service": "analytics"}


@app.get("/api/full-picture/dashboard")
def full_picture_dashboard(request: Request) -> JSONResponse:
    try:
        payload = build_full_picture_payload(**_full_picture_query_params(request))
    except FullPictureDashboardDataError:
        return JSONResponse(
            status_code=503,
            content={"error": "analytics database not initialized"},
        )
    return JSONResponse(status_code=200, content=payload)


@app.get("/api/full-picture/dashboard/summary")
def full_picture_dashboard_summary(request: Request) -> JSONResponse:
    try:
        payload = build_full_picture_summary_payload(**_full_picture_query_params(request))
    except FullPictureDashboardDataError:
        return JSONResponse(
            status_code=503,
            content={"error": "analytics database not initialized"},
        )
    except FullPictureDashboardRequestError as exc:
        status_code = 409 if "snapshot" in str(exc).lower() else 400
        return JSONResponse(status_code=status_code, content={"error": str(exc)})
    return JSONResponse(status_code=200, content=payload)


@app.get("/api/full-picture/dashboard/tickets")
def full_picture_dashboard_tickets(request: Request) -> JSONResponse:
    try:
        payload = list_full_picture_ticket_rows(**_full_picture_query_params(request))
    except FullPictureDashboardDataError:
        return JSONResponse(
            status_code=503,
            content={"error": "analytics database not initialized"},
        )
    except FullPictureDashboardRequestError as exc:
        status_code = 409 if "snapshot" in str(exc).lower() else 400
        return JSONResponse(status_code=status_code, content={"error": str(exc)})
    return JSONResponse(status_code=200, content=payload)


@app.get("/api/full-picture/top-issue-analysis")
def full_picture_top_issue_analysis(request: Request) -> JSONResponse:
    try:
        payload = build_top_issue_analysis_payload(**_full_picture_query_params(request))
    except FullPictureDashboardDataError:
        return JSONResponse(
            status_code=503,
            content={"error": "analytics database not initialized"},
        )
    except FullPictureDashboardRequestError as exc:
        status_code = 409 if "snapshot" in str(exc).lower() else 400
        return JSONResponse(status_code=status_code, content={"error": str(exc)})
    return JSONResponse(status_code=200, content=payload)


@app.get("/api/full-picture/long-runner-analysis")
def full_picture_long_runner_analysis(request: Request) -> JSONResponse:
    try:
        payload = build_long_runner_analysis_payload(**_full_picture_query_params(request))
    except FullPictureDashboardDataError:
        return JSONResponse(
            status_code=503,
            content={"error": "analytics database not initialized"},
        )
    except FullPictureDashboardRequestError as exc:
        status_code = 409 if "snapshot" in str(exc).lower() else 400
        return JSONResponse(status_code=status_code, content={"error": str(exc)})
    return JSONResponse(status_code=200, content=payload)


@app.get("/api/full-picture/defect-high-frequency-analysis")
def full_picture_defect_high_frequency_analysis(request: Request) -> JSONResponse:
    try:
        payload = build_defect_high_frequency_analysis_payload(**_full_picture_query_params(request))
    except FullPictureDashboardDataError:
        return JSONResponse(
            status_code=503,
            content={"error": "analytics database not initialized"},
        )
    except FullPictureDashboardRequestError as exc:
        status_code = 409 if "snapshot" in str(exc).lower() else 400
        return JSONResponse(status_code=status_code, content={"error": str(exc)})
    return JSONResponse(status_code=200, content=payload)


@app.get("/api/full-picture/dashboard/refresh-status")
def full_picture_dashboard_refresh_status() -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content=read_active_snapshot_state(get_full_picture_hot_db_path()),
    )


@app.get("/api/testing/summary")
def testing_summary() -> dict[str, int]:
    return build_testing_summary()


@app.get("/api/testing/testcases")
def testing_testcases() -> list[dict[str, object]]:
    return list_testcases()


@app.get("/api/testing/runs")
def testing_runs() -> list[dict[str, object]]:
    return list_runs()


@app.get("/api/testing/team-analysis")
def testing_team_analysis(request: Request, team: str = "DTSV_China") -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content=build_test_team_analysis_payload(team, request.query_params),
    )


@app.get("/api/qgate-reports/weekly-report")
def qgate_weekly_report(year: str = "") -> JSONResponse:
    return JSONResponse(status_code=200, content=build_qgate_weekly_report_payload(year=year))


def _testing_coverage_not_ready_response(exc: TestingCoverageDataNotReadyError) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "error": "testing coverage analysis data not ready",
            "missing_fields": exc.missing_fields,
        },
    )


@app.get("/api/testing/coverage-analysis/filters")
def testing_coverage_filters(request: Request) -> JSONResponse:
    try:
        payload = build_testing_coverage_filters(request.query_params)
    except TestingCoverageDataNotReadyError as exc:
        return _testing_coverage_not_ready_response(exc)
    return JSONResponse(status_code=200, content=payload)


@app.get("/api/testing/coverage-analysis/project-status")
def testing_coverage_project_status(request: Request) -> JSONResponse:
    try:
        payload = build_project_status_rows(request.query_params)
    except TestingCoverageDataNotReadyError as exc:
        return _testing_coverage_not_ready_response(exc)
    return JSONResponse(status_code=200, content=payload)


@app.get("/api/testing/coverage-analysis/aida-status")
def testing_coverage_aida_status(request: Request) -> JSONResponse:
    try:
        payload = build_aida_status_rows(request.query_params)
    except TestingCoverageDataNotReadyError as exc:
        return _testing_coverage_not_ready_response(exc)
    return JSONResponse(status_code=200, content=payload)


@app.get("/api/testing/coverage-analysis/testcase-detail")
def testing_coverage_testcase_detail(request: Request) -> JSONResponse:
    try:
        payload = build_testcase_detail_rows(request.query_params)
    except TestingCoverageDataNotReadyError as exc:
        return _testing_coverage_not_ready_response(exc)
    return JSONResponse(status_code=200, content=payload)


@app.get("/api/testing/traceability-analysis")
def testing_traceability_analysis(request: Request) -> JSONResponse:
    return JSONResponse(status_code=200, content=build_traceability_analysis_payload(request.query_params))


@app.get("/api/metadata/filters")
def metadata_filters() -> dict[str, list[str]]:
    return build_filter_metadata()


@app.get("/api/correlation/defect-test")
def defect_test_correlation(defect_id: str = Query(...)) -> dict[str, object]:
    return build_defect_test_correlation(defect_id)