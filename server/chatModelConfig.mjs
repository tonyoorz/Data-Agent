const DEFAULT_MODELS = [
  "deepseek-v4-flash",
  "qwen3.5-397b-a17b",
  "glm-5",
];

const DEFAULT_ENDPOINTS = {
  "deepseek-v4-flash": "https://aistudio.bmwbrill.cn/api/service/ssl/170/lm-platform/llm/v2/chat/completions",
  "qwen3.5-397b-a17b": "https://aistudio.bmwbrill.cn/api/service/164/ernie/v2/chat/completions",
  "glm-5": "https://aistudio.bmwbrill.cn/api/service/163/ernie/v2/chat/completions",
};
const LOOPBACK_MODEL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function modelConfigError(code = "CHAT_MODEL_ENDPOINT_INVALID") {
  const error = new Error(code);
  error.code = code;
  return error;
}

function secureModelUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw modelConfigError();
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || (url.protocol === "http:" && !LOOPBACK_MODEL_HOSTS.has(url.hostname.toLowerCase()))
    || Boolean(url.username)
    || Boolean(url.password)
    || Boolean(url.search)
    || Boolean(url.hash)
  ) {
    throw modelConfigError();
  }
  return url.toString();
}

function readFirst(env, keys) {
  for (const key of keys) {
    const value = String(env?.[key] ?? "").trim();
    if (value) {
      return value;
    }
  }

  return "";
}

function readExplicit(env, keys) {
  for (const key of keys) {
    if (Object.hasOwn(env || {}, key)) {
      return { configured: true, value: String(env?.[key] ?? "") };
    }
  }
  return { configured: false, value: "" };
}

function parseEndpointMap(env) {
  const explicit = readExplicit(env, ["DUPSEARCH_CHAT_MODEL_ENDPOINTS", "CHAT_MODEL_ENDPOINTS"]);
  if (!explicit.configured) {
    return { ...DEFAULT_ENDPOINTS };
  }
  const raw = explicit.value.trim();
  if (!raw) throw modelConfigError();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw modelConfigError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw modelConfigError();
  }

  const mapped = {};
  for (const [key, value] of Object.entries(parsed)) {
    const normalizedKey = String(key || "").trim().toLowerCase();
    const normalizedValue = String(value || "").trim();
    if (!normalizedKey || !normalizedValue) {
      throw modelConfigError();
    }
    secureModelUrl(normalizedValue.replaceAll("{access_code}", "validated-access-code"));
    mapped[normalizedKey] = normalizedValue;
  }
  if (!Object.keys(mapped).length) throw modelConfigError();
  return mapped;
}

export function getChatModelOptions(env = process.env) {
  const explicit = readExplicit(env, [
    "DUPSEARCH_CHAT_MODEL_OPTIONS",
    "CHAT_MODEL_OPTIONS",
  ]);
  const envModels = explicit.configured
    ? explicit.value.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
  if (explicit.configured && envModels.length === 0) {
    throw modelConfigError("CHAT_MODEL_OPTIONS_INVALID");
  }
  const merged = explicit.configured ? envModels : DEFAULT_MODELS;
  const seen = new Set();
  const ordered = [];

  for (const modelName of merged) {
    const normalized = String(modelName || "").trim();
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    ordered.push(normalized);
  }

  return ordered.length ? ordered : [DEFAULT_MODELS[0]];
}

export function getDefaultChatModel(env = process.env) {
  return getChatModelOptions(env)[0];
}

export function resolveChatModelConfig(selectedModel, env = process.env) {
  const model = String(selectedModel || "").trim() || getDefaultChatModel(env);
  const endpointMap = parseEndpointMap(env);
  const allowedModels = new Set(getChatModelOptions(env).map((item) => item.toLowerCase()));
  if (!allowedModels.has(model.toLowerCase())) {
    throw modelConfigError("CHAT_MODEL_NOT_ALLOWED");
  }
  const endpointTemplate = String(endpointMap[model.toLowerCase()] || "").trim();
  const accessCode = readFirst(env, [
    "DUPSEARCH_CHAT_ACCESS_CODE",
    "DEEPSEEK_ACCESS_CODE",
  ]);
  const apiKey = readFirst(env, [
    "DUPSEARCH_CHAT_API_KEY",
    "DEEPSEEK_API_KEY",
  ]);
  const useInternalEndpoint = Boolean(endpointTemplate && accessCode);
  const endpoint = useInternalEndpoint
    ? secureModelUrl(endpointTemplate.replaceAll("{access_code}", encodeURIComponent(accessCode)))
    : "";
  const authScheme = useInternalEndpoint ? "ACCESSCODE" : "Bearer";
  const credential = useInternalEndpoint ? accessCode : apiKey;
  const baseUrl = useInternalEndpoint
    ? ""
    : secureModelUrl(
      readFirst(env, ["DUPSEARCH_CHAT_API_BASE", "DEEPSEEK_API_BASE"])
        || "https://api.deepseek.com/v1",
    );

  return {
    model,
    endpoint,
    apiKey,
    accessCode,
    authScheme,
    credential,
    baseUrl,
    usesInternalEndpoint: useInternalEndpoint,
  };
}

function buildToolRequestFields(tools, toolChoice) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return {};
  }

  return {
    tools,
    ...(toolChoice == null ? {} : { tool_choice: toolChoice }),
  };
}

function buildStreamRequestFields(stream) {
  return stream ? { stream_options: { include_usage: true } } : {};
}

export function buildChatCompletionRequest({
  selectedModel,
  messages,
  env = process.env,
  stream = false,
  tools,
  toolChoice,
}) {
  const config = resolveChatModelConfig(selectedModel || "", env);
  const toolRequestFields = buildToolRequestFields(tools, toolChoice);
  const streamRequestFields = buildStreamRequestFields(stream);

  if (config.usesInternalEndpoint) {
    return {
      url: config.endpoint,
      headers: {
        accept: "application/json",
        ...(config.credential ? { authorization: `${config.authScheme} ${config.credential}` } : {}),
        "Content-Type": "application/json",
      },
      body: {
        model: config.model,
        messages,
        temperature: 0.2,
        max_token_length: 2048,
        stream,
        ...streamRequestFields,
        ...toolRequestFields,
      },
      config,
    };
  }

  const trimmedBaseUrl = config.baseUrl.replace(/\/+$/, "");
  const url = trimmedBaseUrl.endsWith("/chat/completions")
    ? trimmedBaseUrl
    : `${trimmedBaseUrl}/chat/completions`;

  return {
    url,
    headers: {
      "Content-Type": "application/json",
      ...(config.credential ? { Authorization: `${config.authScheme} ${config.credential}` } : {}),
    },
    body: {
      model: config.model,
      temperature: 0.2,
      max_tokens: 900,
      messages,
      stream,
      ...streamRequestFields,
      ...toolRequestFields,
    },
    config,
  };
}
