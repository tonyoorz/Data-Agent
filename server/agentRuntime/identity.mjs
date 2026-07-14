import { createHash } from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function scopeHash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function normalizePeer(value) {
  return String(value || "").replace(/^::ffff:/, "");
}

function header(request, name) {
  const headers = request?.headers || {};
  const value = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(value) ? String(value[0] || "").trim() : String(value || "").trim();
}

function httpError(code, statusCode = 401) {
  return Object.assign(new Error(code), { code, statusCode, retryable: false });
}

function freezeActor(actor) {
  return Object.freeze({
    ...actor,
    roles: Object.freeze([...(actor.roles || [])]),
    scopes: Object.freeze({ ...(actor.scopes || {}) }),
    scopeHash: scopeHash({ scopeVersion: actor.scopeVersion, scopes: actor.scopes }),
  });
}

export function createIdentityResolver({ mode, trustedProxyAddresses = [], scopeProvider, devActor }) {
  const trustedPeers = new Set(trustedProxyAddresses.map(normalizePeer));

  return async function resolveIdentity(request) {
    if (mode === "dev") {
      if (!devActor) throw httpError("DEV_ACTOR_REQUIRED", 500);
      return freezeActor(devActor);
    }

    const peer = normalizePeer(request?.socket?.remoteAddress);
    if (!trustedPeers.has(peer)) throw httpError("UNTRUSTED_PROXY", 403);
    if (header(request, "x-forwarded-proto").toLowerCase() !== "https") throw httpError("TRUSTED_PROXY_TLS_REQUIRED", 403);

    const actorId = header(request, "x-agent-actor-id") || header(request, "x-forwarded-user");
    if (!actorId) throw httpError("TRUSTED_IDENTITY_MISSING", 401);
    if (typeof scopeProvider !== "function") throw httpError("SCOPE_PROVIDER_REQUIRED", 500);

    const roles = header(request, "x-agent-roles").split(",").map((role) => role.trim()).filter(Boolean);
    const baseActor = Object.freeze({
      actorId,
      authSessionId: header(request, "x-agent-auth-session-id") || "trusted-proxy-session",
      roles,
    });
    const scoped = await scopeProvider(baseActor);
    return freezeActor({ ...baseActor, scopeVersion: scoped.scopeVersion, scopes: scoped.scopes });
  };
}