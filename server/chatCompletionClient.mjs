// Shared chat-completion call with abort timeout. Used by the testcase generator,
// the LLM-as-judge, and the test-design-model builder so every LLM call site in the
// testcase pipeline keeps identical timeout/error semantics.

import { buildChatCompletionRequest } from "./chatModelConfig.mjs";

export async function callChatCompletion({
  messages,
  chatConfig,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 120000,
  label = "LLM",
}) {
  const requestConfig = buildChatCompletionRequest({
    selectedModel: chatConfig.model,
    messages,
    env,
  });

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(requestConfig.url, {
      method: "POST",
      headers: requestConfig.headers,
      body: JSON.stringify(requestConfig.body),
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`${label} request failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return String(data?.choices?.[0]?.message?.content || "");
}
