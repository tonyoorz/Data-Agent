import { createHash } from "node:crypto";

import { createRemoteJWKSet, jwtVerify } from "jose";

import { resolveInternalActorScope } from "./internalActorScope.mjs";

const AUTHENTICATED_ACTOR_REQUIRED = "AUTHENTICATED_ACTOR_REQUIRED";
const AGENT_AUTH_MODE_INVALID = "AGENT_AUTH_MODE_INVALID";
const AGENT_AUTH_CONFIGURATION_INVALID = "AGENT_AUTH_CONFIGURATION_INVALID";
const AGENT_AUTH_VERIFIER_UNAVAILABLE = "AGENT_AUTH_VERIFIER_UNAVAILABLE";
const AUXILIARY_ROUTE_SCOPE_DENIED = "AUXILIARY_ROUTE_SCOPE_DENIED";
const oidcVerifierCache = new Map();
const INVALID_JWT_ERROR_CODES = new Set([
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_INVALID",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JOSE_NOT_SUPPORTED",
]);
const SCOPE_KEYS = Object.freeze([
  "workspaceIds",
  "projectIds",
  "teamIds",
  "allowedObjectTypes",
  "allowedPropertyIds",
  "rowPolicyIds",
  "sensitiveFieldPolicyIds",
]);
const POLICY_MATCHER_KEYS = Object.freeze(["subjects", "groups"]);
const CLIENT_ACTOR_FIELDS = Object.freeze([
  "actor",
  "actorScope",
  "actorId",
  "scope",
  "scopeHash",
  "scopes",
  "userId",
  "user_id",
  "groups",
  "permissions",
  "roles",
]);

function createAuthError(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function authenticatedActorRequired(statusCode = 401) {
  return createAuthError(AUTHENTICATED_ACTOR_REQUIRED, statusCode);
}

function agentAuthConfigurationInvalid() {
  return createAuthError(AGENT_AUTH_CONFIGURATION_INVALID, 503);
}

function agentAuthVerifierUnavailable() {
  return createAuthError(AGENT_AUTH_VERIFIER_UNAVAILABLE, 503);
}

function valueList(value, { allowWildcard = true } = {}) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item && (allowWildcard || item !== "*")))]
    .sort();
}

function normalizeScopes(scopeInput = {}) {
  const scopes = {};
  for (const key of SCOPE_KEYS) {
    const values = valueList(scopeInput?.[key], { allowWildcard: key !== "allowedObjectTypes" });
    if (values.length) {
      scopes[key] = values;
    }
  }
  return scopes;
}

function selectSingleScopeGrant(scopePolicies) {
  const effectiveScopes = new Map();
  for (const scopePolicy of scopePolicies) {
    const normalizedScopes = normalizeScopes(scopePolicy);
    effectiveScopes.set(JSON.stringify(normalizedScopes), normalizedScopes);
  }
  if (effectiveScopes.size !== 1) {
    throw authenticatedActorRequired(403);
  }
  return effectiveScopes.values().next().value;
}

function claimGroups(claims) {
  return valueList(claims?.groups);
}

function readAuthorizationHeader(headers) {
  if (headers && typeof headers.get === "function") {
    return headers.get("authorization") || "";
  }
  if (!headers || typeof headers !== "object") {
    return "";
  }
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === "authorization");
  if (!entry) {
    return "";
  }
  const value = Array.isArray(entry[1]) ? entry[1][0] : entry[1];
  return typeof value === "string" ? value : "";
}

function extractBearerToken(headers) {
  const match = readAuthorizationHeader(headers).match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] || "";
}

function normalizeAuthMode(env) {
  const configuredMode = String(env?.VIZION_AGENT_AUTH_MODE || "oidc").trim().toLowerCase();
  return configuredMode || "oidc";
}

function requiredEnvironmentValue(env, name) {
  const value = String(env?.[name] || "").trim();
  if (!value) {
    throw agentAuthConfigurationInvalid();
  }
  return value;
}

function actorFromPolicy(actorId, scopes) {
  const normalizedScopes = normalizeScopes(scopes);
  if (!normalizedScopes.allowedObjectTypes?.length) {
    throw authenticatedActorRequired(403);
  }
  const scopeHash = `oidc-${createHash("sha256")
    .update(JSON.stringify({ actorId, scopes: normalizedScopes }))
    .digest("hex")
    .slice(0, 16)}`;
  return { actorId, scopeHash, scopes: normalizedScopes };
}

function isPolicyRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateScopeGrant(scopeGrant) {
  if (!isPolicyRecord(scopeGrant) || !Object.hasOwn(scopeGrant, "allowedObjectTypes")) {
    throw agentAuthConfigurationInvalid();
  }

  for (const [key, values] of Object.entries(scopeGrant)) {
    if (!SCOPE_KEYS.includes(key) || !Array.isArray(values) || !values.length) {
      throw agentAuthConfigurationInvalid();
    }
    if (values.some((value) => typeof value !== "string" || !value.trim())) {
      throw agentAuthConfigurationInvalid();
    }
    if (key === "allowedObjectTypes" && values.some((value) => value.trim() === "*")) {
      throw agentAuthConfigurationInvalid();
    }
  }
}

function validateOidcScopePolicyConfig(policyConfig) {
  if (!isPolicyRecord(policyConfig)) {
    throw agentAuthConfigurationInvalid();
  }
  if (Object.keys(policyConfig).some((policyKey) => !POLICY_MATCHER_KEYS.includes(policyKey))) {
    throw agentAuthConfigurationInvalid();
  }
  for (const policyKey of POLICY_MATCHER_KEYS) {
    const policyMap = policyConfig[policyKey];
    if (policyMap === undefined) {
      continue;
    }
    if (!isPolicyRecord(policyMap)) {
      throw agentAuthConfigurationInvalid();
    }
    for (const [matcher, scopeGrant] of Object.entries(policyMap)) {
      if (!matcher.trim()) {
        throw agentAuthConfigurationInvalid();
      }
      validateScopeGrant(scopeGrant);
    }
  }
}

export function createOidcScopePolicy(config = {}) {
  validateOidcScopePolicyConfig(config);
  const subjectPolicies = config.subjects || {};
  const groupPolicies = config.groups || {};

  return {
    actorFromClaims(claims) {
      const actorId = typeof claims?.sub === "string" ? claims.sub.trim() : "";
      if (!actorId) {
        throw authenticatedActorRequired();
      }

      const policies = [];
      if (subjectPolicies[actorId] && typeof subjectPolicies[actorId] === "object") {
        policies.push(subjectPolicies[actorId]);
      }
      for (const group of claimGroups(claims)) {
        if (groupPolicies[group] && typeof groupPolicies[group] === "object") {
          policies.push(groupPolicies[group]);
        }
      }

      return actorFromPolicy(actorId, selectSingleScopeGrant(policies));
    },
  };
}

export function resolveOidcScopePolicy(env = process.env) {
  const rawPolicy = requiredEnvironmentValue(env, "VIZION_AGENT_OIDC_SCOPE_POLICY_JSON");
  try {
    return createOidcScopePolicy(JSON.parse(rawPolicy));
  } catch (error) {
    if (isAgentAuthError(error)) {
      throw error;
    }
    throw agentAuthConfigurationInvalid();
  }
}

export function createOidcTokenVerifier(env = process.env, dependencies = {}) {
  try {
    const jwksUrl = new URL(requiredEnvironmentValue(env, "VIZION_OIDC_JWKS_URI"));
    if (jwksUrl.protocol !== "https:") {
      throw agentAuthConfigurationInvalid();
    }
    const issuer = requiredEnvironmentValue(env, "VIZION_OIDC_ISSUER");
    const issuerUrl = new URL(issuer);
    if (issuerUrl.protocol !== "https:") {
      throw agentAuthConfigurationInvalid();
    }
    const audiences = requiredEnvironmentValue(env, "VIZION_OIDC_AUDIENCE")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!audiences.length) {
      throw agentAuthConfigurationInvalid();
    }
    const audience = audiences.length === 1 ? audiences[0] : audiences;
    const cacheKey = JSON.stringify({ issuer, audience, jwksUrl: jwksUrl.href });
    const verifierCache = dependencies.verifierCache || oidcVerifierCache;
    const cachedVerifier = verifierCache.get(cacheKey);
    if (cachedVerifier) {
      return cachedVerifier;
    }

    const createJWKSet = dependencies.createRemoteJWKSet || createRemoteJWKSet;
    const verifyJwt = dependencies.jwtVerify || jwtVerify;
    const jwks = createJWKSet(jwksUrl);

    const verifyToken = async (token) => {
      const { payload } = await verifyJwt(token, jwks, { issuer, audience });
      return payload;
    };
    verifierCache.set(cacheKey, verifyToken);
    return verifyToken;
  } catch (error) {
    if (isAgentAuthError(error)) {
      throw error;
    }
    throw agentAuthConfigurationInvalid();
  }
}

