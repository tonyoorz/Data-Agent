/**
 * SchemaLinker (P0-B1): vector-retrieval schema linking over the governed ontology.
 * Default backend: TF-IDF cosine over CJK-aware char bigrams (no external deps).
 * Pluggable embedder backend for production BGE service — inject { embed, dims }.
 *
 * Role in the pipeline: a SAFETY NET for resolver misses (G3 gap: resolver only
 * does exact/alias term matching). linkQueryTokens() suggests candidate
 * dims/metrics/entities; suggestions never bypass validator — they feed resolve().
 */

const STOP_CHARS = /[，。、；：？！,.;:?!()\[\]{}"'`\s]/g;

/** CJK-aware tokenizer: ascii word tokens + CJK char bigrams (+ unigram fallback for 1-char runs). */
export function tokenize(text) {
  const normalized = String(text || "").toLowerCase().replace(STOP_CHARS, " ");
  const tokens = [];
  const segments = normalized.split(/\s+/).filter(Boolean);
  for (const seg of segments) {
    const ascii = seg.match(/[a-z0-9_]+/g);
    if (ascii && ascii.join("") === seg) {
      tokens.push(seg);
      continue;
    }
    let buf = "";
    const flush = () => {
      if (!buf) return;
      if (/^[a-z0-9_]+$/.test(buf)) tokens.push(buf);
      else if (buf.length === 1) tokens.push(buf);
      else for (let i = 0; i < buf.length - 1; i++) tokens.push(buf.slice(i, i + 2));
      buf = "";
    };
    for (const ch of seg) {
      if (/[a-z0-9_]/.test(ch)) buf += ch;
      else {
        flush();
        buf = ch;
        flush();
      }
    }
    flush();
  }
  return tokens;
}

function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    const w = b.get(k);
    if (w) dot += v * w;
  }
  for (const [, v] of b) nb += v * v;
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

const LABEL_SUFFIXES = {
  metrics: [
    (m) => m.id,
    (m) => m.labels?.["zh-CN"] ?? "",
    (m) => m.labels?.["en-US"] ?? "",
  ],
  dimensions: [
    (d) => d.id,
    (d) => d.labels?.["zh-CN"] ?? "",
    (d) => d.labels?.["en-US"] ?? "",
  ],
  entities: [
    (e) => e.id,
    (e) => e.labels?.["zh-CN"] ?? "",
    (e) => e.labels?.["en-US"] ?? "",
    (e) => (e.aliases ?? []).join(" "),
  ],
};

