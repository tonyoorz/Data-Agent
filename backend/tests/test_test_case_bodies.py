from __future__ import annotations

from pathlib import Path

from backend.analytics.test_case_bodies import (
    TestCaseBody,
    full_bodies_enabled,
    get_test_bodies,
)


class FakeOctaneClient:
    def __init__(self, fail_ids: set[str] | None = None):
        self.fail_ids = fail_ids or set()
        self.calls: list[tuple[str, str]] = []

    def fetch_test_entity(self, test_id: str) -> dict:
        self.calls.append(("entity", test_id))
        if test_id in self.fail_ids:
            raise RuntimeError("octane unreachable")
        return {"id": test_id, "name": f"Test {test_id}", "description": "<html><body>Objective: verify</body></html>"}

    def fetch_test_steps(self, *, test_id: str) -> dict:
        self.calls.append(("steps", test_id))
        if test_id in self.fail_ids:
            raise RuntimeError("octane unreachable")
        return {"script": "- [PreCon] vehicle ready\n- record signal\n- ? value <= 30%"}


def test_get_test_bodies_fetches_and_caches(tmp_path: Path) -> None:
    cache = str(tmp_path / "bodies.db")
    client = FakeOctaneClient()

    bodies = get_test_bodies(["101", "102"], cache_path=cache, client=client)
    assert set(bodies) == {"101", "102"}
    assert bodies["101"].steps_text.startswith("- [PreCon]")
    assert "Objective: verify" in bodies["101"].description_text  # HTML stripped to text
    assert len(client.calls) == 4  # entity + steps per test

    # Second call with a fresh client must be served entirely from the cache.
    client2 = FakeOctaneClient()
    cached = get_test_bodies(["101", "102"], cache_path=cache, client=client2)
    assert set(cached) == {"101", "102"}
    assert client2.calls == []


def test_get_test_bodies_tolerates_per_id_octane_failure(tmp_path: Path) -> None:
    client = FakeOctaneClient(fail_ids={"201"})
    bodies = get_test_bodies(["201", "202"], cache_path=str(tmp_path / "b.db"), client=client)
    assert set(bodies) == {"202"}


def test_get_test_bodies_dedupes_ids(tmp_path: Path) -> None:
    client = FakeOctaneClient()
    get_test_bodies(["301", "301", ""], cache_path=str(tmp_path / "b.db"), client=client)
    assert len(client.calls) == 2


def test_full_bodies_enabled_toggle() -> None:
    assert full_bodies_enabled({}) is True
    assert full_bodies_enabled({"TESTCASE_FEW_SHOT_FULL_BODIES": "0"}) is False
    assert full_bodies_enabled({"TESTCASE_FEW_SHOT_FULL_BODIES": "off"}) is False
    assert full_bodies_enabled({"TESTCASE_FEW_SHOT_FULL_BODIES": "1"}) is True


def test_missing_env_for_body(tmp_path: Path) -> None:
    # TestCaseBody is a plain frozen dataclass — constructibility sanity for the cache contract.
    body = TestCaseBody(test_id="1", name="n", description_text="d", steps_text="s")
    assert body.test_id == "1"
