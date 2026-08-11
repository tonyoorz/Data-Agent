import { resolveAnalyticsProxyTimeoutMs } from "./analyticsApiConfig.mjs";

export function createBoundedAnalyticsFetch({
  fetchImpl = globalThis.fetch,
  timeoutMs = resolveAnalyticsProxyTimeoutMs(),
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("ANALYTICS_FETCH_REQUIRED");
  }

  return (input, init = undefined) => {
    if (init?.signal) {
      return fetchImpl(input, {
        ...init,
        redirect: "error",
      });
    }
    return fetchImpl(input, {
      ...(init || {}),
      redirect: "error",
      signal: timeoutSignal(timeoutMs),
    });
  };
}

export function boundDefaultAnalyticsFetch(fetchImpl) {
  return fetchImpl === globalThis.fetch
    ? createBoundedAnalyticsFetch({ fetchImpl })
    : fetchImpl;
}
