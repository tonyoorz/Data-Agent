function parseJson(value) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return {};
  }
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export function buildToolEvidence({ toolCall, result, intent }) {
  const payload = parseJson(result?.toolMessage?.content);
  const body = payload?.result && typeof payload.result === "object" ? payload.result : payload;
  return compactObject({
    tool: payload?.tool || result?.toolMessage?.name || toolCall?.function?.name || "unknown_tool",
    toolCallId: toolCall?.id || result?.toolMessage?.tool_call_id || "",
    intent,
    ok: payload?.ok,
    ontologyVersion: body?.ontologyVersion,
    schemaFingerprint: body?.schemaFingerprint,
    sourceRevision: body?.sourceRevision,
    quality: body?.quality,
    limitations: body?.limitations,
    url: payload?.url,
  });
}