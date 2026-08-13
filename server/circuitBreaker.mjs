// Minimal dependency-free circuit breaker for outbound calls (model API, Octane).
//
// Why this exists: companyChat.mjs already retries individual requests, but if an
// upstream stays down, every incoming request still pays the full retry budget
// before failing. A circuit breaker trips after N consecutive failures and
// fast-fails subsequent calls (returning a degradation instead of waiting out the
// timeout), then probes with one trial call after resetTimeoutMs.
//
// States: closed (normal, count failures) -> open (fast-fail) -> half-open (one
// trial). A success in half-open closes the breaker; a failure re-opens it.
//
// Failure accounting: thrown errors always count. A non-throwing result also
// counts as a failure when isFailure(null, result) is true (e.g. HTTP 5xx): the
// result is still returned to the caller (so the existing response handling and
// diagnostics run unchanged), but the breaker tally increments and may trip on
// accumulated upstream errors.

export class CircuitOpenError extends Error {
  constructor(message, { service } = {}) {
    super(message);
    this.name = "CircuitOpenError";
    this.service = service || "unknown";
    this.circuitOpen = true;
  }
}

export function createCircuitBreaker({
  service = "unknown",
  failureThreshold = 5,
  resetTimeoutMs = 30_000,
  halfOpenMaxCalls = 1,
  // Decide whether a given call outcome counts as a breaker failure. Thrown
  // errors count by default; callers can also flag a non-throwing result (e.g.
  // an HTTP 5xx response) so the breaker trips on accumulated upstream errors
  // without the caller having to throw.
  isFailure = (error, result) => Boolean(error),
} = {}) {
  let state = "closed";
  let failureCount = 0;
  let lastFailureAt = 0;
  let halfOpenInflight = 0;

  function maybeHalfOpen() {
    if (state === "open" && Date.now() - lastFailureAt >= resetTimeoutMs) {
      state = "half-open";
      halfOpenInflight = 0;
    }
  }

  function recordFailure() {
    failureCount += 1;
    lastFailureAt = Date.now();
    if (failureCount >= failureThreshold) state = "open";
  }

  function recordSuccess() {
    state = "closed";
    failureCount = 0;
    halfOpenInflight = 0;
  }

  async function call(fn) {
    maybeHalfOpen();
    if (state === "open") {
      throw new CircuitOpenError(
        `${service} circuit open (failures=${failureCount})`,
        { service },
      );
    }
    if (state === "half-open" && halfOpenInflight >= halfOpenMaxCalls) {
      throw new CircuitOpenError(
        `${service} circuit half-open throttled`,
        { service },
      );
    }
    if (state === "half-open") halfOpenInflight += 1;

    let result;
    try {
      result = await fn();
    } catch (err) {
      // Thrown call: always a failure. In half-open this reopens immediately.
      state = "open";
      lastFailureAt = Date.now();
      halfOpenInflight = 0;
      throw err;
    }

    const failed = Boolean(isFailure(null, result));
    if (state === "half-open") {
      // Trial result decides the breaker but is always returned to the caller.
      if (failed) {
        state = "open";
        lastFailureAt = Date.now();
      } else {
        recordSuccess();
      }
      halfOpenInflight = 0;
    } else if (failed) {
      recordFailure();
    } else {
      recordSuccess();
    }
    return result;
  }

  function getState() {
    return { service, state, failureCount, lastFailureAt };
  }

  return { call, getState };
}
