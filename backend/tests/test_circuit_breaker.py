from __future__ import annotations

import pytest

from backend.analytics.circuit_breaker import CircuitBreaker, CircuitOpenError


def test_transport_failures_respect_configured_threshold() -> None:
    breaker = CircuitBreaker(
        service="octane",
        failure_threshold=3,
        reset_timeout_s=60,
        is_failure=lambda error, _result: error is not None,
    )

    for expected_count in (1, 2):
        with pytest.raises(TimeoutError):
            breaker.call(lambda: (_ for _ in ()).throw(TimeoutError("upstream timeout")))
        assert breaker.get_state() | {"lastFailureAt": 0} == {
            "service": "octane",
            "state": "closed",
            "failureCount": expected_count,
            "lastFailureAt": 0,
        }

    with pytest.raises(TimeoutError):
        breaker.call(lambda: (_ for _ in ()).throw(TimeoutError("upstream timeout")))
    assert breaker.get_state()["state"] == "open"
    assert breaker.get_state()["failureCount"] == 3

    with pytest.raises(CircuitOpenError):
        breaker.call(lambda: "must not execute")


def test_success_before_threshold_resets_failure_count() -> None:
    breaker = CircuitBreaker(service="octane", failure_threshold=2)
    with pytest.raises(RuntimeError):
        breaker.call(lambda: (_ for _ in ()).throw(RuntimeError("temporary")))
    assert breaker.get_state()["failureCount"] == 1

    assert breaker.call(lambda: "ok") == "ok"
    assert breaker.get_state()["state"] == "closed"
    assert breaker.get_state()["failureCount"] == 0
