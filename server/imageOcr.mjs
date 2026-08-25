import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveLocalWorkerEnvironment } from "./localWorkerEnvironment.mjs";
import {
  assertChatAttachmentLimits,
  createBoundedTaskRunner,
  isValidatedImagePart,
  parseImageDataUrl,
  runBoundedAttachmentTask,
} from "./attachmentBoundary.mjs";
import {
  readBoundedResponseJson,
  readBoundedResponseText,
} from "./boundedResponseBody.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const DEFAULT_REMOTE_OCR_TIMEOUT_MS = 60_000;
const MAX_REMOTE_OCR_TIMEOUT_MS = 300_000;
const DEFAULT_LOCAL_OCR_TIMEOUT_MS = 120_000;
const MAX_OCR_RESPONSE_BYTES = 1024 * 1024;
const MAX_LOCAL_OCR_STDERR_BYTES = 64 * 1024;
const MAX_OCR_TEXT_BYTES = 512 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const LOCAL_PROVIDERS = new Set(["local-rapidocr", "rapidocr"]);
const REMOTE_PROVIDERS = new Set(["remote", "external"]);
const AUTH_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u;

export class ImageOcrBoundaryError extends Error {
  constructor(code) {
    super(code);
    this.name = "ImageOcrBoundaryError";
    this.code = code;
  }
}

function ocrFail(code) {
  throw new ImageOcrBoundaryError(code);
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

function normalizeOcrText(payload) {
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }

  for (const key of ["text", "ocrText", "content"]) {
    if (typeof payload?.[key] === "string" && payload[key].trim()) {
      return payload[key].trim();
    }
  }

  for (const key of ["result", "data"]) {
    const nested = normalizeOcrText(payload?.[key]);
    if (nested) {
      return nested;
    }
  }

  const lines = payload?.lines;
  if (Array.isArray(lines)) {
    return lines
      .map((line) => (typeof line === "string" ? line : line?.text))
      .filter((line) => typeof line === "string" && line.trim())
      .map((line) => line.trim())
      .join("\n")
      .trim();
  }

  return "";
}

export function resolveImageOcrConfig(env = process.env) {
  const rawUrl = readFirst(env, ["DUPSEARCH_OCR_URL", "OCR_URL"]);
  const provider = readFirst(env, ["DUPSEARCH_OCR_PROVIDER", "OCR_PROVIDER"]).toLowerCase()
    || "local-rapidocr";
  if (!LOCAL_PROVIDERS.has(provider) && !REMOTE_PROVIDERS.has(provider)) {
    ocrFail("IMAGE_OCR_PROVIDER_INVALID");
  }
  const url = REMOTE_PROVIDERS.has(provider) && rawUrl ? secureOcrUrl(rawUrl) : "";
  const authScheme = readFirst(env, ["DUPSEARCH_OCR_AUTH_SCHEME", "OCR_AUTH_SCHEME"]) || "Bearer";
  if (!AUTH_SCHEME_PATTERN.test(authScheme)) {
    ocrFail("IMAGE_OCR_AUTH_SCHEME_INVALID");
  }
  return {
    provider,
    url,
    apiKey: readFirst(env, ["DUPSEARCH_OCR_API_KEY", "OCR_API_KEY"]),
    authScheme,
    localPython: readFirst(env, ["DUPSEARCH_LOCAL_OCR_PYTHON", "LOCAL_OCR_PYTHON"]) || defaultLocalOcrPython(env),
    localScript: readFirst(env, ["DUPSEARCH_LOCAL_OCR_SCRIPT", "LOCAL_OCR_SCRIPT"]) || path.join(repoRoot, "backend", "local_ocr.py"),
    localTimeoutMs: resolveFiniteTimeout(
      readFirst(env, ["DUPSEARCH_LOCAL_OCR_TIMEOUT_MS", "LOCAL_OCR_TIMEOUT_MS"]),
      DEFAULT_LOCAL_OCR_TIMEOUT_MS,
      MAX_REMOTE_OCR_TIMEOUT_MS,
      "IMAGE_OCR_LOCAL_TIMEOUT_INVALID",
    ),
    remoteTimeoutMs: resolveFiniteTimeout(
      readFirst(env, ["DUPSEARCH_OCR_TIMEOUT_MS", "OCR_TIMEOUT_MS"]),
      DEFAULT_REMOTE_OCR_TIMEOUT_MS,
      MAX_REMOTE_OCR_TIMEOUT_MS,
      "IMAGE_OCR_REMOTE_TIMEOUT_INVALID",
    ),
    rapidOcrDetModel: readFirst(env, ["DUPSEARCH_RAPIDOCR_DET_MODEL", "RAPIDOCR_DET_MODEL"]),
    rapidOcrRecModel: readFirst(env, ["DUPSEARCH_RAPIDOCR_REC_MODEL", "RAPIDOCR_REC_MODEL"]),
    rapidOcrClsModel: readFirst(env, ["DUPSEARCH_RAPIDOCR_CLS_MODEL", "RAPIDOCR_CLS_MODEL"]),
  };
}

