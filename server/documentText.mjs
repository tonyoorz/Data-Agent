import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveLocalWorkerEnvironment } from "./localWorkerEnvironment.mjs";
import {
  ChatAttachmentBoundaryError,
  assertChatAttachmentLimits,
  createBoundedTaskRunner,
  isValidatedPdfPart,
  parsePdfDataUrl,
  runBoundedAttachmentTask,
} from "./attachmentBoundary.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const MAX_PDF_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PDF_STDERR_BYTES = 64 * 1024;
const MAX_PDF_TEXT_BYTES = 1024 * 1024;

function readFirst(env, keys) {
  for (const key of keys) {
    const value = String(env?.[key] ?? "").trim();
    if (value) {
      return value;
    }
  }

  return "";
}

function normalizeText(payload) {
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }
  if (typeof payload?.text === "string" && payload.text.trim()) {
    return payload.text.trim();
  }
  const pages = payload?.pages;
  if (Array.isArray(pages)) {
    return pages
      .map((page) => (typeof page === "string" ? page : page?.text))
      .filter((text) => typeof text === "string" && text.trim())
      .map((text) => text.trim())
      .join("\n\n")
      .trim();
  }
  return "";
}

export function resolveDocumentTextConfig(env = process.env) {
  return {
    localPython: readFirst(env, ["DUPSEARCH_LOCAL_PDF_PYTHON", "LOCAL_PDF_PYTHON"]) || defaultLocalPdfPython(env),
    localScript: readFirst(env, ["DUPSEARCH_LOCAL_PDF_SCRIPT", "LOCAL_PDF_SCRIPT"]) || path.join(repoRoot, "backend", "local_pdf_text.py"),
    localTimeoutMs: Number(readFirst(env, ["DUPSEARCH_LOCAL_PDF_TIMEOUT_MS", "LOCAL_PDF_TIMEOUT_MS"]) || 120000),
  };
}

export async function runLocalPdfTextExtraction({ fileBase64, mimeType, name, config }) {
  const payload = JSON.stringify({
    file: String(fileBase64 || ""),
    mime: String(mimeType || "application/pdf"),
    name: String(name || "document.pdf"),
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
      reject(new Error(`Local PDF text extraction timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(chunk, "utf8") > MAX_PDF_RESPONSE_BYTES) {
        child.kill("SIGTERM");
        reject(new ChatAttachmentBoundaryError("CHAT_ATTACHMENT_WORKER_OUTPUT_EXCEEDED"));
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (Buffer.byteLength(stderr, "utf8") + Buffer.byteLength(chunk, "utf8") > MAX_PDF_STDERR_BYTES) {
        child.kill("SIGTERM");
        reject(new ChatAttachmentBoundaryError("CHAT_ATTACHMENT_WORKER_OUTPUT_EXCEEDED"));
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
        reject(new Error(`Local PDF text extraction failed (${code}): ${stderr.trim() || stdout.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error(`Local PDF text extraction returned invalid JSON: ${stdout.trim() || stderr.trim()}`));
      }
    });

    child.stdin.end(payload);
  });
}

export async function expandMessagesWithDocumentText(messages, env = process.env, dependencies = {}) {
  if (!Array.isArray(messages)) {
    return messages;
  }

  assertChatAttachmentLimits(messages, dependencies.attachmentLimits);
  const config = resolveDocumentTextConfig(env);
  const documentTextRunner = dependencies.documentTextRunner || runLocalPdfTextExtraction;
  const runBounded = dependencies.maxConcurrency === undefined
    ? runBoundedAttachmentTask
    : createBoundedTaskRunner(dependencies.maxConcurrency);

  return await Promise.all(
    messages.map(async (message) => {
      if (message?.role !== "user" || !Array.isArray(message?.content) || !message.content.some(isValidatedPdfPart)) {
        return message;
      }

      const expandedParts = [];
      let attachmentIndex = 0;
      for (const part of message.content) {
        if (!isValidatedPdfPart(part)) {
          expandedParts.push(part);
          continue;
        }

        attachmentIndex += 1;
        const file = part.file_data;
        const parsed = parsePdfDataUrl(file.url);
        const result = await runBounded(() => documentTextRunner({
          fileBase64: parsed.base64,
          mimeType: parsed.mimeType,
          name: String(file.name || `attachment-${attachmentIndex}.pdf`),
          config,
        }));
        const text = normalizeText(result);
        if (!text) {
          throw new Error(`Attachment ${attachmentIndex} PDF text extraction returned empty text`);
        }
        if (Buffer.byteLength(text, "utf8") > MAX_PDF_TEXT_BYTES) {
          throw new ChatAttachmentBoundaryError("CHAT_ATTACHMENT_TEXT_EXCEEDED");
        }
        expandedParts.push({
          type: "text",
          text: `Attachment ${attachmentIndex} text from ${file.name || "document.pdf"}:\n${text}`,
        });
      }

      return {
        ...message,
        content: expandedParts.every((part) => typeof part?.text === "string")
          ? expandedParts.map((part) => part.text).filter((text) => text.trim()).join("\n\n")
          : expandedParts,
      };
    }),
  );
}

function defaultLocalPdfPython(env = process.env) {
  const candidates = [
    env.VIZION_PDF_PYTHON,
    env.VIZION_ANALYTICS_PYTHON,
    env.DUPSEARCH_AGENT_PYTHON,
    path.join(repoRoot, ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python"),
    "python",
  ];

  return candidates.map((value) => String(value || "").trim()).find(Boolean) || "python";
}
