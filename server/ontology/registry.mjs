import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintOntology } from "./fingerprint.mjs";
import { validateOntologyBundle } from "./validator.mjs";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function fail(code, detail = "") {
  throw new Error(detail ? `${code}:${detail}` : code);
}

function requireItem(map, id, type) {
  const item = map.get(String(id || ""));
  if (!item) fail(`ONTOLOGY_${type}_NOT_FOUND`, id);
  return item;
}

function isAsciiWordCharacter(value) {
  return Boolean(value) && /[a-z0-9_]/i.test(value);
}

function includesTerm(query, phrase) {
  let offset = 0;
  while (offset <= query.length - phrase.length) {
    const index = query.indexOf(phrase, offset);
    if (index < 0) return false;
    const before = query[index - 1];
    const after = query[index + phrase.length];
    const startIsBounded = !isAsciiWordCharacter(phrase[0]) || !isAsciiWordCharacter(before);
    const endIsBounded = !isAsciiWordCharacter(phrase.at(-1)) || !isAsciiWordCharacter(after);
    if (startIsBounded && endIsBounded) return true;
    offset = index + 1;
  }
  return false;
}

export function createOntologyRegistry({
  root = defaultRoot,
  compiledPath = path.join(root, "ontology/generated/ontology.compiled.json"),
  fingerprintPath = path.join(root, "ontology/generated/fingerprint.txt"),
  expectedFingerprint,
} = {}) {
  if (!fs.existsSync(compiledPath) || !fs.existsSync(fingerprintPath)) fail("ONTOLOGY_NOT_COMPILED");
  const bundle = JSON.parse(fs.readFileSync(compiledPath, "utf8"));
  validateOntologyBundle(bundle);
  const computedFingerprint = fingerprintOntology(bundle);
  const declaredFingerprint = fs.readFileSync(fingerprintPath, "utf8").trim();
  if (computedFingerprint !== declaredFingerprint) fail("ONTOLOGY_FINGERPRINT_MISMATCH");
  if (expectedFingerprint && computedFingerprint !== expectedFingerprint) fail("ONTOLOGY_EXPECTED_FINGERPRINT_MISMATCH");

  const entities = new Map(bundle.entities.map((item) => [item.id, Object.freeze(item)]));
  const dimensions = new Map(bundle.dimensions.map((item) => [item.id, Object.freeze(item)]));
  const metrics = new Map(bundle.metrics.map((item) => [item.id, Object.freeze(item)]));
  const relationships = new Map(bundle.relationships.map((item) => [item.id, Object.freeze(item)]));
  const policies = new Map(bundle.policies.map((item) => [item.id, Object.freeze(item)]));
  const constraints = new Map(bundle.constraints.map((item) => [item.id, Object.freeze(item)]));
  const terms = bundle.terms.flatMap((term) => term.phrases.map((phrase) => ({ term, phrase, normalized: phrase.toLocaleLowerCase("zh-CN") })))
    .sort((left, right) => right.normalized.length - left.normalized.length || left.normalized.localeCompare(right.normalized));

  return Object.freeze({
    version: bundle.ontologyVersion,
    fingerprint: computedFingerprint,
    compilerVersion: bundle.compilerVersion,
    bundle: Object.freeze(bundle),
    getEntity(id) { return requireItem(entities, id, "ENTITY"); },
    getDimension(id) { return requireItem(dimensions, id, "DIMENSION"); },
    getMetric(id, { approvedOnly = false } = {}) {
      const metric = requireItem(metrics, id, "METRIC");
      if (approvedOnly && metric.governance.status !== "approved") fail("ONTOLOGY_METRIC_NOT_APPROVED", id);
      return metric;
    },
    getRelationship(id) { return requireItem(relationships, id, "RELATIONSHIP"); },
    getPolicy(id, { approvedOnly = true } = {}) {
      const policy = requireItem(policies, id, "POLICY");
      if (approvedOnly && policy.governance.status !== "approved") fail("ONTOLOGY_POLICY_NOT_APPROVED", id);
      return policy;
    },
    getConstraint(id, { approvedOnly = true } = {}) {
      const constraint = requireItem(constraints, id, "CONSTRAINT");
      if (approvedOnly && constraint.governance.status !== "approved") fail("ONTOLOGY_CONSTRAINT_NOT_APPROVED", id);
      return constraint;
    },
    listMetrics({ status } = {}) {
      return [...metrics.values()].filter((metric) => !status || metric.governance.status === status);
    },
    matchTerms(query) {
      const normalizedQuery = String(query || "").toLocaleLowerCase("zh-CN");
      const matchedIds = new Set();
      const matches = [];
      for (const candidate of terms) {
        if (!includesTerm(normalizedQuery, candidate.normalized) || matchedIds.has(candidate.term.id)) continue;
        matchedIds.add(candidate.term.id);
        matches.push(candidate.term);
      }
      return matches;
    },
  });
}
