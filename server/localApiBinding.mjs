export const LOCAL_API_HOST = "127.0.0.1";
export const DEFAULT_JSON_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const REQUEST_BODY_TOO_LARGE = "REQUEST_BODY_TOO_LARGE";

function headerValue(headers, name) {
  if (headers && typeof headers.get === "function") {
    return headers.get(name) || "";
  }
  if (!headers || typeof headers !== "object") {
    return "";
  }
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  if (!entry) {
    return "";
  }
  const value = Array.isArray(entry[1]) ? entry[1][0] : entry[1];
  return typeof value === "string" ? value : "";
}

function normalizedPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function parseLoopbackHost(value) {
  const match = /^(localhost|127\.0\.0\.1):([0-9]{1,5})$/i.exec(String(value || ""));
  if (!match) {
    return null;
  }
  const port = normalizedPort(match[2]);
  return port ? { hostname: match[1].toLowerCase(), port } : null;
}

function parseTrustedLocalOrigin(value, { apiPort, webPort } = {}) {
  let origin;
  try {
    origin = new URL(String(value || ""));
  } catch {
    return null;
  }

  const allowedPorts = new Set([normalizedPort(apiPort), normalizedPort(webPort)].filter(Boolean));
  const originPort = normalizedPort(origin.port);
  if (
    origin.protocol !== "http:"
    || !LOOPBACK_HOSTS.has(origin.hostname.toLowerCase())
    || !originPort
    || !allowedPorts.has(originPort)
    || origin.username
    || origin.password
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
  ) {
    return null;
  }
  return origin.origin;
}

function requestBodyTooLarge() {
  return Object.assign(new Error(REQUEST_BODY_TOO_LARGE), {
    code: REQUEST_BODY_TOO_LARGE,
    statusCode: 413,
  });
}

function invalidJsonBody() {
  return Object.assign(new Error("INVALID_JSON_REQUEST_BODY"), {
    code: "INVALID_JSON_REQUEST_BODY",
    statusCode: 400,
  });
}

function normalizeBodyLimit(maxBytes) {
  const limit = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }
  return limit;
}

function drainRequest(request) {
  if (!request || typeof request.resume !== "function") {
    return;
  }
  const ignoreDrainError = () => {};
  const finishDrain = () => request.removeListener?.("error", ignoreDrainError);
  request.once?.("error", ignoreDrainError);
  request.once?.("end", finishDrain);
  request.resume();
}

export function resolveJsonBodyLimit(env = process.env) {
  const configured = String(env?.VIZION_API_JSON_BODY_LIMIT_BYTES || "").trim();
  return normalizeBodyLimit(configured || DEFAULT_JSON_BODY_LIMIT_BYTES);
}

export function isTrustedLocalApiRequest(request, { apiPort, webPort } = {}) {
  const configuredApiPort = normalizedPort(apiPort);
  const host = parseLoopbackHost(headerValue(request?.headers, "host"));
  if (!configuredApiPort || !host || host.port !== configuredApiPort) {
    return false;
  }

  const originValue = headerValue(request?.headers, "origin");
  return !originValue || Boolean(parseTrustedLocalOrigin(originValue, { apiPort, webPort }));
}

export function isJsonApiRequest(request, pathname) {
  if (request?.method !== "POST" || !String(pathname || "").startsWith("/api/")) {
    return true;
  }
  const mediaType = headerValue(request?.headers, "content-type").split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json";
}

export function buildLocalCorsHeaders(request, options = {}) {
  const origin = parseTrustedLocalOrigin(headerValue(request?.headers, "origin"), options);
  return {
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

export function readBoundedJsonBody(request, { maxBytes = DEFAULT_JSON_BODY_LIMIT_BYTES } = {}) {
  const limit = normalizeBodyLimit(maxBytes);
  const rawContentLength = headerValue(request?.headers, "content-length");
  if (/^[0-9]+$/.test(rawContentLength) && Number(rawContentLength) > limit) {
    drainRequest(request);
    return Promise.reject(requestBodyTooLarge());
  }

  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    let settled = false;
    const chunks = [];

    const cleanup = () => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
    };
    const rejectWith = (error, { drain = false, keepListeners = false } = {}) => {
      if (settled) {
        return;
      }
      settled = true;
      chunks.length = 0;
      if (!keepListeners) {
        cleanup();
      }
      if (drain) {
        request.resume?.();
      }
      reject(error);
    };
    const onData = (chunk) => {
      if (settled) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > limit) {
        rejectWith(requestBodyTooLarge(), { drain: true, keepListeners: true });
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      if (settled) {
        return;
      }
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(invalidJsonBody());
      }
    };
    const onError = (error) => {
      if (settled) {
        cleanup();
        return;
      }
      rejectWith(error);
    };
    const onAborted = () => {
      if (settled) {
        return;
      }
      rejectWith(new Error("REQUEST_BODY_ABORTED"), { keepListeners: true });
    };

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

export function toSafeLocalApiBodyResponse(error) {
  if (error?.code === REQUEST_BODY_TOO_LARGE && error?.statusCode === 413) {
    return {
      statusCode: 413,
      payload: { success: false, error: REQUEST_BODY_TOO_LARGE },
    };
  }
  if (error?.code === "INVALID_JSON_REQUEST_BODY" && error?.statusCode === 400) {
    return {
      statusCode: 400,
      payload: { success: false, error: "INVALID_JSON_REQUEST_BODY" },
    };
  }
  return null;
}

export function listenLocalApiServer(server, port, onListening) {
  return server.listen(port, LOCAL_API_HOST, onListening);
}
