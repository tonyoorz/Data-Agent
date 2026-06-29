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

function parseDataUrl(url) {
  const match = String(url || "").match(/^data:([^;,]+)?;base64,(.*)$/s);
  if (!match) {
    return null;
  }
  return {
    mimeType: match[1] || "application/octet-stream",
    fileBase64: match[2] || "",
  };
}

function isPdfFilePart(part) {
  const file = part?.file_data;
  const mimeType = String(file?.mime_type || file?.mime || "").toLowerCase();
  const name = String(file?.name || "").toLowerCase();
  return part?.type === "file_data" && typeof file?.url === "string" && (mimeType === "application/pdf" || name.endsWith(".pdf"));
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
      reject(new Error(`Local PDF text extraction timed out after ${timeoutMs}ms`));
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

  const config = resolveDocumentTextConfig(env);
  const documentTextRunner = dependencies.documentTextRunner || runLocalPdfTextExtraction;

  return await Promise.all(
    messages.map(async (message) => {
      if (message?.role !== "user" || !Array.isArray(message?.content) || !message.content.some(isPdfFilePart)) {
        return message;
      }

      const expandedParts = [];
      let attachmentIndex = 0;
      for (const part of message.content) {
        if (!isPdfFilePart(part)) {
          expandedParts.push(part);
          continue;
        }

        attachmentIndex += 1;
        const file = part.file_data;
        const parsed = parseDataUrl(file.url);
        const result = await documentTextRunner({
          fileBase64: parsed?.fileBase64 || "",
          mimeType: parsed?.mimeType || String(file.mime_type || "application/pdf"),
          name: String(file.name || `attachment-${attachmentIndex}.pdf`),
          config,
        });
        const text = normalizeText(result);
        if (!text) {
          throw new Error(`Attachment ${attachmentIndex} PDF text extraction returned empty text`);
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