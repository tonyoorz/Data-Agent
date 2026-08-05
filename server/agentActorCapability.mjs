import { createHmac, randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";

export const ACTOR_CAPABILITY_HEADER = "X-Vizion-Agent-Actor-Capability";
export const ACTOR_CAPABILITY_VERSION = "v1";
export const ACTOR_CAPABILITY_AUDIENCE = "vizion-analytics";
export const DEFAULT_ACTOR_CAPABILITY_TTL_SECONDS = 60;
export const MAX_ACTOR_CAPABILITY_TTL_SECONDS = 300;
export const MAX_ACTOR_CAPABILITY_CLOCK_SKEW_SECONDS = 5;
export const MAX_TIMESTAMP = 9_007_199_254_740_991;
export const ACTOR_CAPABILITY_SCOPE_KEYS = Object.freeze([
  "workspaceIds",
  "projectIds",
  "teamIds",
  "allowedObjectTypes",
  "allowedPropertyIds",
  "rowPolicyIds",
  "sensitiveFieldPolicyIds",
]);

const CAPABILITY_PAYLOAD_KEYS = Object.freeze([
  "actorId",
  "scopeHash",
  "scopes",
  "issuedAt",
  "expiresAt",
  "nonce",
  "audience",
]);
const SCOPE_KEY_SET = new Set(ACTOR_CAPABILITY_SCOPE_KEYS);
const PAYLOAD_KEY_SET = new Set(CAPABILITY_PAYLOAD_KEYS);
const BASE64URL_PART = /^[A-Za-z0-9_-]+$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]+$/;
const CANONICAL_JSON_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const JSON_NUMBER_CHARACTER = /[0-9eE+.-]/;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;
const EDGE_WHITESPACE_CHARACTER = /^[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]$/u;

export class ActorCapabilityError extends Error {
  constructor(code, statusCode = 403) {
    super(code);
    this.name = "ActorCapabilityError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function invalidCapability() {
  return new ActorCapabilityError("ACTOR_CAPABILITY_INVALID");
}

function expiredCapability() {
  return new ActorCapabilityError("ACTOR_CAPABILITY_EXPIRED");
}

function configurationError() {
  return new ActorCapabilityError("ACTOR_CAPABILITY_CONFIGURATION_INVALID", 503);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAsciiHttpOws(character) {
  return character === " " || character === "\t";
}

function normalizeActorCapabilityHeaderValue(value) {
  if (typeof value !== "string") {
    throw invalidCapability();
  }

  let start = 0;
  let end = value.length;
  while (start < end && isAsciiHttpOws(value[start])) {
    start += 1;
  }
  while (end > start && isAsciiHttpOws(value[end - 1])) {
    end -= 1;
  }

  const normalized = value.slice(start, end);
  const firstCodeUnit = normalized.charCodeAt(0);
  const lastCodeUnit = normalized.charCodeAt(normalized.length - 1);
  if (normalized.length === 0
    || firstCodeUnit < 0x21
    || firstCodeUnit > 0x7E
    || lastCodeUnit < 0x21
    || lastCodeUnit > 0x7E) {
    throw invalidCapability();
  }
  return normalized;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function hasOnlyUnicodeScalars(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF)) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

function hasCodePointLengthInRange(value, minimum, maximum) {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    count += 1;
    if (count > maximum) {
      return false;
    }
    if (codePoint > 0xFFFF) {
      index += 1;
    }
  }
  return count >= minimum;
}

function hasForbiddenEdgeWhitespace(value) {
  return EDGE_WHITESPACE_CHARACTER.test(value[0])
    || EDGE_WHITESPACE_CHARACTER.test(value[value.length - 1]);
}

function isNormalizedText(value) {
  return typeof value === "string"
    && hasOnlyUnicodeScalars(value)
    && hasCodePointLengthInRange(value, 1, 256)
    && !hasForbiddenEdgeWhitespace(value)
    && !CONTROL_CHARACTER.test(value);
}

function requireNormalizedText(value) {
  if (!isNormalizedText(value)) {
    throw invalidCapability();
  }
  return value;
}

function normalizeScopes(scopes, requireNormalized) {
  if (!isRecord(scopes)) {
    throw invalidCapability();
  }

  const scopeKeys = Object.keys(scopes);
  if (!scopeKeys.includes("allowedObjectTypes") || scopeKeys.some((key) => !SCOPE_KEY_SET.has(key))) {
    throw invalidCapability();
  }

  const normalizedScopes = {};
  for (const key of ACTOR_CAPABILITY_SCOPE_KEYS) {
    if (!hasOwn(scopes, key)) {
      continue;
    }

    const values = scopes[key];
    if (!Array.isArray(values) || values.length === 0) {
      throw invalidCapability();
    }

    const normalizedValues = Array.from(values, requireNormalizedText).sort(compareUtf8);
    if (new Set(normalizedValues).size !== normalizedValues.length) {
      throw invalidCapability();
    }
    if (key === "allowedObjectTypes" && normalizedValues.some((value) => value.includes("*"))) {
      throw invalidCapability();
    }
    if (requireNormalized && values.some((value, index) => value !== normalizedValues[index])) {
      throw invalidCapability();
    }

    normalizedScopes[key] = normalizedValues;
  }
  return normalizedScopes;
}

function normalizeActor(actor) {
  if (!isRecord(actor)) {
    throw invalidCapability();
  }
  return {
    actorId: requireNormalizedText(actor.actorId),
    scopeHash: requireNormalizedText(actor.scopeHash),
    scopes: normalizeScopes(actor.scopes, false),
  };
}

function resolveNow(now) {
  const resolvedNow = typeof now === "function"
    ? now()
    : now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(resolvedNow)
    || resolvedNow < 0
    || resolvedNow > MAX_TIMESTAMP) {
    throw invalidCapability();
  }
  return resolvedNow;
}