function resolveFiniteTimeout(value, fallback, maximum, errorCode) {
  const configured = String(value || "").trim();
  if (!configured) return fallback;
  if (!/^\d+$/u.test(configured)) ocrFail(errorCode);
  const timeoutMs = Number(configured);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximum) {
    ocrFail(errorCode);
  }
  return timeoutMs;
}

function secureOcrUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    ocrFail("IMAGE_OCR_URL_INVALID");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK_HOSTS.has(hostname)))
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    ocrFail("IMAGE_OCR_URL_INVALID");
  }
  return parsed.toString();
}

function parseDataUrl(imageUrl) {
  let parsed;
  try {
    parsed = parseImageDataUrl(imageUrl);
  } catch {
    ocrFail("IMAGE_OCR_INPUT_INVALID");
  }

  return {
    mimeType: parsed.mimeType,
    imageBase64: parsed.base64,
  };
}

async function parseOcrResponse(response) {
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (contentType.includes("application/json") || (!contentType && typeof response.json === "function")) {
    return normalizeOcrText(await readBoundedResponseJson(response, {
      maxBytes: MAX_OCR_RESPONSE_BYTES,
      errorCode: "IMAGE_OCR_UPSTREAM_RESPONSE_TOO_LARGE",
    }));
  }

  return normalizeOcrText(await readBoundedResponseText(response, {
    maxBytes: MAX_OCR_RESPONSE_BYTES,
    errorCode: "IMAGE_OCR_UPSTREAM_RESPONSE_TOO_LARGE",
  }));
}

export async function runLocalRapidOcr({ imageBase64, mimeType, imageUrl, config }) {
  const payload = JSON.stringify({
    image: String(imageBase64 || ""),
    mime: String(mimeType || "image/png"),
    imageUrl: imageBase64 ? "" : String(imageUrl || ""),
    detModel: config.rapidOcrDetModel,
    recModel: config.rapidOcrRecModel,
    clsModel: config.rapidOcrClsModel,
  });

  return await new Promise((resolve, reject) => {
    const child = spawn(config.localPython, [config.localScript], {
      cwd: repoRoot,
      env: resolveLocalWorkerEnvironment(process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeoutMs = Number.isFinite(config.localTimeoutMs) ? config.localTimeoutMs : 120000;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Local RapidOCR timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(chunk, "utf8") > MAX_OCR_RESPONSE_BYTES) {
        child.kill("SIGTERM");
        reject(new ImageOcrBoundaryError("IMAGE_OCR_LOCAL_OUTPUT_LIMIT_EXCEEDED"));
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (Buffer.byteLength(stderr, "utf8") + Buffer.byteLength(chunk, "utf8") > MAX_LOCAL_OCR_STDERR_BYTES) {
        child.kill("SIGTERM");
        reject(new ImageOcrBoundaryError("IMAGE_OCR_LOCAL_OUTPUT_LIMIT_EXCEEDED"));
        return;
      }
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Local RapidOCR failed (${code}): ${stderr.trim() || stdout.trim()}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error(`Local RapidOCR returned invalid JSON: ${stdout.trim() || stderr.trim()}`));
      }
    });

    child.stdin.end(payload);
  });
}

