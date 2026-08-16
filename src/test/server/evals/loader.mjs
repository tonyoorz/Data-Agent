import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Golden eval dataset loader (test infrastructure — not part of server runtime).
 * Schema per case (JSONL, one per line):
 *   { id, domain, intent, q, expect:{...}, note? }
 * expect is one of:
 *   { metrics?:[], dims?:[], filters?:{dimId:value}, time?:string }
 *   { clarify:true } | { reject:true } | { longtail:true }
 *   { answer:"catalog"|"dashboard"|"capability" } | { entity:"quality.defect" }
 */

export const INTENTS = Object.freeze([
  "chitchat",
  "out_of_scope",
  "clarification",
  "metric_query",
  "coverage_query",
  "record_query",
  "traceability",
  "schema_discovery",
  "action_capability",
  "duplicate_search",
  "testcase_context",
  "high_frequency",
  "business_risk_assessment",
  "ontology_catalog",
  "dashboard_fallback",
  "general",
]);

export const DOMAINS = Object.freeze([
  "defect",
  "testing",
  "traceability",
  "organization",
  "longtail",
  "clarify",
  "reject",
]);

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATASET = join(here, "dataset", "golden-v1.jsonl");
const DEFAULT_ONTOLOGY = join(here, "..", "..", "..", "..", "ontology", "generated", "ontology.compiled.json");

export function loadOntology(path = DEFAULT_ONTOLOGY) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function validateCase(c, seenIds = new Set()) {
  const problems = [];
  if (!c || typeof c !== "object") return ["case is not an object"];
  if (!c.id || typeof c.id !== "string") problems.push("missing id");
  else if (seenIds.has(c.id)) problems.push(`duplicate id ${c.id}`);
  else seenIds.add(c.id);
  if (!c.q || typeof c.q !== "string" || c.q.trim().length < 4) problems.push("missing/short question");
  if (!INTENTS.includes(c.intent)) problems.push(`unknown intent ${c.intent}`);
  if (!DOMAINS.includes(c.domain)) problems.push(`unknown domain ${c.domain}`);
  if (!c.expect || typeof c.expect !== "object" || Object.keys(c.expect).length === 0) {
    problems.push("empty expect");
  }
  return problems;
}

export function loadGoldenDataset(datasetPath = DEFAULT_DATASET, ontologyPath = DEFAULT_ONTOLOGY) {
  const raw = readFileSync(datasetPath, "utf8");
  const cases = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));

  const seenIds = new Set();
  for (const c of cases) {
    const problems = validateCase(c, seenIds);
    if (problems.length) throw new Error(`invalid case ${c.id ?? "?"}: ${problems.join("; ")}`);
  }

  const stats = {
    total: cases.length,
    byIntent: {},
    byDomain: {},
  };
  for (const c of cases) {
    stats.byIntent[c.intent] = (stats.byIntent[c.intent] ?? 0) + 1;
    stats.byDomain[c.domain] = (stats.byDomain[c.domain] ?? 0) + 1;
  }

  return { cases, stats, ontology: loadOntology(ontologyPath) };
}
