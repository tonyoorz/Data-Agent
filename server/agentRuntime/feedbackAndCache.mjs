/**
 * P0-4: Feedback loop + semantic cache.
 * Thumb feedback flows back into intent/tool policy (negative examples
 * demote failing tool paths) and a planFingerprint-keyed semantic cache
 * reuses verified governed results for identical/similar queries.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const DEFAULT_FEEDBACK_DIR = path.resolve(process.cwd(), "logs", "agent-feedback");
const DEFAULT_CACHE_DIR = path.resolve(process.cwd(), "logs", "semantic-cache");
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h governed result reuse
const CACHE_MAX_ENTRIES = 200;

function nowDefault() {
  return new Date();
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ensureDir(dir) {
  return mkdir(dir, { recursive: true });
}

async function readJsonArray(file) {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

/** Jaccard over CJK-aware token bigrams — cheap similarity for feedback keys. */
export function similarity(left, right) {
  const a = new Set(tokenBigrams(String(left || "")));
  const b = new Set(tokenBigrams(String(right || "")));
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const gram of a) if (b.has(gram)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function tokenBigrams(text) {
  const normalized = text.toLowerCase().replace(/\s+/g, "");
  const grams = [];
  for (let i = 0; i < normalized.length - 1; i += 1) grams.push(normalized.slice(i, i + 2));
  if (normalized.length === 1) grams.push(normalized);
  return grams;
}

export function createFeedbackLoop({
  storeDir = process.env.VIZION_FEEDBACK_DIR || DEFAULT_FEEDBACK_DIR,
  now = nowDefault,
} = {}) {
  const file = path.join(storeDir, "feedback.jsonl");

  async function append(record) {
    await ensureDir(storeDir);
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
  }

  async function readAll() {
    const raw = await readFile(file, "utf8").catch(() => "");
    return raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  }

  return {
    /** Record a 👍/👎 and the routing context that produced the answer. */
    async recordThumb({ sessionId, queryText, intent, toolNames, thumb, note = "" }) {
      if (!["up", "down"].includes(thumb)) throw new Error(`FEEDBACK_INVALID thumb: ${thumb}`);
      const record = {
        at: now().toISOString(),
        sessionId: String(sessionId || ""),
        queryText: String(queryText || ""),
        intent: String(intent || "unknown"),
        toolNames: Array.isArray(toolNames) ? toolNames.map(String) : [],
        thumb,
        note: String(note || ""),
      };
      await append(record);
      return record;
    },

    /**
     * Derive policy adjustments from feedback history:
     * - intent-tool pairs with net negative signal get demoted,
     * - strongly positive pairs get promoted in toolset ordering hints.
     */
    async derivePolicyAdjustments() {
      const records = await readAll();
      const stats = new Map();
      for (const record of records) {
        const key = `${record.intent}::${record.toolNames.slice().sort().join(",")}`;
        const entry = stats.get(key) || { intent: record.intent, toolNames: record.toolNames, up: 0, down: 0, examples: [] };
        if (record.thumb === "up") entry.up += 1;
        else entry.down += 1;
        if (record.thumb === "down" && entry.examples.length < 3) {
          entry.examples.push({ queryText: record.queryText, note: record.note });
        }
        stats.set(key, entry);
      }
      const adjustments = [];
      for (const entry of stats.values()) {
        const net = entry.up - entry.down;
        const total = entry.up + entry.down;
        if (total < 2) continue;
        if (net <= -2) {
          adjustments.push({ action: "demote", weight: -Math.min(3, Math.abs(net)), ...entry });
        } else if (net >= 3) {
          adjustments.push({ action: "promote", weight: Math.min(3, net), ...entry });
        }
      }
      return adjustments;
    },

    /** Negative examples matching a new query (similarity > threshold). */
    async findSimilarNegatives(queryText, { threshold = 0.3, limit = 3 } = {}) {
      const records = await readAll();
      const negatives = records.filter((record) => record.thumb === "down");
      const scored = negatives
        .map((record) => ({ record, score: similarity(queryText, record.queryText) }))
        .filter((item) => item.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return scored;
    },
  };
}

export function createSemanticCache({
  cacheDir = process.env.VIZION_SEMANTIC_CACHE_DIR || DEFAULT_CACHE_DIR,
  now = nowDefault,
  ttlMs = CACHE_TTL_MS,
  similarityThreshold = 0.8,
} = {}) {
  const indexFile = path.join(cacheDir, "index.json");

  async function readIndex() {
    try {
      const parsed = JSON.parse(await readFile(indexFile, "utf8"));
      return isRecord(parsed) && Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      return [];
    }
  }

  async function writeIndex(entries) {
    await ensureDir(cacheDir);
    await writeFile(indexFile, JSON.stringify({ updatedAt: now().toISOString(), entries }, null, 2), "utf8");
  }

  function keyFor(queryPlan) {
    return String(queryPlan?.planFingerprint || queryPlan?.fingerprint || "");
  }

  function fresh(entry, at) {
    return at.getTime() - new Date(entry.cachedAt).getTime() <= ttlMs;
  }

  return {
    /** Exact planFingerprint lookup. */
    async get(planFingerprint) {
      const entries = await readIndex();
      const at = now();
      const hit = entries.find((entry) => entry.key === planFingerprint && fresh(entry, at));
      if (!hit) return null;
      return { ...hit.result, _cache: { hitAt: at.toISOString(), cachedAt: hit.cachedAt, via: "exact" } };
    },

    /** Fuzzy lookup by query text similarity (same governed intent shape). */
    async getSimilar(queryText, { intent } = {}) {
      const entries = await readIndex();
      const at = now();
      let best = null;
      let bestScore = 0;
      for (const entry of entries) {
        if (!fresh(entry, at)) continue;
        if (intent && entry.intent && entry.intent !== intent) continue;
        const score = similarity(queryText, entry.queryText);
        if (score > bestScore) { bestScore = score; best = entry; }
      }
      if (best && bestScore >= similarityThreshold) {
        return { ...best.result, _cache: { hitAt: at.toISOString(), cachedAt: best.cachedAt, via: `similar:${bestScore.toFixed(2)}` } };
      }
      return null;
    },

    /** Store a verified governed result. LRU-ish trim keeps index bounded. */
    async set({ planFingerprint, queryText, intent, result }) {
      if (!isRecord(result)) throw new Error("SEMANTIC_CACHE_INVALID: result must be object");
      const key = keyFor({ planFingerprint });
      if (!key) throw new Error("SEMANTIC_CACHE_INVALID: planFingerprint required");
      const entries = (await readIndex()).filter((entry) => entry.key !== key && fresh(entry, now()));
      entries.push({ key, planFingerprint, queryText: String(queryText || ""), intent: String(intent || ""), cachedAt: now().toISOString(), result });
      while (entries.length > CACHE_MAX_ENTRIES) entries.shift();
      await writeIndex(entries);
      return { key, entries: entries.length };
    },

    async clear() {
      await writeIndex([]);
    },

    stats() {
      return { ttlMs, maxEntries: CACHE_MAX_ENTRIES, similarityThreshold };
    },
  };
}