export function createSchemaLinker({ ontology, embedder = null, topK = 5, minScore = 0.05 } = {}) {
  if (!ontology) throw new Error("SCHEMA_LINKER_INVALID: ontology bundle required");

  // --- TF-IDF index over term phrases + catalog labels ---
  const corpusEntries = []; // { kind:'term'|'metric'|'dim'|'entity', id, resolution, tokens }
  const allText = [];

  for (const term of ontology.terms ?? []) {
    const phrases = (term.phrases ?? []).join(" ");
    if (!phrases) continue;
    const resolution = term.resolution ?? {};
    const entry = { kind: "term", id: term.id, resolution, tokens: tokenize(phrases) };
    corpusEntries.push(entry);
    allText.push(entry);
    // resolve-to labels so metric/dim names share terminology mass
    if (resolution.metricId) corpusEntries.push({ kind: "metric", id: resolution.metricId, resolution, tokens: tokenize(phrases) });
    if (resolution.dimensionId) corpusEntries.push({ kind: "dim", id: resolution.dimensionId, resolution, tokens: tokenize(phrases) });
    if (resolution.entityId) corpusEntries.push({ kind: "entity", id: resolution.entityId, resolution, tokens: tokenize(phrases) });
  }
  for (const metric of ontology.metrics ?? []) {
    const text = LABEL_SUFFIXES.metrics.map((f) => f(metric)).filter(Boolean).join(" ");
    corpusEntries.push({ kind: "metric", id: metric.id, resolution: { metricId: metric.id }, tokens: tokenize(text) });
  }
  for (const dim of ontology.dimensions ?? []) {
    const text = LABEL_SUFFIXES.dimensions.map((f) => f(dim)).filter(Boolean).join(" ");
    corpusEntries.push({ kind: "dim", id: dim.id, resolution: { dimensionId: dim.id }, tokens: tokenize(text) });
  }
  for (const entity of ontology.entities ?? []) {
    const text = LABEL_SUFFIXES.entities.map((f) => f(entity)).filter(Boolean).join(" ");
    corpusEntries.push({ kind: "entity", id: entity.id, resolution: { entityId: entity.id }, tokens: tokenize(text) });
  }

  // idf
  const df = new Map();
  for (const entry of corpusEntries) {
    for (const t of new Set(entry.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = Math.max(1, corpusEntries.length);
  const idf = (t) => Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) + 1;
  for (const entry of corpusEntries) {
    const tf = termFreq(entry.tokens);
    const vec = new Map();
    for (const [t, f] of tf) vec.set(t, f * idf(t));
    entry.vec = vec;
  }

  function tfidfLink(queryText) {
    const qTokens = tokenize(queryText);
    const qVec = new Map();
    for (const [t, f] of termFreq(qTokens)) qVec.set(t, f * idf(t));

    const buckets = { metrics: new Map(), dims: new Map(), entities: new Map() };
    for (const entry of corpusEntries) {
      const score = cosine(qVec, entry.vec);
      if (score < minScore) continue;
      if (entry.kind === "metric" || entry.resolution?.metricId) {
        const id = entry.kind === "metric" ? entry.id : entry.resolution.metricId;
        buckets.metrics.set(id, Math.max(buckets.metrics.get(id) ?? 0, score));
      }
      if (entry.kind === "dim" || entry.resolution?.dimensionId) {
        const id = entry.kind === "dim" ? entry.id : entry.resolution.dimensionId;
        buckets.dims.set(id, Math.max(buckets.dims.get(id) ?? 0, score));
      }
      if (entry.kind === "entity" || entry.resolution?.entityId) {
        const id = entry.kind === "entity" ? entry.id : entry.resolution.entityId;
        buckets.entities.set(id, Math.max(buckets.entities.get(id) ?? 0, score));
      }
    }
    const rank = (map) => [...map.entries()]
      .map(([id, score]) => ({ id, score: Number(score.toFixed(4)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return { matchedMetrics: rank(buckets.metrics), matchedDims: rank(buckets.dims), matchedEntities: rank(buckets.entities) };
  }

  async function embedderLink(queryText) {
    const qVec = await embedder.embed(queryText);
    const metricIds = (ontology.metrics ?? []).map((m) => m.id);
    const dimIds = (ontology.dimensions ?? []).map((d) => d.id);
    const entityIds = (ontology.entities ?? []).map((e) => e.id);
    const scored = async (ids) => {
      const out = [];
      for (const id of ids) {
        const v = await embedder.embed(id);
        const shared = embedder.dims.filter((k) => (qVec[k] ?? 0) > 0 && (v[k] ?? 0) > 0);
        if (!shared.length) continue;
        const score = Number((shared.reduce((s, k) => s + Math.min(qVec[k], v[k]), 0) /
          Math.sqrt(embedder.dims.reduce((s, k) => s + (qVec[k] ?? 0) ** 2 + (v[k] ?? 0) ** 2, 0) || 1)).toFixed(4));
        if (score >= minScore) out.push({ id, score });
      }
      return out.sort((a, b) => b.score - a.score).slice(0, topK);
    };
    return {
      matchedMetrics: await scored(metricIds),
      matchedDims: await scored(dimIds),
      matchedEntities: await scored(entityIds),
    };
  }

  return Object.freeze({
    backend: embedder ? "embedder" : "tfidf",
    tokenize,
    linkQueryTokens(queryText, opts = {}) {
      if (embedder && !opts.sync) {
        return embedderLink(queryText);
      }
      return tfidfLink(queryText);
    },
    linkQueryTokensSync: tfidfLink,
  });
}
