const LOOPBACKS = new Set(["127.0.0.1", "::1", "localhost"]);

const csv = (value) => String(value || "").split(",").map((item) => item.trim()).filter(Boolean);

function positiveInt(value, fallback, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`INVALID_${label}`);
  return parsed;
}

function isLoopback(value) {
  return LOOPBACKS.has(String(value || ""));
}

export function createRuntimeConfig(env = {}) {
  const mode = String(env.MAIN_AGENT_RUNTIME_MODE || "legacy");
  if (!["legacy", "shadow", "langgraph"].includes(mode)) throw new Error("INVALID_MAIN_AGENT_RUNTIME_MODE");

  const host = String(env.VIZION_API_HOST || "127.0.0.1");
  const devHost = String(env.VIZION_DEV_HOST || "127.0.0.1");
  const identityMode = String(env.MAIN_AGENT_IDENTITY_MODE || "dev");
  if (!["dev", "trusted-proxy"].includes(identityMode)) throw new Error("INVALID_MAIN_AGENT_IDENTITY_MODE");
  if (identityMode === "dev" && (!isLoopback(host) || !isLoopback(devHost))) {
    throw new Error("DEV_IDENTITY_REQUIRES_LOOPBACK");
  }

  const allowedOrigins = csv(env.MAIN_AGENT_ALLOWED_ORIGINS);
  const trustedProxyAddresses = csv(env.MAIN_AGENT_TRUSTED_PROXY_ADDRESSES || "127.0.0.1,::1");
  if ((!isLoopback(host) || !isLoopback(devHost)) && (
    identityMode !== "trusted-proxy" ||
    trustedProxyAddresses.length === 0 ||
    allowedOrigins.length === 0 ||
    env.MAIN_AGENT_TRUST_PROXY_TLS !== "true"
  )) {
    throw new Error("LAN_BIND_REQUIRES_TRUSTED_TLS_PROXY");
  }

  return Object.freeze({
    mode,
    host,
    devHost,
    port: positiveInt(env.VIZION_API_PORT, 3004, "VIZION_API_PORT"),
    identityMode,
    allowedOrigins,
    trustedProxyAddresses,
    trustProxyTls: env.MAIN_AGENT_TRUST_PROXY_TLS === "true",
    jsonBodyMaxBytes: positiveInt(env.MAIN_AGENT_JSON_BODY_MAX_BYTES, 1024 * 1024, "MAIN_AGENT_JSON_BODY_MAX_BYTES"),
    binaryBodyMaxBytes: positiveInt(env.MAIN_AGENT_BINARY_BODY_MAX_BYTES, 8 * 1024 * 1024, "MAIN_AGENT_BINARY_BODY_MAX_BYTES"),
    legacyImportMaxBytes: positiveInt(env.MAIN_AGENT_LEGACY_IMPORT_MAX_BYTES, 28 * 1024 * 1024, "MAIN_AGENT_LEGACY_IMPORT_MAX_BYTES"),
    runStartRatePerMinute: 30,
    runStartBurst: 5,
  });
}