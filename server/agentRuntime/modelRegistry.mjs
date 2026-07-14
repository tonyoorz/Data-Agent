const CAPABILITY_KEYS = [
  "nativeToolCalling",
  "structuredOutputMode",
  "streaming",
  "parallelToolCalls",
  "contextWindow",
  "maxOutputTokens",
  "timeoutMs",
  "retryPolicy",
  "certificationStatus",
];

const CERTIFICATION = new Set(["chat_only", "planner_candidate", "planner_certified", "disabled"]);
const DIALECTS = new Set(["internal_chat_completions", "openai_chat_completions"]);
const AUTH_SCHEMES = new Set(["ACCESSCODE", "Bearer"]);
const PLANNING_PURPOSES = new Set(["intent", "planning", "test_draft"]);

function parseJsonObject(raw, label) {
  try {
    const parsed = JSON.parse(String(raw || "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(label);
    return parsed;
  } catch {
    throw new Error(label);
  }
}

function parseEndpointMap(raw) {
  const parsed = parseJsonObject(raw, "LEGACY_MODEL_ENDPOINTS_INVALID_JSON");
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [String(key).toLowerCase(), String(value || "").trim()]));
}

function requireJsonMap(env, key, label) {
  const raw = String(env[key] || "").trim();
  if (!raw) throw new Error(label);
  return parseJsonObject(raw, `${key}_INVALID_JSON`);
}

function assertCapabilities(id, capabilities) {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new Error(`MODEL_CAPABILITIES_INVALID:${id}`);
  }
  for (const key of CAPABILITY_KEYS) {
    if (!(key in capabilities)) throw new Error(`MODEL_CAPABILITY_MISSING:${id}:${key}`);
  }
  if (typeof capabilities.nativeToolCalling !== "boolean") throw new Error(`MODEL_CAPABILITY_INVALID:${id}:nativeToolCalling`);
  if (!["native_json_schema", "json_prompt", "none"].includes(capabilities.structuredOutputMode)) throw new Error(`MODEL_STRUCTURED_OUTPUT_INVALID:${id}`);
  if (typeof capabilities.streaming !== "boolean") throw new Error(`MODEL_CAPABILITY_INVALID:${id}:streaming`);
  if (typeof capabilities.parallelToolCalls !== "boolean") throw new Error(`MODEL_CAPABILITY_INVALID:${id}:parallelToolCalls`);
  if (!CERTIFICATION.has(capabilities.certificationStatus)) throw new Error(`MODEL_CERTIFICATION_INVALID:${id}`);
  if (!Number.isInteger(capabilities.contextWindow) || capabilities.contextWindow <= 0) throw new Error(`MODEL_CONTEXT_INVALID:${id}`);
  if (!Number.isInteger(capabilities.maxOutputTokens) || capabilities.maxOutputTokens <= 0) throw new Error(`MODEL_OUTPUT_LIMIT_INVALID:${id}`);
  if (!Number.isInteger(capabilities.timeoutMs) || capabilities.timeoutMs <= 0) throw new Error(`MODEL_TIMEOUT_INVALID:${id}`);
  if (!Number.isInteger(capabilities.retryPolicy?.maxAttempts) || capabilities.retryPolicy.maxAttempts < 1) throw new Error(`MODEL_RETRY_INVALID:${id}`);
  if (!Number.isInteger(capabilities.retryPolicy?.backoffMs) || capabilities.retryPolicy.backoffMs < 0) throw new Error(`MODEL_RETRY_INVALID:${id}`);
}

function assertRecord(record, env) {
  const id = String(record?.id || "").trim();
  if (!id) throw new Error("MODEL_ID_REQUIRED");
  if ("credential" in Object(record)) throw new Error(`MODEL_CREDENTIAL_IN_RECORD:${id}`);

  let endpoint;
  try {
    endpoint = new URL(String(record.endpoint || ""));
  } catch {
    throw new Error(`MODEL_ENDPOINT_INVALID:${id}`);
  }
  if (endpoint.protocol !== "https:") throw new Error(`MODEL_ENDPOINT_NOT_HTTPS:${id}`);
  if (!DIALECTS.has(record.requestDialect)) throw new Error(`MODEL_DIALECT_INVALID:${id}`);
  if (!AUTH_SCHEMES.has(record.authScheme)) throw new Error(`MODEL_AUTH_SCHEME_INVALID:${id}`);
  assertCapabilities(id, record.capabilities);

  const credentialEnv = String(record.credentialEnv || "").trim();
  if (!credentialEnv) throw new Error(`MODEL_CREDENTIAL_ENV_REQUIRED:${id}`);
  const credential = String(env[credentialEnv] || "").trim();
  if (!credential) throw new Error(`MODEL_CREDENTIAL_MISSING:${id}:${credentialEnv}`);
  // Bacon must be explicitly configured before it appears; no disabled placeholder may satisfy the Phase 1 boundary.
  if (id.toLowerCase() === "bacon" && record.capabilities.certificationStatus === "disabled") {
    throw new Error("BACON_CONFIGURATION_INCOMPLETE");
  }

  const normalized = {
    id,
    label: String(record.label || id).trim() || id,
    endpoint: endpoint.toString(),
    authScheme: record.authScheme,
    credentialEnv,
    requestDialect: record.requestDialect,
    configVersion: String(record.configVersion || "").trim() || "unversioned",
    capabilities: Object.freeze({
      ...record.capabilities,
      retryPolicy: Object.freeze({ ...record.capabilities.retryPolicy }),
    }),
    enabled: record.capabilities.certificationStatus !== "disabled",
  };
  Object.defineProperty(normalized, "credential", { value: credential, enumerable: false });
  return Object.freeze(normalized);
}

