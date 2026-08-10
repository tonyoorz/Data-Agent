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

const SCOPE_LIST_KEYS = ["workspaceIds", "projectIds", "teamIds", "allowedObjectTypes", "allowedPropertyIds", "rowPolicyIds", "sensitiveFieldPolicyIds"];

function normalizeScopes(scopes) {
  if (!scopes || typeof scopes !== "object") throw httpError("ACTOR_SCOPES_REQUIRED", 500);
  const normalized = {};
  for (const key of SCOPE_LIST_KEYS) {
    if (!Array.isArray(scopes[key]) || scopes[key].some((value) => typeof value !== "string" || !value.trim())) {
      throw httpError(`ACTOR_SCOPE_INVALID:${key}`, 500);
    }
    normalized[key] = Object.freeze([...new Set(scopes[key].map((value) => value.trim()))].sort());
  }
  if (!normalized.allowedObjectTypes.length) throw httpError("ACTOR_SCOPE_INVALID:allowedObjectTypes", 500);
  return Object.freeze(normalized);
}

function freezeActor(actor) {
  if (!actor?.scopeVersion) throw httpError("ACTOR_SCOPE_VERSION_REQUIRED", 500);
  const scopes = normalizeScopes(actor.scopes);
  return Object.freeze({
    ...actor,
    roles: Object.freeze([...(actor.roles || [])]),
    scopes,
    scopeHash: scopeHash({ scopeVersion: actor.scopeVersion, scopes }),
  });
}

export function createIdentityResolver({ mode, trustedProxyAddresses = [], scopeProvider, devActor }) {
  const trustedPeers = new Set(trustedProxyAddresses.map(normalizePeer));

  async function resolveIdentity(request) {
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
  }

  resolveIdentity.refresh = async (actor) => {
    if (!actor?.actorId) throw httpError("UNAUTHORIZED", 401);
    if (mode === "dev") {
      if (!devActor) throw httpError("DEV_ACTOR_REQUIRED", 500);
      if (actor.actorId !== devActor.actorId) throw httpError("ACTOR_IDENTITY_CHANGED", 403);
      return freezeActor(devActor);
    }
    if (typeof scopeProvider !== "function") throw httpError("SCOPE_PROVIDER_REQUIRED", 500);
    const baseActor = Object.freeze({ actorId: actor.actorId, authSessionId: actor.authSessionId || "scope-refresh", roles: actor.roles || [] });
    const scoped = await scopeProvider(baseActor);
    return freezeActor({ ...baseActor, scopeVersion: scoped.scopeVersion, scopes: scoped.scopes });
  };
  return resolveIdentity;
}
