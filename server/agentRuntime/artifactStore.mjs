import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { inspectUntrustedText } from "./untrustedContent.mjs";

const DEFAULT_LIMITS = Object.freeze({
  perArtifactBytes: 8 * 1024 * 1024,
  perRunBytes: 20 * 1024 * 1024,
  perActorBytes: 200 * 1024 * 1024,
  maxRunArtifacts: 5,
  extractedTextChars: 200_000,
  extractionTimeoutMs: 30_000,
});

const ALLOWED = new Set(["text/plain", "text/markdown", "application/json", "application/pdf", "image/png", "image/jpeg", "image/webp"]);

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { code, statusCode, retryable: false });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sniff(bytes) {
  if (bytes.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return "text/plain";
  } catch {}
  return "application/octet-stream";
}

function validateMime({ declaredMime, sniffedMime, bytes }) {
  if (!ALLOWED.has(declaredMime)) fail("MIME_NOT_ALLOWED");
  if (["text/plain", "text/markdown"].includes(declaredMime) && sniffedMime === "text/plain") return declaredMime;
  if (declaredMime === "application/json" && sniffedMime === "text/plain") {
    try { JSON.parse(bytes.toString("utf8")); } catch { fail("JSON_INVALID"); }
    return declaredMime;
  }
  if (declaredMime !== sniffedMime) fail("MIME_MISMATCH");
  return declaredMime;
}

function publicArtifact(row) {
  return {
    artifactId: row.artifact_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    contentHash: row.content_hash,
    expiresAt: row.expires_at,
  };
}

function runWorker({ bytes, mimeType, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./artifactExtractionWorker.mjs", import.meta.url), {
      workerData: { bytes, mimeType },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    };
    const timeout = setTimeout(() => {
      worker.terminate().catch(() => {});
      settle(reject, new Error("EXTRACTION_TIMEOUT"));
    }, timeoutMs);
    worker.once("message", (message) => {
      worker.terminate().finally(() => {
        if (message.ok) settle(resolve, message.result);
        else settle(reject, new Error(message.error));
      });
    });
    worker.once("error", (error) => {
      worker.terminate().catch(() => {});
      settle(reject, error);
    });
  });
}

