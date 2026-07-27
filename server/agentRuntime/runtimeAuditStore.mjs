import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_ROOT_DIR = path.resolve(process.cwd(), "logs", "agent-runtime");

function timestamp(now) {
  return now().toISOString();
}

function safeFileName(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

async function ensureParent(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function writeJson(filePath, payload) {
  await ensureParent(filePath);
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function appendJsonLine(filePath, payload) {
  await ensureParent(filePath);
  await appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

export function createFileAgentRuntimeStore({ rootDir = process.env.VIZION_AGENT_RUNTIME_STORE_DIR || DEFAULT_ROOT_DIR, now = () => new Date() } = {}) {
  return {
    rootDir,
    async writeThreadCheckpoint({ threadId, runId, actorScope, checkpoint }) {
      await writeJson(path.join(rootDir, "threads", `${safeFileName(threadId)}.json`), {
        threadId,
        runId,
        actorScope,
        checkpoint,
        updatedAt: timestamp(now),
      });
    },
    async appendRunEvent(event) {
      await appendJsonLine(path.join(rootDir, "run-events.jsonl"), {
        ...event,
        recordedAt: timestamp(now),
      });
    },
    async appendToolAudit(record) {
      await appendJsonLine(path.join(rootDir, "tool-calls.jsonl"), {
        ...record,
        recordedAt: timestamp(now),
      });
    },
  };
}