const LEGACY_DEFAULT_MODELS = [
  "deepseek-v4-flash",
  "qwen3.5-397b-a17b",
  "glm-5",
];

const GLM_PROXY_DEFAULT_MODELS = [
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "qwen3.7-max",
  "qwen3.7-flash",
  "glm-5.1",
];

const DEFAULT_GLM_PROXY_BASE_URL = "http://127.0.0.1:8001/v1";

const DEFAULT_ENDPOINTS = {
  "deepseek-v4-flash": "https://aistudio.bmwbrill.cn/api/service/ssl/170/lm-platform/llm/v2/chat/completions",
  "qwen3.5-397b-a17b": "https://aistudio.bmwbrill.cn/api/service/164/ernie/v2/chat/completions",
  "glm-5": "https://aistudio.bmwbrill.cn/api/service/163/ernie/v2/chat/completions",
};

function readFirst(env, keys) {
  for (const key of keys) {
    const value = String(env?.[key] ?? "").trim();
    if (value) {
      return value;
    }
  }

  return "";
}

function parseEndpointMap(env) {
  const raw = readFirst(env, ["DUPSEARCH_CHAT_MODEL_ENDPOINTS", "CHAT_MODEL_ENDPOINTS"]);
  if (!raw) {
    return { ...DEFAULT_ENDPOINTS };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_ENDPOINTS };
    }

    const mapped = {};
    for (const [key, value] of Object.entries(parsed)) {
      const normalizedKey = String(key || "").trim().toLowerCase();
      const normalizedValue = String(value || "").trim();
      if (!normalizedKey || !normalizedValue) {
        continue;
      }
      mapped[normalizedKey] = normalizedValue;
    }

    return Object.keys(mapped).length ? mapped : { ...DEFAULT_ENDPOINTS };
  } catch {
    return { ...DEFAULT_ENDPOINTS };
  }
}

function resolveGlmProxyBaseUrl(env) {
  const configuredBaseUrl = readFirst(env, [
    "DUPSEARCH_GLM_PROXY_API_BASE",
    "GLM_PROXY_API_BASE",
    "GLM_PROXY_BASE_URL",
    "GLM_PROXY_URL",
  ]);
  if (configuredBaseUrl) {
    return configuredBaseUrl;
  }

  return readFirst(env, ["GLM_PROXY_API_KEY"]) ? DEFAULT_GLM_PROXY_BASE_URL : "";
}

function usesGlmProxy(env) {
  return Boolean(resolveGlmProxyBaseUrl(env));
}

export function getChatModelOptions(env = process.env) {
  const envRaw = readFirst(env, [
    "DUPSEARCH_CHAT_MODEL_OPTIONS",
    "CHAT_MODEL_OPTIONS",
    "VITE_DUPSEARCH_CHAT_MODEL_OPTIONS",
  ]);
  const envModels = envRaw
    ? envRaw.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
  const defaultModels = usesGlmProxy(env) ? GLM_PROXY_DEFAULT_MODELS : LEGACY_DEFAULT_MODELS;
  const merged = [...envModels, ...defaultModels];
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

  return ordered.length ? ordered : [defaultModels[0]];
}

export function getDefaultChatModel(env = process.env) {
  return getChatModelOptions(env)[0];
}

export function resolveChatModelConfig(selectedModel, env = process.env) {
  const model = String(selectedModel || "").trim() || getDefaultChatModel(env);
  const glmProxyBaseUrl = resolveGlmProxyBaseUrl(env);
  const endpointMap = glmProxyBaseUrl ? {} : parseEndpointMap(env);
  const endpointTemplate = String(endpointMap[model.toLowerCase()] || "").trim();
  const accessCode = readFirst(env, [
    "DUPSEARCH_CHAT_ACCESS_CODE",
    "ACCESS_CODE",
    "DEEPSEEK_ACCESS_CODE",
  ]);
  const endpoint = endpointTemplate
    ? endpointTemplate.replace("{access_code}", accessCode)
    : "";
  const apiKey = readFirst(env, [
    "GLM_PROXY_API_KEY",
    "DUPSEARCH_CHAT_API_KEY",
    "API_KEY",
    "DEEPSEEK_API_KEY",
  ]);
  const authScheme = endpoint ? "ACCESSCODE" : "Bearer";
  const credential = endpoint ? accessCode : apiKey;
  const baseUrl = endpoint
    ? ""
    : glmProxyBaseUrl ||
      readFirst(env, ["DUPSEARCH_CHAT_API_BASE", "DEEPSEEK_API_BASE"]) ||
      "https://api.deepseek.com/v1";

  return {
    model,
    endpoint,
    apiKey,
    accessCode,
    authScheme,
    credential,
    baseUrl,
    usesInternalEndpoint: Boolean(endpoint),
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
        authorization: `${config.authScheme} ${config.credential}`.trim(),
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
      Authorization: `${config.authScheme} ${config.credential}`.trim(),
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
