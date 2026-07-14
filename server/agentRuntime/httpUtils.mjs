function httpError(code, statusCode) {
  return Object.assign(new Error(code), { code, statusCode, retryable: false });
}

async function readBody(request, { maxBytes }) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw httpError("REQUEST_TOO_LARGE", 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(request, { maxBytes }) {
  const raw = (await readBody(request, { maxBytes })).toString("utf8").trim();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw httpError("INVALID_JSON", 400);
  }
}

export async function readBinaryBody(request, { maxBytes }) {
  return readBody(request, { maxBytes });
}

export function corsHeaders(origin, { allowedOrigins = [] }) {
  if (allowedOrigins.includes("*")) throw httpError("CORS_WILDCARD_FORBIDDEN", 500);
  if (!origin) return {};
  if (!allowedOrigins.includes(origin)) throw httpError("ORIGIN_NOT_ALLOWED", 403);
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Agent-Protocol, X-Agent-Thread-ID, X-Artifact-File-Name, Last-Event-ID",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Expose-Headers": "X-Agent-Protocol, X-Agent-Run-ID, X-Agent-Thread-ID",
    Vary: "Origin",
  };
}

export function applyCors(response, request, config) {
  const headers = corsHeaders(String(request?.headers?.origin || ""), config);
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
}

export function writeJson(response, request, config, statusCode, body, extraHeaders = {}) {
  applyCors(response, request, config);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

export function writeSseHeaders(response, request, config, extraHeaders = {}) {
  applyCors(response, request, config);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...extraHeaders,
  });
}

export function handlePreflight(response, request, config) {
  applyCors(response, request, config);
  response.writeHead(204);
  response.end();
}

export function writeHttpError(response, request, config, error) {
  let effectiveError = error;
  try {
    applyCors(response, request, config);
  } catch (corsError) {
    effectiveError = corsError;
  }
  const statusCode = Number(effectiveError?.statusCode || 500);
  const code = String(effectiveError?.code || "INTERNAL_ERROR");
  const safeMessage = statusCode >= 500 ? "Agent service is temporarily unavailable." : String(effectiveError?.safeMessage || code);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(effectiveError?.retryAfterSeconds ? { "Retry-After": String(effectiveError.retryAfterSeconds) } : {}),
  });
  response.end(JSON.stringify({
    code,
    safeMessage,
    retryable: Boolean(effectiveError?.retryable),
    ...(effectiveError?.snapshotUrl ? { snapshotUrl: effectiveError.snapshotUrl } : {}),
  }));
}