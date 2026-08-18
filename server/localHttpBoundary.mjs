const DEFAULT_LISTEN_HOST = "127.0.0.1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function compactString(value) {
  return String(value || "").trim();
}

function normalizeHost(value) {
  return compactString(value).replace(/^\[|\]$/g, "").toLowerCase();
}

function headerValue(headers, name) {
  const value = headers?.[name.toLowerCase()] ?? headers?.[name];
  return Array.isArray(value) ? compactString(value[0]) : compactString(value);
}

function hostFromHeader(value) {
  const raw = compactString(value);
  if (!raw) return "";
  try {
    return normalizeHost(new URL(`http://${raw}`).hostname);
  } catch {
    return "";
  }
}

function valuesFromEnv(value) {
  return compactString(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function configuredHosts(env) {
  return new Set([
    ...LOOPBACK_HOSTS,
    ...valuesFromEnv(env?.VIZION_ALLOWED_HOSTS).map(hostFromHeader).filter(Boolean),
  ]);
}

function normalizedOrigins(env) {
  const origins = new Set();
  for (const value of valuesFromEnv(env?.VIZION_ALLOWED_ORIGINS)) {
    try {
      origins.add(new URL(value).origin);
    } catch {
      continue;
    }
  }
  return origins;
}

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(normalizeHost(host));
}

function isAllowedOrigin(origin, allowedOrigins) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    return allowedOrigins.has(parsed.origin) || isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function isJsonContentType(value) {
  return /^application\/json(?:\s*;|$)/i.test(compactString(value));
}

function rejected(statusCode, code) {
  return { allowed: false, statusCode, code, corsOrigin: "" };
}

export function resolveLocalListenHost(env = process.env) {
  const host = normalizeHost(env?.VIZION_API_HOST || DEFAULT_LISTEN_HOST);
  if (!isLoopbackHost(host)) {
    throw new Error("VIZION_LISTEN_HOST_NOT_LOOPBACK");
  }
  return host;
}

export function createLocalHttpBoundary(env = process.env) {
  const allowedHosts = configuredHosts(env);
  const allowedOrigins = normalizedOrigins(env);

  return Object.freeze({
    listenHost: resolveLocalListenHost(env),
    evaluate({ method, headers = {} } = {}) {
      const host = hostFromHeader(headerValue(headers, "host"));
      if (!host) return rejected(400, "HTTP_HOST_REQUIRED");
      if (!allowedHosts.has(host)) return rejected(421, "HTTP_HOST_NOT_ALLOWED");

      const origin = headerValue(headers, "origin");
      if (!isAllowedOrigin(origin, allowedOrigins)) return rejected(403, "HTTP_ORIGIN_NOT_ALLOWED");

      if (String(method || "").toUpperCase() === "POST" && !isJsonContentType(headerValue(headers, "content-type"))) {
        return rejected(415, "HTTP_JSON_CONTENT_TYPE_REQUIRED");
      }

      return {
        allowed: true,
        statusCode: 200,
        code: "",
        corsOrigin: origin,
      };
    },
  });
}