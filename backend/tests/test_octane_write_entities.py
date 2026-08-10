from __future__ import annotations

from typing import Any

from backend.analytics.ingest.client import OctaneApiClient
from backend.analytics.test_case_builder import build_test_case_description, build_test_steps_script, OCTANE_WORK_ITEM_URL


class FakeResponse:
    def __init__(self, payload: dict[str, Any], status_code: int = 201) -> None:
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> dict[str, Any]:
        return self._payload


class FakeSession:
    """Captures POST/PUT/GET calls; resolves XSRF_COOKIE from the Cookie header (like the real session)."""

    def __init__(self) -> None:
        self.headers = {"Cookie": "JSESSIONID=session-1; XSRF_COOKIE=csrf-1"}
        self.post_calls: list[dict[str, Any]] = []
        self.put_calls: list[dict[str, Any]] = []
        self.get_calls: list[dict[str, Any]] = []
        # scripted GET responses keyed by url substring
        self._get_responses: dict[str, dict[str, Any]] = {}

    def post(self, url: str, *, json: dict[str, Any], headers: dict[str, str], timeout: int, verify: bool) -> FakeResponse:
        self.post_calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout, "verify": verify})
        return FakeResponse({"data": [{"id": "T-1", "type": json["data"][0].get("type", "test"), **json["data"][0]}]})

    def put(self, url: str, *, json: dict[str, Any], headers: dict[str, str], timeout: int, verify: bool) -> FakeResponse:
        self.put_calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout, "verify": verify})
        return FakeResponse({"data": [json]})

    def get(self, url: str, *, params: dict[str, Any] | None = None, timeout: int = 60, verify: bool = False) -> FakeResponse:
        self.get_calls.append({"url": url, "params": params, "timeout": timeout, "verify": verify})
        for key, payload in self._get_responses.items():
            if key in url:
                return FakeResponse(payload)
        return FakeResponse({"data": [{"id": "T-1", "name": "demo"}]})


def _client() -> tuple[OctaneApiClient, FakeSession]:
    session = FakeSession()
    client = OctaneApiClient(
        base_url="https://octane.example",
        shared_space_id="1002",
        workspace_id="2001",
        session=session,  # type: ignore[arg-type]
    )
    return client, session


def test_create_entity_posts_with_xsrf_header_and_data_envelope() -> None:
    client, session = _client()

    result = client.create_entity(
        collection="tests",
        entity_type="test",
        fields={"subtype": "test_manual", "name": "demo test"},
    )

    assert result["id"] == "T-1"
    assert session.post_calls == [
        {
            "url": "https://octane.example/api/shared_spaces/1002/workspaces/2001/tests",
            "json": {"data": [{"type": "test", "subtype": "test_manual", "name": "demo test"}]},
            "headers": {"XSRF-HEADER": "csrf-1"},
            "timeout": 60,
            "verify": False,
        }
    ]


def test_create_entity_raises_without_xsrf_cookie() -> None:
    session = FakeSession()
    session.headers = {"Cookie": "JSESSIONID=session-1"}  # no XSRF_COOKIE
    client = OctaneApiClient(
        base_url="https://octane.example",
        shared_space_id="1002",
        workspace_id="2001",
        session=session,  # type: ignore[arg-type]
    )
    try:
        client.create_entity(collection="tests", entity_type="test", fields={"name": "x"})
    except ValueError as exc:
        assert "XSRF_COOKIE" in str(exc)
    else:
        raise AssertionError("expected ValueError when XSRF_COOKIE is missing")


def test_update_entity_uses_bare_entity_body_not_data_envelope() -> None:
    client, session = _client()

    client.update_entity(
        collection="tests",
        entity_id="1875073",
        entity_type="test",
        fields={"description": "<html><body>updated</body></html>"},
    )

    # PUT body is the entity object directly (no {"data": [...]} wrapper)
    assert session.put_calls == [
        {
            "url": "https://octane.example/api/shared_spaces/1002/workspaces/2001/tests/1875073",
            "json": {
                "type": "test",
                "id": "1875073",
                "description": "<html><body>updated</body></html>",
            },
            "headers": {"XSRF-HEADER": "csrf-1"},
            "timeout": 60,
            "verify": False,
        }
    ]


def test_create_test_case_links_covered_content_and_required_fields() -> None:
    client, session = _client()

    result = client.create_test_case(
        name="[IDCEVO] demo regression test",
        description_html="<html><body>desc</body></html>",
        owner_workspace_user_id="500026",
        servicepack_node_id="d1598r3mjrp37by4yjvy1860k",
        covered_work_item_ids=("2811042",),
    )

    assert result["id"] == "T-1"
    posted = session.post_calls[0]
    assert posted["url"].endswith("/tests")
    entity = posted["json"]["data"][0]
    assert entity["type"] == "test"
    assert entity["subtype"] == "test_manual"
    assert entity["name"] == "[IDCEVO] demo regression test"
    assert entity["phase"] == {"type": "phase", "id": "phase.test_manual.new"}
    assert entity["owner"] == {"type": "workspace_user", "id": "500026"}
    assert entity["servicepack_udf"] == {"data": [{"type": "list_node", "id": "d1598r3mjrp37by4yjvy1860k"}]}
    assert entity["covered_content"] == {"data": [{"type": "work_item", "id": "2811042"}]}