export function createArtifactStore({ db, artifactRoot, now, randomUUID, limits = {} }) {
  const cfg = { ...DEFAULT_LIMITS, ...limits };
  fs.mkdirSync(artifactRoot, { recursive: true });

  function actorQuotaBytes(actor) {
    return Number(db.prepare("SELECT COALESCE(SUM(size_bytes),0) FROM agent_artifacts WHERE actor_id=? AND expires_at > ?").pluck().get(actor.actorId, now()));
  }

  const putTx = db.transaction(({ actor, threadId, fileName, declaredMime, bytes }) => {
    if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
    if (bytes.length > cfg.perArtifactBytes) fail("ARTIFACT_TOO_LARGE", 413);
    const thread = db.prepare("SELECT 1 FROM agent_threads WHERE thread_id=? AND actor_id=? AND deleted_at IS NULL").get(threadId, actor.actorId);
    if (!thread) fail("THREAD_NOT_FOUND", 404);
    const mimeType = validateMime({ declaredMime, sniffedMime: sniff(bytes), bytes });
    const contentHash = sha256(bytes);
    const existing = db.prepare("SELECT * FROM agent_artifacts WHERE actor_id=? AND content_hash=? AND expires_at > ?").get(actor.actorId, contentHash, now());
    if (existing) {
      db.prepare("INSERT OR IGNORE INTO agent_thread_artifacts(thread_id,artifact_id,scope_hash,created_at) VALUES(?,?,?,?)").run(threadId, existing.artifact_id, actor.scopeHash, now());
      return publicArtifact(existing);
    }
    if (actorQuotaBytes(actor) + bytes.length > cfg.perActorBytes) fail("ACTOR_ARTIFACT_QUOTA_EXCEEDED", 429);
    const storagePath = path.join(artifactRoot, contentHash);
    try { fs.writeFileSync(storagePath, bytes, { flag: "wx" }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
    db.prepare("INSERT OR IGNORE INTO agent_artifact_blobs(content_hash,mime_type,size_bytes,storage_path,created_at) VALUES(?,?,?,?,?)").run(contentHash, mimeType, bytes.length, storagePath, now());
    const artifactId = randomUUID();
    const displayName = path.basename(String(fileName || "artifact"));
    const expiresAt = new Date(Date.parse(now()) + 7 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("INSERT INTO agent_artifacts(artifact_id,actor_id,workspace_scope_hash,file_name,mime_type,size_bytes,content_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)").run(artifactId, actor.actorId, actor.scopeHash, displayName, mimeType, bytes.length, contentHash, now(), expiresAt);
    db.prepare("INSERT INTO agent_thread_artifacts(thread_id,artifact_id,scope_hash,created_at) VALUES(?,?,?,?)").run(threadId, artifactId, actor.scopeHash, now());
    return publicArtifact(db.prepare("SELECT * FROM agent_artifacts WHERE artifact_id=?").get(artifactId));
  });

  function get({ actor, artifactId }) {
    const row = db.prepare("SELECT a.*, b.storage_path FROM agent_artifacts a JOIN agent_artifact_blobs b ON b.content_hash=a.content_hash WHERE a.artifact_id=? AND a.actor_id=? AND a.expires_at > ?").get(artifactId, actor.actorId, now());
    if (!row) fail("ARTIFACT_NOT_FOUND", 404);
    return { ...publicArtifact(row), bytes: fs.readFileSync(row.storage_path) };
  }

  const attachToRun = db.transaction(({ actor, runId, artifactIds }) => {
    if (!Array.isArray(artifactIds) || artifactIds.length > cfg.maxRunArtifacts) fail("RUN_ARTIFACT_COUNT_EXCEEDED");
    const run = db.prepare("SELECT * FROM agent_runs WHERE run_id=? AND actor_id=?").get(runId, actor.actorId);
    if (!run) fail("RUN_NOT_FOUND", 404);
    const rows = artifactIds.map((artifactId) => {
      const row = db.prepare("SELECT * FROM agent_artifacts WHERE artifact_id=? AND actor_id=? AND expires_at > ?").get(artifactId, actor.actorId, now());
      if (!row) fail("ARTIFACT_NOT_FOUND", 404);
      return row;
    });
    const totalBytes = rows.reduce((sum, row) => sum + row.size_bytes, 0);
    if (totalBytes > cfg.perRunBytes) fail("RUN_ARTIFACT_BYTES_EXCEEDED", 413);
    for (const row of rows) {
      db.prepare("INSERT OR IGNORE INTO agent_run_artifacts(run_id,artifact_id,size_bytes,created_at) VALUES(?,?,?,?)").run(runId, row.artifact_id, row.size_bytes, now());
    }
    return rows.map(publicArtifact);
  });

  async function extractText({ actor, artifactId }) {
    const artifact = get({ actor, artifactId });
    const result = await runWorker({ bytes: artifact.bytes, mimeType: artifact.mimeType, timeoutMs: cfg.extractionTimeoutMs });
    const truncated = result.text.length > cfg.extractedTextChars;
    const text = truncated ? result.text.slice(0, cfg.extractedTextChars) : result.text;
    const binding = db.prepare("SELECT thread_id FROM agent_thread_artifacts WHERE artifact_id=? LIMIT 1").get(artifactId);
    if (!binding) fail("ARTIFACT_NOT_ATTACHED");
    const textRef = await putTx({ actor, threadId: binding.thread_id, fileName: `${artifact.fileName}.txt`, declaredMime: "text/plain", bytes: Buffer.from(text, "utf8") });
    db.prepare("UPDATE agent_artifact_blobs SET extraction_json=? WHERE content_hash=?").run(JSON.stringify({ textRef: textRef.artifactId, truncated, pageCount: result.pageCount || 0, parserVersion: result.parserVersion }), artifact.contentHash);
    return { textRef: textRef.artifactId, text, truncated, pageCount: result.pageCount || 0, parserVersion: result.parserVersion };
  }

  const cleanupExpired = db.transaction(({ asOf = now() } = {}) => {
    const expired = db.prepare("SELECT a.artifact_id, b.content_hash, b.storage_path FROM agent_artifacts a JOIN agent_artifact_blobs b ON b.content_hash=a.content_hash WHERE a.expires_at <= ?").all(asOf);
    for (const row of expired) {
      db.prepare("DELETE FROM agent_run_artifacts WHERE artifact_id=?").run(row.artifact_id);
      db.prepare("DELETE FROM agent_thread_artifacts WHERE artifact_id=?").run(row.artifact_id);
      db.prepare("DELETE FROM agent_artifacts WHERE artifact_id=?").run(row.artifact_id);
    }
    const removedBlobs = [];
    for (const row of expired) {
      const stillReferenced = db.prepare("SELECT 1 FROM agent_artifacts WHERE content_hash=? LIMIT 1").get(row.content_hash);
      if (!stillReferenced) {
        db.prepare("DELETE FROM agent_artifact_blobs WHERE content_hash=?").run(row.content_hash);
        try { fs.unlinkSync(row.storage_path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
        removedBlobs.push(row.content_hash);
      }
    }
    return { expiredArtifacts: expired.length, removedBlobs: removedBlobs.length };
  });

  async function prepareForRun({ actor, runId, artifactIds }) {
    const run = db.prepare("SELECT 1 FROM agent_runs WHERE run_id=? AND actor_id=?").get(runId, actor.actorId);
    if (!run) fail("RUN_NOT_FOUND", 404);
    const prepared = [];
    for (const artifactId of artifactIds || []) {
      const attached = db.prepare("SELECT 1 FROM agent_run_artifacts WHERE run_id=? AND artifact_id=?").get(runId, artifactId);
      if (!attached) fail("ARTIFACT_NOT_ATTACHED", 404);
      const artifact = get({ actor, artifactId });
      const extracted = await extractText({ actor, artifactId });
      const inspection = inspectUntrustedText(extracted.text);
      prepared.push({
        artifactId,
        contentHash: artifact.contentHash,
        mimeType: artifact.mimeType,
        textRef: extracted.textRef,
        parserVersion: extracted.parserVersion,
        truncated: extracted.truncated,
        classification: inspection.classification,
        directiveLikeContent: inspection.directiveLikeContent,
        warningCodes: inspection.warningCodes,
      });
    }
    return prepared;
  }

  return { put: async (input) => putTx(input), get, attachToRun, extractText, prepareForRun, cleanupExpired };
}