function isInvalidJwtVerificationError(error) {
  return INVALID_JWT_ERROR_CODES.has(error?.code);
}

export function isAgentAuthError(error) {
  return error?.code === AUTHENTICATED_ACTOR_REQUIRED
    || error?.code === AGENT_AUTH_MODE_INVALID
    || error?.code === AGENT_AUTH_CONFIGURATION_INVALID
    || error?.code === AGENT_AUTH_VERIFIER_UNAVAILABLE
    || error?.code === AUXILIARY_ROUTE_SCOPE_DENIED;
}

export function isOidcScopedActor(actor) {
  return String(actor?.scopeHash || "").startsWith("oidc-");
}

export function toSafeAgentAuthResponse(error) {
  if (!isAgentAuthError(error)) {
    return null;
  }
  return {
    statusCode: error.statusCode === 503 ? 503 : error.statusCode === 403 ? 403 : 401,
    payload: { success: false, error: error.code },
  };
}

export async function resolveRequestActor(request = {}, options = {}) {
  const env = options.env || process.env;
  const authMode = normalizeAuthMode(options.authMode ? { VIZION_AGENT_AUTH_MODE: options.authMode } : env);
  if (authMode === "internal") {
    return resolveInternalActorScope(env);
  }
  if (authMode !== "oidc") {
    throw createAuthError(AGENT_AUTH_MODE_INVALID, 503);
  }

  const token = extractBearerToken(request?.headers);
  if (!token) {
    throw authenticatedActorRequired();
  }

  try {
    const verifyToken = typeof options.verifyToken === "function"
      ? options.verifyToken
      : createOidcTokenVerifier(env);
    const scopePolicy = options.scopePolicy || resolveOidcScopePolicy(env);
    const claims = await verifyToken(token);
    return scopePolicy.actorFromClaims(claims);
  } catch (error) {
    if (isAgentAuthError(error)) {
      throw error;
    }
    if (isInvalidJwtVerificationError(error)) {
      throw authenticatedActorRequired();
    }
    throw agentAuthVerifierUnavailable();
  }
}

export async function resolveAuthenticatedChatBody(rawBody, request = {}, options = {}) {
  const actor = await resolveRequestActor(request, options);
  const body = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? { ...rawBody } : {};
  for (const field of CLIENT_ACTOR_FIELDS) {
    delete body[field];
  }
  return {
    ...body,
    actor,
  };
}

export async function runAuthenticatedAgentRequest(request = {}, options = {}) {
  let actor;
  try {
    actor = await resolveRequestActor(request, options);
  } catch (error) {
    const authResponse = toSafeAgentAuthResponse(error);
    if (!authResponse) {
      throw error;
    }
    if (typeof options.sendAuthResponse !== "function") {
      throw error;
    }
    options.sendAuthResponse(authResponse);
    return undefined;
  }

  let rawBody;
  try {
    if (typeof options.readBody !== "function") {
      throw new TypeError("readBody must be a function after agent authentication");
    }
    rawBody = await options.readBody(request);
  } catch (error) {
    if (typeof options.sendBadRequestResponse !== "function") {
      throw error;
    }
    const bodyTooLarge = error?.code === "REQUEST_BODY_TOO_LARGE" && error?.statusCode === 413;
    options.sendBadRequestResponse({
      statusCode: bodyTooLarge ? 413 : 400,
      payload: {
        success: false,
        error: bodyTooLarge
          ? "REQUEST_BODY_TOO_LARGE"
          : String(options.invalidBodyError || "INVALID_AGENT_REQUEST_BODY"),
      },
    });
    return undefined;
  }

  const body = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? { ...rawBody } : {};
  for (const field of CLIENT_ACTOR_FIELDS) {
    delete body[field];
  }

  if (typeof options.runRequest !== "function") {
    throw new TypeError("runRequest must be a function after agent authentication");
  }
  return options.runRequest({ ...body, actor });
}

export async function runAuthenticatedChatRequest(request = {}, options = {}) {
  return runAuthenticatedAgentRequest(request, {
    ...options,
    invalidBodyError: "INVALID_CHAT_REQUEST_BODY",
    runRequest: options.runChat,
  });
}

export async function resolveInternalAuxiliaryActor(request = {}, options = {}) {
  const actor = await resolveRequestActor(request, options);
  if (isOidcScopedActor(actor) || !String(actor?.scopeHash || "").startsWith("internal-")) {
    throw createAuthError(AUXILIARY_ROUTE_SCOPE_DENIED, 403);
  }
  return actor;
}
