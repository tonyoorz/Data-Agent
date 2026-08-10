import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_ROOT_DIR = path.resolve(process.cwd(), "logs", "agent-runtime");
const ACTOR_SCOPED_THREAD_KEY_RE = /^actor-thread-[a-f0-9]{64}$/;

function timestamp(now) {
  return now().toISOString();
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
    async writeThreadCheckpoint({ persistenceKey, threadId, runId, actorScope, checkpoint }) {
      if (!ACTOR_SCOPED_THREAD_KEY_RE.test(String(persistenceKey || ""))) {
        throw new Error("ACTOR_SCOPED_THREAD_KEY_REQUIRED");
      }
      await writeJson(path.join(rootDir, "threads", `${persistenceKey}.json`), {
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
    async appendRunSummary(summary) {
      await appendJsonLine(path.join(rootDir, "run-summaries.jsonl"), {
        ...summary,
        recordedAt: timestamp(now),
      });
    },
  };
}
