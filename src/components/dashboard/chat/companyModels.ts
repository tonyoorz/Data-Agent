const DEFAULT_COMPANY_MODEL_IDS = [
  "deepseek-v4-flash",
  "qwen3.5-397b-a17b",
  "glm-5",
] as const;

const MODEL_LABELS: Record<string, string> = {
  "deepseek-v4-flash": "deepseek-v4-flash",
  "qwen3.5-397b-a17b": "qwen3.5-397b-a17b",
  "glm-5": "glm-5",
};

function parseModelIds(raw: string | undefined) {
  return String(raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function buildCompanyChatModels(raw?: string) {
  const configuredModelIds = parseModelIds(raw);
  if (raw !== undefined && configuredModelIds.length === 0) {
    throw new Error("CHAT_MODEL_OPTIONS_INVALID");
  }
  const modelIds = raw === undefined ? [...DEFAULT_COMPANY_MODEL_IDS] : configuredModelIds;
  return modelIds
    .filter((modelId, index, values) => values.findIndex((value) => value.toLowerCase() === modelId.toLowerCase()) === index)
    .map((modelId) => ({
      id: modelId,
      label: MODEL_LABELS[modelId] || modelId,
    }));
}

export const COMPANY_CHAT_MODELS = buildCompanyChatModels(import.meta.env.VITE_DUPSEARCH_CHAT_MODEL_OPTIONS);

export const DEFAULT_COMPANY_CHAT_MODEL = COMPANY_CHAT_MODELS[0]?.id || "deepseek-v4-flash";

export function normalizeCompanyChatModel(modelId?: string) {
  const normalized = String(modelId || "").trim().toLowerCase();
  const match = COMPANY_CHAT_MODELS.find((option) => option.id.toLowerCase() === normalized);
  return match?.id || DEFAULT_COMPANY_CHAT_MODEL;
}