function publicDto(record, defaultModelId) {
  return Object.freeze({
    id: record.id,
    label: record.label,
    configVersion: record.configVersion,
    capabilities: record.capabilities,
    enabled: record.enabled,
    default: record.id.toLowerCase() === defaultModelId.toLowerCase(),
  });
}

function compileLegacyAliasesToRecords(env) {
  const options = String(env.DUPSEARCH_CHAT_MODEL_OPTIONS || "").split(",").map((item) => item.trim()).filter(Boolean);
  const endpoints = parseEndpointMap(env.DUPSEARCH_CHAT_MODEL_ENDPOINTS || "{}");
  const capabilities = requireJsonMap(env, "MAIN_AGENT_MODEL_CAPABILITIES", "MAIN_AGENT_MODEL_CAPABILITIES_REQUIRED");
  const dialects = requireJsonMap(env, "MAIN_AGENT_MODEL_DIALECTS", "MAIN_AGENT_MODEL_DIALECTS_REQUIRED");
  const credentialEnv = ["DUPSEARCH_CHAT_ACCESS_CODE", "ACCESS_CODE", "DEEPSEEK_ACCESS_CODE"].find((key) => String(env[key] || "").trim()) || "DUPSEARCH_CHAT_ACCESS_CODE";

  return options.map((id) => {
    const key = id.toLowerCase();
    if (!endpoints[key]) throw new Error(`LEGACY_MODEL_ENDPOINT_MISSING:${id}`);
    if (!capabilities[id] && !capabilities[key]) throw new Error(`LEGACY_MODEL_CAPABILITIES_MISSING:${id}`);
    if (!dialects[id] && !dialects[key]) throw new Error(`LEGACY_MODEL_DIALECT_MISSING:${id}`);
    return {
      id,
      label: id,
      endpoint: endpoints[key],
      authScheme: "ACCESSCODE",
      credentialEnv,
      requestDialect: dialects[id] || dialects[key],
      configVersion: "legacy-alias-v1",
      capabilities: capabilities[id] || capabilities[key],
    };
  });
}

export function createModelRegistry({ env, logger = console } = {}) {
  if (!env || typeof env !== "object") throw new Error("MODEL_REGISTRY_ENV_REQUIRED");

  const primary = String(env.MAIN_AGENT_MODEL_RECORDS || "").trim();
  const legacyOptions = String(env.DUPSEARCH_CHAT_MODEL_OPTIONS || "").trim();
  let rawRecords;
  if (primary) {
    try {
      rawRecords = JSON.parse(primary);
    } catch {
      throw new Error("MAIN_AGENT_MODEL_RECORDS_INVALID_JSON");
    }
  } else if (legacyOptions) {
    logger.warn?.("[main-agent] DUPSEARCH_CHAT_* aliases are deprecated; configure MAIN_AGENT_MODEL_RECORDS");
    rawRecords = compileLegacyAliasesToRecords(env);
  } else {
    throw new Error("MAIN_AGENT_MODEL_RECORDS_REQUIRED");
  }

  if (!Array.isArray(rawRecords) || rawRecords.length === 0) throw new Error("MAIN_AGENT_MODEL_RECORDS_EXPECTED_ARRAY");
  const records = rawRecords.map((record) => assertRecord(record, env));
  const keys = records.map((record) => record.id.toLowerCase());
  if (new Set(keys).size !== keys.length) throw new Error("DUPLICATE_MODEL_ID");

  const byId = new Map(records.map((record) => [record.id.toLowerCase(), record]));
  const defaultModelId = String(env.MAIN_AGENT_DEFAULT_MODEL || records[0].id).trim();
  const defaultRecord = byId.get(defaultModelId.toLowerCase());
  if (!defaultRecord?.enabled) throw new Error(`DEFAULT_MODEL_NOT_CONFIGURED:${defaultModelId}`);

  const registry = {
    defaultModelId: defaultRecord.id,
    has(modelId) {
      const record = byId.get(String(modelId || "").trim().toLowerCase());
      return Boolean(record?.enabled);
    },
    require(modelId, { purpose = "render" } = {}) {
      const id = String(modelId || defaultRecord.id).trim();
      const record = byId.get(id.toLowerCase());
      if (!record || !record.enabled) throw new Error(`MODEL_NOT_CONFIGURED:${id}`);
      if (PLANNING_PURPOSES.has(purpose) && record.capabilities.certificationStatus !== "planner_certified") {
        throw new Error(`MODEL_NOT_CERTIFIED_FOR_PLANNING:${record.id}`);
      }
      return record;
    },
    listPublic({ purpose } = {}) {
      return records
        .filter((record) => record.enabled)
        .filter((record) => !purpose || !PLANNING_PURPOSES.has(purpose) || record.capabilities.certificationStatus === "planner_certified")
        .map((record) => publicDto(record, defaultRecord.id));
    },
  };

  return Object.freeze(registry);
}