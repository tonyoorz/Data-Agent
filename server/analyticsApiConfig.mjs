const DEFAULT_ANALYTICS_API_BASE = "http://127.0.0.1:3003";
const DEFAULT_ANALYTICS_PROXY_TIMEOUT_MS = 10_000;
const MAX_ANALYTICS_PROXY_TIMEOUT_MS = 120_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function invalidAnalyticsApiBase() {
  const error = new Error("VIZION_ANALYTICS_API_BASE_INVALID");
  error.code = "VIZION_ANALYTICS_API_BASE_INVALID";
  return error;
}

function invalidAnalyticsProxyPath() {
  const error = new Error("ANALYTICS_PROXY_PATH_INVALID");
  error.code = "ANALYTICS_PROXY_PATH_INVALID";
  return error;
}

function invalidAnalyticsProxyTimeout() {
  const error = new Error("VIZION_ANALYTICS_PROXY_TIMEOUT_INVALID");
  error.code = "VIZION_ANALYTICS_PROXY_TIMEOUT_INVALID";
  return error;
}

export function resolveAnalyticsApiBase(env = process.env) {
  const explicitBase = String(env?.VIZION_ANALYTICS_API_BASE || "").trim();
  const configuredPort = String(env?.VIZION_ANALYTICS_PORT || "").trim();
  let configured = explicitBase;

  if (!configured) {
    if (configuredPort && (!/^\d+$/.test(configuredPort) || Number(configuredPort) < 1 || Number(configuredPort) > 65535)) {
      throw invalidAnalyticsApiBase();
    }
    configured = configuredPort
      ? `http://127.0.0.1:${configuredPort}`
      : DEFAULT_ANALYTICS_API_BASE;
  }
  let url;

  try {
    url = new URL(configured);
  } catch {
    throw invalidAnalyticsApiBase();
  }

  const hasUnsupportedComponent = (
    !["http:", "https:"].includes(url.protocol)
    || (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()))
    || Boolean(url.username)
    || Boolean(url.password)
    || Boolean(url.search)
    || Boolean(url.hash)
    || (url.pathname !== "" && url.pathname !== "/")
  );

  if (hasUnsupportedComponent) {
    throw invalidAnalyticsApiBase();
  }

  return url.origin;
}

export function resolveAnalyticsProxyTimeoutMs(env = process.env) {
  const configured = String(env?.VIZION_ANALYTICS_PROXY_TIMEOUT_MS || "").trim();
  if (!configured) return DEFAULT_ANALYTICS_PROXY_TIMEOUT_MS;
  if (!/^\d+$/.test(configured)) throw invalidAnalyticsProxyTimeout();
  const timeoutMs = Number(configured);
  if (timeoutMs < 1 || timeoutMs > MAX_ANALYTICS_PROXY_TIMEOUT_MS) {
    throw invalidAnalyticsProxyTimeout();
  }
  return timeoutMs;
}

export function buildAnalyticsProxyUrl(
  pathname,
  searchParams,
  analyticsApiBase = resolveAnalyticsApiBase(),
) {
  if (
    typeof pathname !== "string"
    || !pathname.startsWith("/")
    || pathname.startsWith("//")
    || pathname.includes("?")
    || pathname.includes("#")
  ) {
    throw invalidAnalyticsProxyPath();
  }
  const resolvedBase = resolveAnalyticsApiBase({ VIZION_ANALYTICS_API_BASE: analyticsApiBase });
  const analyticsUrl = new URL(pathname, resolvedBase);
  if (analyticsUrl.origin !== new URL(resolvedBase).origin) {
    throw invalidAnalyticsProxyPath();
  }
  searchParams?.forEach((value, key) => analyticsUrl.searchParams.append(key, value));
  return analyticsUrl;
}
