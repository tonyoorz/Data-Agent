const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const IMAGE_MIME_PATTERN = /^image\/(?:png|jpe?g|webp|gif|bmp)$/iu;
const PDF_MIME_TYPE = "application/pdf";

export const CHAT_ATTACHMENT_LIMITS = Object.freeze({
  maxAttachments: 8,
  maxAttachmentBytes: 8 * 1024 * 1024,
  maxTotalBytes: 12 * 1024 * 1024,
  maxConcurrency: 2,
});
export const CLIENT_CHAT_LIMITS = Object.freeze({
  maxMessages: 100,
  maxMessageTextBytes: 64 * 1024,
  maxTotalTextBytes: 256 * 1024,
  maxPartsPerMessage: 32,
  maxTotalParts: 256,
});

export class ChatAttachmentBoundaryError extends Error {
  constructor(code) {
    super(code);
    this.name = "ChatAttachmentBoundaryError";
    this.code = code;
  }
}

function fail(code) {
  throw new ChatAttachmentBoundaryError(code);
}

function isSupportedImageMagic(mimeType, bytes) {
  if (mimeType === "image/png") {
    return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  }
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
    return bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  }
  if (mimeType === "image/webp") {
    return bytes.length >= 12
      && bytes.subarray(0, 4).toString("ascii") === "RIFF"
      && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  }
  if (mimeType === "image/gif") {
    const signature = bytes.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (mimeType === "image/bmp") {
    return bytes.subarray(0, 2).toString("ascii") === "BM";
  }
  return false;
}

function parseBase64DataUrl(value) {
  const match = String(value || "").match(/^data:([^;,]+);base64,(.*)$/s);
  if (!match || !match[2] || !BASE64_PATTERN.test(match[2])) {
    fail("CHAT_ATTACHMENT_INPUT_INVALID");
  }
  const mimeType = match[1].toLowerCase();
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length) fail("CHAT_ATTACHMENT_INPUT_INVALID");
  return {
    mimeType,
    base64: match[2],
    bytes,
    byteLength: bytes.length,
  };
}

export function parseImageDataUrl(value) {
  const parsed = parseBase64DataUrl(value);
  if (!IMAGE_MIME_PATTERN.test(parsed.mimeType) || !isSupportedImageMagic(parsed.mimeType, parsed.bytes)) {
    fail("CHAT_ATTACHMENT_INPUT_INVALID");
  }
  return parsed;
}

export function parsePdfDataUrl(value) {
  const parsed = parseBase64DataUrl(value);
  if (parsed.mimeType !== PDF_MIME_TYPE || parsed.bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    fail("CHAT_ATTACHMENT_INPUT_INVALID");
  }
  return parsed;
}

function hasOnlyKeys(value, allowedKeys) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).every((key) => allowedKeys.has(key));
}

function isTextPart(part) {
  return typeof part === "string"
    || (hasOnlyKeys(part, new Set(["type", "text"]))
      && part.type === "text"
      && typeof part.text === "string");
}

export function isValidatedImagePart(part) {
  return hasOnlyKeys(part, new Set(["type", "image_url"]))
    && part.type === "image_url"
    && hasOnlyKeys(part.image_url, new Set(["url", "detail"]))
    && typeof part.image_url.url === "string"
    && (part.image_url.detail === undefined || ["auto", "low", "high"].includes(part.image_url.detail));
}

export function isValidatedPdfPart(part) {
  const file = part?.file_data;
  const mimeType = String(file?.mime_type || file?.mime || "").toLowerCase();
  const name = String(file?.name || "").toLowerCase();
  return hasOnlyKeys(part, new Set(["type", "file_data"]))
    && part?.type === "file_data"
    && hasOnlyKeys(file, new Set(["name", "mime_type", "url"]))
    && typeof file?.url === "string"
    && mimeType === PDF_MIME_TYPE
    && (!name || name.endsWith(".pdf"));
}

