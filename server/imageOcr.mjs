import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

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
  const url = readFirst(env, ["DUPSEARCH_OCR_URL", "OCR_URL"]);
  return {
    provider: readFirst(env, ["DUPSEARCH_OCR_PROVIDER", "OCR_PROVIDER"]).toLowerCase() || (url ? "remote" : "local-rapidocr"),
    url,
    apiKey: readFirst(env, ["DUPSEARCH_OCR_API_KEY", "OCR_API_KEY"]),
    authScheme: readFirst(env, ["DUPSEARCH_OCR_AUTH_SCHEME", "OCR_AUTH_SCHEME"]) || "Bearer",
    localPython: readFirst(env, ["DUPSEARCH_LOCAL_OCR_PYTHON", "LOCAL_OCR_PYTHON"]) || defaultLocalOcrPython(env),
    localScript: readFirst(env, ["DUPSEARCH_LOCAL_OCR_SCRIPT", "LOCAL_OCR_SCRIPT"]) || path.join(repoRoot, "backend", "local_ocr.py"),
    localTimeoutMs: Number(readFirst(env, ["DUPSEARCH_LOCAL_OCR_TIMEOUT_MS", "LOCAL_OCR_TIMEOUT_MS"]) || 120000),
    rapidOcrDetModel: readFirst(env, ["DUPSEARCH_RAPIDOCR_DET_MODEL", "RAPIDOCR_DET_MODEL"]),
    rapidOcrRecModel: readFirst(env, ["DUPSEARCH_RAPIDOCR_REC_MODEL", "RAPIDOCR_REC_MODEL"]),
    rapidOcrClsModel: readFirst(env, ["DUPSEARCH_RAPIDOCR_CLS_MODEL", "RAPIDOCR_CLS_MODEL"]),
  };
}

function parseDataUrl(imageUrl) {
  const match = String(imageUrl || "").match(/^data:([^;,]+)?;base64,(.*)$/s);
  if (!match) {
    return null;
  }

  return {
    mimeType: match[1] || "image/png",
    imageBase64: match[2] || "",
  };
}

async function parseOcrResponse(response) {
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (contentType.includes("application/json") || (!contentType && typeof response.json === "function")) {
    return normalizeOcrText(await response.json());
  }

  return normalizeOcrText(await response.text());
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
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
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
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
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

  if (config.provider === "local-rapidocr" || config.provider === "rapidocr") {
    const result = await (dependencies.localRapidOcrRunner || runLocalRapidOcr)({
      imageBase64: parsedDataUrl?.imageBase64 || "",
      mimeType: parsedDataUrl?.mimeType || "image/png",
      imageUrl: parsedDataUrl ? "" : String(imageUrl || ""),
      config,
    });
    const text = normalizeOcrText(result);
    if (!text) {
      throw new Error("Local RapidOCR returned empty text");
    }

    return { text };
  }

  if (!config.url) {
    throw new Error("Image OCR provider is not configured. Set DUPSEARCH_OCR_URL or OCR_URL.");
  }

  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey
        ? {
            Authorization: `${config.authScheme} ${config.apiKey}`.trim(),
          }
        : {}),
    },
    body: JSON.stringify({
      image: parsedDataUrl?.imageBase64 || "",
      mime: parsedDataUrl?.mimeType || "",
      imageUrl: parsedDataUrl ? undefined : String(imageUrl || ""),
    }),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`Image OCR request failed (${response.status}): ${message || response.statusText}`);
  }

  const text = await parseOcrResponse(response);
  if (!text) {
    throw new Error("Image OCR provider returned empty text");
  }

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

function isImagePart(part) {
  return part && typeof part === "object" && typeof part?.image_url?.url === "string";
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

  const imageOcrRunner = dependencies.imageOcrRunner || ((input) => recognizeImageText(input, env));

  return await Promise.all(
    messages.map(async (message) => {
      if (message?.role !== "user" || !Array.isArray(message?.content) || !message.content.some(isImagePart)) {
        return message;
      }

      const textParts = message.content.map(partToText).filter((part) => part.trim());
      const imageParts = message.content.filter(isImagePart);
      const ocrBlocks = [];

      for (let i = 0; i < imageParts.length; i += 1) {
        const imageUrl = imageParts[i].image_url.url;
        const result = await imageOcrRunner({
          imageUrl,
          index: i + 1,
        });
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