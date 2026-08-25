"""Minimal dependency-free circuit breaker for outbound calls (Octane, etc.).

Symmetric with server/circuitBreaker.mjs on the Node side. Used by the Octane
client so a sustained upstream outage fast-fails ingest instead of every caller
paying the full timeout budget. States: closed -> open -> half-open.

Failure accounting: thrown errors count when ``is_failure(err, None)`` is true;
non-throwing results count when ``is_failure(None, result)`` is true (e.g. an HTTP
5xx response). The result is always returned to the caller unchanged so the
existing raise_for_status() diagnostics keep working.
"""
from __future__ import annotations

import time
from typing import Any, Callable, Optional


class CircuitOpenError(Exception):
    """Raised when the breaker is open and a call is fast-failed."""

    def __init__(self, message: str, *, service: str = "unknown") -> None:
        super().__init__(message)
        self.service = service
        self.circuit_open = True


def _status_from(obj: Any) -> Optional[int]:
    status = getattr(obj, "status_code", None)
    if isinstance(status, int):
        return status
    response = getattr(obj, "response", None)
    status = getattr(response, "status_code", None)
    return status if isinstance(status, int) else None


def is_http_failure(error: Optional[BaseException], result: Any) -> bool:
    """Default is_failure predicate for HTTP clients.

    Counts transport errors (thrown) and 5xx/408/429 responses. A 4xx response or
    a 4xx HTTPError (raised by raise_for_status) does NOT count: those are request
    errors, not evidence the upstream is down.
    """
    if error is not None:
        status = _status_from(error)
        if status is not None and 400 <= status < 500 and status not in (408, 429):
            return False
        return True
    status = _status_from(result)
    if status is None:
        return False
    return status == 408 or status == 429 or status >= 500


class CircuitBreaker:
    def __init__(
        self,
        *,
        service: str = "unknown",
        failure_threshold: int = 5,
        reset_timeout_s: float = 30.0,
        half_open_max_calls: int = 1,
        is_failure: Optional[Callable[[Optional[BaseException], Any], bool]] = None,
    ) -> None:
        self.service = service
        self.failure_threshold = max(1, int(failure_threshold))
        self.reset_timeout_s = max(0.0, float(reset_timeout_s))
        self.half_open_max_calls = max(1, int(half_open_max_calls))
        self._is_failure = is_failure or (lambda error, result: error is not None)
        self._state = "closed"
        self._failure_count = 0
        self._last_failure_at = 0.0
        self._half_open_inflight = 0

    def _maybe_half_open(self) -> None:
        if self._state == "open" and time.monotonic() - self._last_failure_at >= self.reset_timeout_s:
            self._state = "half-open"
            self._half_open_inflight = 0

    def _record_failure(self) -> None:
        self._failure_count += 1
        self._last_failure_at = time.monotonic()
        if self._failure_count >= self.failure_threshold:
            self._state = "open"

    def _record_success(self) -> None:
        self._state = "closed"
        self._failure_count = 0
        self._half_open_inflight = 0

    def call(self, fn: Callable[[], Any]) -> Any:
        self._maybe_half_open()
        if self._state == "open":
            raise CircuitOpenError(
                f"{self.service} circuit open (failures={self._failure_count})",
                service=self.service,
            )
        if self._state == "half-open" and self._half_open_inflight >= self.half_open_max_calls:
            raise CircuitOpenError(
                f"{self.service} circuit half-open throttled",
                service=self.service,
            )
        if self._state == "half-open":
            self._half_open_inflight += 1
        was_half_open = self._state == "half-open"
        try:
            result = fn()
        except Exception as err:
            failed = bool(self._is_failure(err, None))
            if failed:
                if was_half_open:
                    self._state = "open"
                    self._last_failure_at = time.monotonic()
                else:
                    self._record_failure()
            self._half_open_inflight = 0
            raise
        failed = bool(self._is_failure(None, result))
        if self._state == "half-open":
            if failed:
                self._state = "open"
                self._last_failure_at = time.monotonic()
            else:
                self._record_success()
            self._half_open_inflight = 0
        elif failed:
            self._record_failure()
        else:
            self._record_success()
        return result

    def get_state(self) -> dict[str, Any]:
        return {
            "service": self.service,
            "state": self._state,
            "failureCount": self._failure_count,
            "lastFailureAt": self._last_failure_at,
        }