export function normalizeClientChatMessages(messages, limits = CLIENT_CHAT_LIMITS) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > limits.maxMessages) {
    fail("CHAT_REQUEST_INVALID");
  }
  let totalTextBytes = 0;
  let totalParts = 0;
  return messages.map((message) => {
    if (!hasOnlyKeys(message, new Set(["role", "content"]))
      || !["user", "assistant"].includes(message.role)) {
      fail("CHAT_REQUEST_INVALID");
    }
    if (typeof message.content === "string") {
      const byteLength = Buffer.byteLength(message.content, "utf8");
      if (byteLength > limits.maxMessageTextBytes) fail("CHAT_REQUEST_TOO_LARGE");
      totalTextBytes += byteLength;
      if (totalTextBytes > limits.maxTotalTextBytes) fail("CHAT_REQUEST_TOO_LARGE");
      return { role: message.role, content: message.content };
    }
    if (!Array.isArray(message.content) || message.content.length < 1) {
      fail("CHAT_REQUEST_INVALID");
    }
    totalParts += message.content.length;
    if (message.content.length > limits.maxPartsPerMessage || totalParts > limits.maxTotalParts) {
      fail("CHAT_REQUEST_TOO_LARGE");
    }
    const normalizedParts = message.content.map((part) => {
      if (isTextPart(part)) {
        const text = typeof part === "string" ? part : part.text;
        const byteLength = Buffer.byteLength(text, "utf8");
        totalTextBytes += byteLength;
        if (byteLength > limits.maxMessageTextBytes || totalTextBytes > limits.maxTotalTextBytes) {
          fail("CHAT_REQUEST_TOO_LARGE");
        }
        return { type: "text", text };
      }
      if (message.role === "user" && isValidatedImagePart(part)) {
        return {
          type: "image_url",
          image_url: {
            url: part.image_url.url,
            ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
          },
        };
      }
      if (message.role === "user" && isValidatedPdfPart(part)) {
        return {
          type: "file_data",
          file_data: {
            name: String(part.file_data.name || "document.pdf"),
            mime_type: PDF_MIME_TYPE,
            url: part.file_data.url,
          },
        };
      }
      fail("CHAT_REQUEST_INVALID");
    });
    if (normalizedParts.every((part) => part.type === "text")) {
      return {
        role: message.role,
        content: normalizedParts.map((part) => part.text).join("\n\n"),
      };
    }
    return { role: message.role, content: normalizedParts };
  });
}

export function assertChatAttachmentLimits(messages, limits = CHAT_ATTACHMENT_LIMITS) {
  let count = 0;
  let totalBytes = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (typeof message?.content === "string") continue;
    if (!Array.isArray(message?.content)) fail("CHAT_ATTACHMENT_INPUT_INVALID");
    for (const part of message.content) {
      if (isTextPart(part)) continue;
      let parsed = null;
      if (message?.role === "user" && isValidatedImagePart(part)) parsed = parseImageDataUrl(part.image_url.url);
      if (message?.role === "user" && isValidatedPdfPart(part)) parsed = parsePdfDataUrl(part.file_data.url);
      if (!parsed) fail("CHAT_ATTACHMENT_INPUT_INVALID");
      count += 1;
      totalBytes += parsed.byteLength;
      if (parsed.byteLength > limits.maxAttachmentBytes) fail("CHAT_ATTACHMENT_BYTES_EXCEEDED");
      if (count > limits.maxAttachments) fail("CHAT_ATTACHMENT_LIMIT_EXCEEDED");
      if (totalBytes > limits.maxTotalBytes) fail("CHAT_ATTACHMENT_BYTES_EXCEEDED");
    }
  }
  return { count, totalBytes };
}

export function createBoundedTaskRunner(maxConcurrency = CHAT_ATTACHMENT_LIMITS.maxConcurrency) {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 8) {
    throw new TypeError("CHAT_ATTACHMENT_CONCURRENCY_INVALID");
  }
  let active = 0;
  const queue = [];
  const dispatch = () => {
    while (active < maxConcurrency && queue.length) {
      const task = queue.shift();
      active += 1;
      Promise.resolve()
        .then(task.run)
        .then(task.resolve, task.reject)
        .finally(() => {
          active -= 1;
          dispatch();
        });
    }
  };
  return (run) => new Promise((resolve, reject) => {
    queue.push({ run, resolve, reject });
    dispatch();
  });
}

const globalAttachmentTaskRunner = createBoundedTaskRunner(CHAT_ATTACHMENT_LIMITS.maxConcurrency);

export function runBoundedAttachmentTask(run) {
  return globalAttachmentTaskRunner(run);
}