function resolveTtlSeconds(ttlSeconds) {
  const resolvedTtl = ttlSeconds ?? DEFAULT_ACTOR_CAPABILITY_TTL_SECONDS;
  if (!Number.isSafeInteger(resolvedTtl)
    || resolvedTtl < 1
    || resolvedTtl > MAX_ACTOR_CAPABILITY_TTL_SECONDS) {
    throw configurationError();
  }
  return resolvedTtl;
}

function requireSecret(secret) {
  if (typeof secret !== "string" || secret.trim().length === 0) {
    throw configurationError();
  }
  return secret;
}

function resolveSecret(options) {
  if (hasOwn(options, "secret")) {
    return requireSecret(options.secret);
  }
  return getActorCapabilitySecret(options.env);
}

function resolveNonce(options) {
  if (hasOwn(options, "nonce")) {
    return requireNonce(options.nonce);
  }

  const randomBytes = options.randomBytes ?? cryptoRandomBytes;
  if (typeof randomBytes !== "function") {
    throw configurationError();
  }
  const randomValue = randomBytes(18);
  if (!Buffer.isBuffer(randomValue) && !(randomValue instanceof Uint8Array)) {
    throw configurationError();
  }
  return requireNonce(Buffer.from(randomValue).toString("base64url"));
}

function requireNonce(nonce) {
  if (!isNormalizedText(nonce)
    || !NONCE_PATTERN.test(nonce)
    || !hasCodePointLengthInRange(nonce, 16, 128)) {
    throw invalidCapability();
  }
  return nonce;
}

function encodeBase64Url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(part) {
  if (typeof part !== "string" || !BASE64URL_PART.test(part) || part.length % 4 === 1) {
    throw invalidCapability();
  }

  let decoded;
  try {
    decoded = Buffer.from(part, "base64url");
  } catch {
    throw invalidCapability();
  }
  if (decoded.toString("base64url") !== part) {
    throw invalidCapability();
  }
  return decoded;
}

function sign(signingInput, secret) {
  return createHmac("sha256", secret).update(signingInput, "ascii").digest();
}

