from __future__ import annotations

from collections.abc import Iterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse

from backend.analytics.config import get_analytics_db_path
from backend.analytics.read_models import (
    FullPictureDashboardDataError,
    build_defect_test_correlation,
    build_filter_metadata,
    build_full_picture_payload,
    build_testing_summary,
    list_runs,
    list_testcases,
)
from backend.analytics.testing_coverage_models import (
    TestingCoverageDataNotReadyError,
    build_aida_status_rows,
    build_project_status_rows,
    build_testing_coverage_filters,
    build_testcase_detail_rows,
)
from backend.analytics.schema import ensure_schema


@asynccontextmanager
async def analytics_lifespan(_app: FastAPI) -> Iterator[None]:
    ensure_schema(get_analytics_db_path())
    yield


app = FastAPI(title="Vizion Analytics API", lifespan=analytics_lifespan)


@app.get("/health")
def health() -> dict[str, object]:
    return {"ok": True, "service": "analytics"}


@app.get("/api/full-picture/dashboard")
def full_picture_dashboard(request: Request) -> JSONResponse:
    try:
        payload = build_full_picture_payload(**dict(request.query_params))
    except FullPictureDashboardDataError:
        return JSONResponse(
            status_code=503,
            content={"error": "analytics database not initialized"},
        )
    return JSONResponse(status_code=200, content=payload)


@app.get("/api/testing/summary")
def testing_summary() -> dict[str, int]:
    return build_testing_summary()


@app.get("/api/testing/testcases")
def testing_testcases() -> list[dict[str, object]]:
    return list_testcases()


@app.get("/api/testing/runs")
def testing_runs() -> list[dict[str, object]]:
    return list_runs()


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


@app.get("/api/metadata/filters")
def metadata_filters() -> dict[str, list[str]]:
    return build_filter_metadata()


@app.get("/api/correlation/defect-test")
def defect_test_correlation(defect_id: str = Query(...)) -> dict[str, object]:
    return build_defect_test_correlation(defect_id)