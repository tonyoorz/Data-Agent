function normalizeRequestTarget(requestUrl) {
  const rawTarget = typeof requestUrl === "string" && requestUrl ? requestUrl : "/";
  if (rawTarget.startsWith("//")) {
    return rawTarget.replace(/^\/+/, "/") || "/";
  }
  return rawTarget;
}

function normalizeHostHeader(hostHeader) {
  const rawHost = String(hostHeader || "127.0.0.1").trim() || "127.0.0.1";
  try {
    return new URL(`http://${rawHost}`).host;
  } catch {
    return "127.0.0.1";
  }
}

export function resolveRequestUrl(requestUrl, hostHeader) {
  return new URL(normalizeRequestTarget(requestUrl), `http://${normalizeHostHeader(hostHeader)}`);
}