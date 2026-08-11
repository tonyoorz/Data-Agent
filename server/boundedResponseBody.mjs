export class BoundedResponseBodyError extends Error {
  constructor(code) {
    super(code);
    this.name = "BoundedResponseBodyError";
    this.code = code;
  }
}

function fail(code) {
  throw new BoundedResponseBodyError(code);
}

function validateMaximum(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("OUTBOUND_RESPONSE_LIMIT_INVALID");
  }
}

function ensureBounded(value, maxBytes, errorCode) {
  if (Buffer.byteLength(String(value || ""), "utf8") > maxBytes) fail(errorCode);
  return value;
}

export async function readBoundedResponseText(
  response,
  { maxBytes = 1024 * 1024, errorCode = "OUTBOUND_RESPONSE_TOO_LARGE" } = {},
) {
  validateMaximum(maxBytes);
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parts = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          fail(errorCode);
        }
        parts.push(decoder.decode(value, { stream: true }));
      }
      parts.push(decoder.decode());
      return parts.join("");
    } catch (error) {
      if (error instanceof BoundedResponseBodyError) throw error;
      throw error;
    }
  }

  if (typeof response?.text === "function") {
    return ensureBounded(await response.text(), maxBytes, errorCode);
  }
  if (typeof response?.json === "function") {
    const value = await response.json();
    ensureBounded(JSON.stringify(value), maxBytes, errorCode);
    return JSON.stringify(value);
  }
  throw new TypeError("OUTBOUND_RESPONSE_BODY_UNAVAILABLE");
}

export async function readBoundedResponseJson(response, options = {}) {
  if (!response?.body?.getReader && typeof response?.json === "function") {
    const value = await response.json();
    const serialized = JSON.stringify(value);
    validateMaximum(options.maxBytes ?? 1024 * 1024);
    ensureBounded(serialized, options.maxBytes ?? 1024 * 1024, options.errorCode || "OUTBOUND_RESPONSE_TOO_LARGE");
    return value;
  }
  return JSON.parse(await readBoundedResponseText(response, options));
}
