import { buildToolCallingProbeRequest, classifyToolCallingProbePayload } from "../server/chatToolProbe.mjs";
import { loadLocalEnv } from "../server/loadLocalEnv.mjs";

loadLocalEnv();

function readArgValue(name) {
  const prefix = `--${name}=`;
  const matched = process.argv.find((arg) => arg.startsWith(prefix));
  return matched ? matched.slice(prefix.length).trim() : "";
}

const model = readArgValue("model");
const requestConfig = buildToolCallingProbeRequest({ model, env: process.env });

if (!requestConfig.config.credential) {
  console.error("Chat credentials are not configured. Set DUPSEARCH_CHAT_ACCESS_CODE or DUPSEARCH_CHAT_API_KEY.");
  process.exit(1);
}

const response = await fetch(requestConfig.url, {
  method: "POST",
  headers: requestConfig.headers,
  body: JSON.stringify(requestConfig.body),
});

const text = await response.text();
if (!response.ok) {
  console.error(`Probe request failed (${response.status}): ${text || response.statusText}`);
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(text);
} catch {
  console.error("Probe response was not JSON:");
  console.error(text.slice(0, 1000));
  process.exit(1);
}

const result = classifyToolCallingProbePayload(payload);
console.log(JSON.stringify({
  model: requestConfig.config.model,
  usesInternalEndpoint: requestConfig.config.usesInternalEndpoint,
  supported: result.supported,
  toolCallCount: result.toolCallCount,
  firstToolName: result.firstToolName,
  finishReason: result.finishReason,
  contentPreview: result.contentPreview,
}, null, 2));