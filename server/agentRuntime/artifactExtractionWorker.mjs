import { parentPort, workerData } from "node:worker_threads";

globalThis.fetch = async () => { throw new Error("NETWORK_DENIED"); };
globalThis.XMLHttpRequest = undefined;

function decodeUtf8(bytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function countPdfPages(buffer) {
  const text = buffer.toString("latin1");
  return (text.match(/\/Type\s*\/Page\b/g) || []).length;
}

async function extract({ bytes, mimeType }) {
  const buffer = Buffer.from(bytes);
  if (["text/plain", "text/markdown"].includes(mimeType)) {
    return { text: decodeUtf8(buffer), parserVersion: "text-v1" };
  }
  if (mimeType === "application/json") {
    const text = decodeUtf8(buffer);
    JSON.parse(text);
    return { text, parserVersion: "json-v1" };
  }
  if (mimeType === "application/pdf") {
    const pageCount = countPdfPages(buffer);
    if (pageCount > 100) throw new Error("PDF_PAGE_LIMIT_EXCEEDED");
    return { text: buffer.toString("latin1"), pageCount, parserVersion: "pdf-basic-v1" };
  }
  if (["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
    return { text: "", parserVersion: "image-placeholder-v1" };
  }
  throw new Error("UNSUPPORTED_MIME");
}

extract(workerData).then(
  (result) => parentPort.postMessage({ ok: true, result }),
  (error) => parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }),
);