import {
  buildAnalyticsProxyUrl,
  resolveAnalyticsApiBase,
  resolveAnalyticsProxyTimeoutMs,
} from "./analyticsApiConfig.mjs";
import { readBoundedResponseJson } from "./boundedResponseBody.mjs";

const ANALYTICS_PROXY_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

function sendUpstreamFailure(response, statusCode, errorCode) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify({
    success: false,
    error: errorCode,
  }));
}

function isTimeoutError(error) {
  return error?.name === "TimeoutError" || error?.name === "AbortError";
}

export async function proxyAnalyticsJson({
  pathname,
  searchParams,
  response,
  analyticsApiBase = resolveAnalyticsApiBase(),
  timeoutMs = resolveAnalyticsProxyTimeoutMs(),
  fetchImpl = globalThis.fetch,
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
}) {
  const analyticsUrl = buildAnalyticsProxyUrl(pathname, searchParams, analyticsApiBase);

  try {
    const analyticsResponse = await fetchImpl(analyticsUrl, {
      redirect: "error",
      signal: timeoutSignal(timeoutMs),
    });
    if (!analyticsResponse.ok) {
      try {
        await analyticsResponse?.body?.cancel?.();
      } catch {
        // Upstream response bodies are private and never cross the proxy boundary.
      }
      const safeStatus = analyticsResponse.status >= 400 && analyticsResponse.status < 500
        ? analyticsResponse.status
        : 502;
      sendUpstreamFailure(response, safeStatus, "ANALYTICS_UPSTREAM_REJECTED");
      return;
    }
    const contentType = String(analyticsResponse.headers?.get?.("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      try {
        await analyticsResponse?.body?.cancel?.();
      } catch {
        // Invalid content is discarded without disclosure.
      }
      sendUpstreamFailure(response, 502, "ANALYTICS_UPSTREAM_INVALID_RESPONSE");
      return;
    }
    const payload = await readBoundedResponseJson(analyticsResponse, {
      maxBytes: ANALYTICS_PROXY_RESPONSE_MAX_BYTES,
      errorCode: "ANALYTICS_UPSTREAM_RESPONSE_TOO_LARGE",
    });
    response.writeHead(analyticsResponse.status, {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(payload));
  } catch (error) {
    if (error?.code === "ANALYTICS_UPSTREAM_RESPONSE_TOO_LARGE") {
      sendUpstreamFailure(response, 502, "ANALYTICS_UPSTREAM_RESPONSE_TOO_LARGE");
      return;
    }
    if (isTimeoutError(error)) {
      sendUpstreamFailure(response, 504, "ANALYTICS_UPSTREAM_TIMEOUT");
      return;
    }
    sendUpstreamFailure(response, 502, "ANALYTICS_UPSTREAM_UNAVAILABLE");
  }
}
