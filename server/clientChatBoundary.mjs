import { normalizeClientChatMessages } from "./attachmentBoundary.mjs";

class ClientChatBoundaryError extends Error {
  constructor(code, statusCode) {
    super(code);
    this.name = "ClientChatBoundaryError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function invalid() {
  throw new ClientChatBoundaryError("INVALID_CHAT_REQUEST_BODY", 400);
}

function tooLarge() {
  throw new ClientChatBoundaryError("REQUEST_BODY_TOO_LARGE", 413);
}

function optionalBoundedString(value, maximumBytes) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") invalid();
  if (Buffer.byteLength(value, "utf8") > maximumBytes) tooLarge();
  return value.trim();
}

function optionalBoolean(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") invalid();
  return value;
}

export function sanitizeAuthenticatedChatBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid();
  let messages;
  try {
    messages = normalizeClientChatMessages(body.messages);
  } catch (error) {
    if (error?.code === "CHAT_REQUEST_TOO_LARGE") tooLarge();
    invalid();
  }

  const threadId = optionalBoundedString(body.threadId, 256);
  const model = optionalBoundedString(body.model, 128);
  const useDefectContext = optionalBoolean(body.useDefectContext);
  const useAnalyticsContext = optionalBoolean(body.useAnalyticsContext);
  return {
    messages,
    ...(threadId ? { threadId } : {}),
    ...(model ? { model } : {}),
    ...(useDefectContext !== undefined ? { useDefectContext } : {}),
    ...(useAnalyticsContext !== undefined ? { useAnalyticsContext } : {}),
  };
}