function validateCanonicalJsonIntegerTokens(payloadText) {
  let index = 0;
  while (index < payloadText.length) {
    const character = payloadText[index];
    if (character === "\"") {
      index += 1;
      while (index < payloadText.length) {
        if (payloadText[index] === "\\") {
          index += 2;
        } else if (payloadText[index] === "\"") {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      continue;
    }

    if (character === "-" || (character >= "0" && character <= "9")) {
      const start = index;
      index += 1;
      while (index < payloadText.length && JSON_NUMBER_CHARACTER.test(payloadText[index])) {
        index += 1;
      }
      if (!CANONICAL_JSON_INTEGER.test(payloadText.slice(start, index))) {
        throw invalidCapability();
      }
      continue;
    }

    index += 1;
  }
}

function parsePayload(payloadBytes, now) {
  if (payloadBytes.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF]))) {
    throw invalidCapability();
  }

  let payload;
  try {
    const payloadText = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    validateCanonicalJsonIntegerTokens(payloadText);
    payload = JSON.parse(payloadText);
  } catch {
    throw invalidCapability();
  }
  if (!isRecord(payload)) {
    throw invalidCapability();
  }

  const payloadKeys = Object.keys(payload);
  if (payloadKeys.length !== CAPABILITY_PAYLOAD_KEYS.length
    || payloadKeys.some((key) => !PAYLOAD_KEY_SET.has(key))) {
    throw invalidCapability();
  }

  const actorId = requireNormalizedText(payload.actorId);
  const scopeHash = requireNormalizedText(payload.scopeHash);
  const scopes = normalizeScopes(payload.scopes, true);
  if (payload.audience !== ACTOR_CAPABILITY_AUDIENCE) {
    throw invalidCapability();
  }
  if (!Number.isSafeInteger(payload.issuedAt)
    || !Number.isSafeInteger(payload.expiresAt)
    || payload.issuedAt < 0
    || payload.issuedAt > MAX_TIMESTAMP
    || payload.expiresAt > MAX_TIMESTAMP
    || payload.expiresAt <= payload.issuedAt
    || payload.expiresAt - payload.issuedAt > MAX_ACTOR_CAPABILITY_TTL_SECONDS) {
    throw invalidCapability();
  }
  if (payload.issuedAt > now + MAX_ACTOR_CAPABILITY_CLOCK_SKEW_SECONDS) {
    throw invalidCapability();
  }
  if (payload.expiresAt <= now) {
    throw expiredCapability();
  }
  const nonce = requireNonce(payload.nonce);

  return {
    actorId,
    scopeHash,
    scopes,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    nonce,
    audience: ACTOR_CAPABILITY_AUDIENCE,
  };
}

export function getActorCapabilitySecret(env = process.env) {
  return requireSecret(env?.VIZION_AGENT_ACTOR_CAPABILITY_SECRET);
}

export function createActorCapability(actor, options = {}) {
  const secret = resolveSecret(options);
  const now = resolveNow(options.now);
  const ttlSeconds = resolveTtlSeconds(options.ttlSeconds);
  if (now > MAX_TIMESTAMP - ttlSeconds) {
    throw invalidCapability();
  }
  const normalizedActor = normalizeActor(actor);
  const nonce = resolveNonce(options);
  const payload = {
    actorId: normalizedActor.actorId,
    scopeHash: normalizedActor.scopeHash,
    scopes: normalizedActor.scopes,
    issuedAt: now,
    expiresAt: now + ttlSeconds,
    nonce,
    audience: ACTOR_CAPABILITY_AUDIENCE,
  };
  const payloadPart = encodeBase64Url(JSON.stringify(payload));
  const signingInput = `${ACTOR_CAPABILITY_VERSION}.${payloadPart}`;
  return `${signingInput}.${sign(signingInput, secret).toString("base64url")}`;
}

export function verifyActorCapability(token, options = {}) {
  const secret = resolveSecret(options);
  const now = resolveNow(options.now);
  if (typeof token !== "string") {
    throw invalidCapability();
  }

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== ACTOR_CAPABILITY_VERSION) {
    throw invalidCapability();
  }
  const [, payloadPart, signaturePart] = parts;
  const payloadBytes = decodeBase64Url(payloadPart);
  const receivedSignature = decodeBase64Url(signaturePart);
  const expectedSignature = sign(`${ACTOR_CAPABILITY_VERSION}.${payloadPart}`, secret);
  if (receivedSignature.length !== expectedSignature.length
    || !timingSafeEqual(receivedSignature, expectedSignature)) {
    throw invalidCapability();
  }
  return parsePayload(payloadBytes, now);
}

export function extractActorCapabilityHeader(headers) {
  let values = [];
  if (headers && typeof headers.get === "function") {
    const value = headers.get(ACTOR_CAPABILITY_HEADER);
    values = value === null || value === undefined ? [] : [value];
  } else if (isRecord(headers)) {
    values = Object.entries(headers)
      .filter(([key]) => key.toLowerCase() === ACTOR_CAPABILITY_HEADER.toLowerCase())
      .map(([, value]) => value);
  } else {
    throw new ActorCapabilityError("ACTOR_CAPABILITY_MISSING", 401);
  }

  if (values.length === 0) {
    throw new ActorCapabilityError("ACTOR_CAPABILITY_MISSING", 401);
  }
  if (values.length !== 1) {
    throw invalidCapability();
  }
  return normalizeActorCapabilityHeaderValue(values[0]);
}

export function verifyActorCapabilityHeader(headers, options = {}) {
  return verifyActorCapability(extractActorCapabilityHeader(headers), options);
}