def test_create_test_case_omits_covered_content_when_empty() -> None:
    client, session = _client()

    client.create_test_case(
        name="standalone test",
        description_html="<html><body>x</body></html>",
        owner_workspace_user_id="500026",
        servicepack_node_id="d1598r3mjrp37by4yjvy1860k",
    )

    entity = session.post_calls[0]["json"]["data"][0]
    assert "covered_content" not in entity


def test_build_test_case_description_has_ordered_sections() -> None:
    defect = {
        "defect_id": "2804379",
        "name": "pps: constant CPU load when car is moving",
        "severity": "Very High",
        "software_version": "pu2707_i420-26w32.1-1",
        "assigned_ecu": "IDCEVO-25",
        "lead_model": "U11",
    }
    desc = build_test_case_description(
        defect=defect,
        procedure_steps=["Flash baseline build", "Record CPU load", "Flash candidate build", "Compare"],
        expected=["CPU load stays within baseline", "No sudden increase"],
        preconditions=["Test vehicle ready", "Perfetto available"],
        pass_criteria="all modes within baseline",
        fail_criteria="any mode exceeds baseline",
    )

    assert desc.startswith("<html><body>")
    assert desc.endswith("</body></html>")
    # ordered: Objective before Reference before Preconditions before procedure before expected
    assert desc.index("Objective:") < desc.index("Reference:")
    assert desc.index("Reference:") < desc.index("Preconditions:")
    assert desc.index("Preconditions:") < desc.index("procedure:")
    assert desc.index("procedure:") < desc.index("expected:")
    # numbered procedure steps
    assert "1. Flash baseline build" in desc
    assert "4. Compare" in desc
    # defect link
    assert OCTANE_WORK_ITEM_URL.format(defect_id="2804379") in desc
    assert "D2804379" in desc
    # pass/fail
    assert "Pass criteria:" in desc
    assert "Fail criteria:" in desc


def test_build_test_case_description_renders_comparison_tables() -> None:
    baseline = [("Mode", "CPU"), ("IDLE", "0.21%")]
    regression = [("Mode", "CPU"), ("IDLE", "1.16%")]
    desc = build_test_case_description(
        defect={"defect_id": "1", "name": "x", "severity": "High"},
        procedure_steps=["step"],
        expected=["ok"],
        baseline_table=baseline,
        regression_table=regression,
    )
    assert "Baseline reference:" in desc
    assert "Regression observed:" in desc
    assert "<table" in desc
    assert "0.21%" in desc
    assert "1.16%" in desc


def test_write_test_steps_puts_to_script_subresource() -> None:
    client, session = _client()

    client.write_test_steps(test_id="1875073", steps_text="- [PreCon] vehicle ready\n- do thing\n- ? check result")

    # PUT goes to /tests/{id}/script with bare {"script": ...} body (no data envelope)
    assert session.put_calls == [
        {
            "url": "https://octane.example/api/shared_spaces/1002/workspaces/2001/tests/1875073/script",
            "json": {"script": "- [PreCon] vehicle ready\n- do thing\n- ? check result"},
            "headers": {"XSRF-HEADER": "csrf-1"},
            "timeout": 60,
            "verify": False,
        }
    ]


def test_write_test_steps_requires_test_id() -> None:
    client, _ = _client()
    try:
        client.write_test_steps(test_id="", steps_text="x")
    except ValueError as exc:
        assert "test_id" in str(exc)
    else:
        raise AssertionError("expected ValueError for empty test_id")


def test_fetch_test_steps_reads_script_subresource() -> None:
    client, session = _client()
    session._get_responses["/script"] = {"script": "- [PreCon] ready\n- ? check", "version_stamp": 4}

    result = client.fetch_test_steps(test_id="1875073")

    assert result["script"] == "- [PreCon] ready\n- ? check"
    assert result["version_stamp"] == 4
    assert session.get_calls[0]["url"].endswith("/tests/1875073/script")


def test_build_test_steps_script_uses_workspace_line_conventions() -> None:
    script = build_test_steps_script(
        preconditions=["vehicle ready", "Perfetto available"],
        steps=["flash baseline build", "record CPU load"],
        checkpoints=["CPU load within baseline"],
    )
    lines = script.split("\n")
    assert lines == [
        "- [PreCon] vehicle ready",
        "- [PreCon] Perfetto available",
        "- flash baseline build",
        "- record CPU load",
        "- ? CPU load within baseline",
    ]


def test_build_test_steps_script_empty_inputs_returns_empty_string() -> None:
    assert build_test_steps_script() == ""