export async function recognizeImageText({ imageUrl }, env = process.env, dependencies = {}) {
  const config = resolveImageOcrConfig(env);
  const parsedDataUrl = parseDataUrl(imageUrl);

  if (LOCAL_PROVIDERS.has(config.provider)) {
    const result = await (dependencies.localRapidOcrRunner || runLocalRapidOcr)({
      imageBase64: parsedDataUrl.imageBase64,
      mimeType: parsedDataUrl.mimeType,
      imageUrl: "",
      config,
    });
    const text = normalizeOcrText(result);
    if (!text) {
      throw new Error("Local RapidOCR returned empty text");
    }
    if (Buffer.byteLength(text, "utf8") > MAX_OCR_TEXT_BYTES) {
      ocrFail("IMAGE_OCR_TEXT_LIMIT_EXCEEDED");
    }

    return { text };
  }

  if (!config.url) {
    ocrFail("IMAGE_OCR_URL_REQUIRED");
  }

  if (!config.apiKey) ocrFail("IMAGE_OCR_API_KEY_REQUIRED");
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") ocrFail("IMAGE_OCR_UPSTREAM_UNAVAILABLE");
  const timeoutSignal = dependencies.timeoutSignal || ((timeoutMs) => AbortSignal.timeout(timeoutMs));
  const signal = dependencies.signal || timeoutSignal(config.remoteTimeoutMs);
  let response;
  try {
    response = await fetchImpl(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `${config.authScheme} ${config.apiKey}`,
      },
      body: JSON.stringify({
        image: parsedDataUrl.imageBase64,
        mime: parsedDataUrl.mimeType,
      }),
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (error?.code === "IMAGE_OCR_UPSTREAM_RESPONSE_TOO_LARGE") {
      ocrFail("IMAGE_OCR_UPSTREAM_RESPONSE_TOO_LARGE");
    }
    if (signal?.aborted || error?.name === "AbortError" || error?.name === "TimeoutError") {
      ocrFail("IMAGE_OCR_UPSTREAM_TIMEOUT");
    }
    ocrFail("IMAGE_OCR_UPSTREAM_UNAVAILABLE");
  }

  if (!response?.ok) {
    try {
      response?.body?.cancel?.().catch?.(() => {});
    } catch {
      // Ignore disposal errors while preserving the stable boundary error.
    }
    ocrFail("IMAGE_OCR_UPSTREAM_HTTP_ERROR");
  }

  let text;
  try {
    text = await parseOcrResponse(response);
  } catch (error) {
    if (error?.code === "IMAGE_OCR_UPSTREAM_RESPONSE_TOO_LARGE") {
      ocrFail("IMAGE_OCR_UPSTREAM_RESPONSE_TOO_LARGE");
    }
    if (signal?.aborted || error?.name === "AbortError" || error?.name === "TimeoutError") {
      ocrFail("IMAGE_OCR_UPSTREAM_TIMEOUT");
    }
    ocrFail("IMAGE_OCR_UPSTREAM_INVALID_RESPONSE");
  }
  if (!text) ocrFail("IMAGE_OCR_UPSTREAM_EMPTY_RESPONSE");
  if (Buffer.byteLength(text, "utf8") > MAX_OCR_TEXT_BYTES) ocrFail("IMAGE_OCR_TEXT_LIMIT_EXCEEDED");

  return { text };
}

function defaultLocalOcrPython(env = process.env) {
  const candidates = [
    env.VIZION_OCR_PYTHON,
    env.VIZION_ANALYTICS_PYTHON,
    env.DUPSEARCH_AGENT_PYTHON,
    path.join(repoRoot, ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python"),
    "python",
  ];

  return candidates.map((value) => String(value || "").trim()).find(Boolean) || "python";
}

function partToText(part) {
  if (typeof part === "string") {
    return part;
  }
  if (part && typeof part === "object" && typeof part.text === "string") {
    return part.text;
  }

  return "";
}

export async function expandImageMessagesWithOcr(messages, env = process.env, dependencies = {}) {
  if (!Array.isArray(messages)) {
    return messages;
  }

  assertChatAttachmentLimits(messages, dependencies.attachmentLimits);
  const imageOcrRunner = dependencies.imageOcrRunner || ((input) => recognizeImageText(input, env));
  const runBounded = dependencies.maxConcurrency === undefined
    ? runBoundedAttachmentTask
    : createBoundedTaskRunner(dependencies.maxConcurrency);

  return await Promise.all(
    messages.map(async (message) => {
      if (message?.role !== "user" || !Array.isArray(message?.content) || !message.content.some(isValidatedImagePart)) {
        return message;
      }

      const textParts = message.content.map(partToText).filter((part) => part.trim());
      const imageParts = message.content.filter(isValidatedImagePart);
      const ocrBlocks = [];

      for (let i = 0; i < imageParts.length; i += 1) {
        const imageUrl = imageParts[i].image_url.url;
        const result = await runBounded(() => imageOcrRunner({
          imageUrl,
          index: i + 1,
        }));
        const text = normalizeOcrText(result);
        if (!text) {
          throw new Error(`Image ${i + 1} OCR returned empty text`);
        }
        ocrBlocks.push(`Image ${i + 1} OCR text:\n${text}`);
      }

      return {
        ...message,
        content: [...textParts, ...ocrBlocks].join("\n\n").trim() || "(image OCR text)",
      };
    }),
  );
}
