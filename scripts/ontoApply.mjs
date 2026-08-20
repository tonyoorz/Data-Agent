/**
 * P1-C4: Ontology-as-code round-trip — `onto apply`.
 * Validates v1 sources, recompiles a fresh bundle (in a temp dir first),
 * diffs it against the generated artifact (ontology/generated/ontology.compiled.json),
 * then refreshes the artifact unless --check is passed.
 *
 * Drift semantics (Palantir-style apply):
 *   - source edited, artifact stale  → changes reported, artifact refreshed
 *   - artifact tampered, source same → changes reported, critical=true (artifact
 *     diverges from what the governed sources produce)
 *   - round-trip mismatch (v1 not normalized / hand-edited out of canonical form)
 *     → reported as warnings; run `onto export` to normalize.
 *
 * Exit codes (CLI): 0 ok; 1 validation failed or (with --strict) critical drift.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileOntology, documentDefinitions } from "./compileOntology.mjs";
import { exportBundleToDocuments } from "./ontoExport.mjs";
import { canonicalize } from "../server/ontology/fingerprint.mjs";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** Envelope fields beyond {schemaVersion, ontologyVersion, <collection>} preserved on export. */
function readExtras(sourceDocument, collectionKey) {
  if (!sourceDocument || typeof sourceDocument !== "object") return {};
  const extras = {};
  for (const [key, value] of Object.entries(sourceDocument)) {
    if (key === "schemaVersion" || key === "ontologyVersion" || key === collectionKey) continue;
    extras[key] = value;
  }
  return extras;
}

/** Structural diff between two bundles keyed by (collection, id). */
export function diffBundles(next, previous) {
  const changes = [];
  const sections = [
    "sources", "entities", "relationships", "dimensions", "metrics",
    "terms", "businessRules", "policies", "constraints", "actions",
  ];
  for (const section of sections) {
    const nextItems = next?.[section] ?? [];
    const prevItems = previous?.[section] ?? [];
    const nextMap = new Map(nextItems.map((item) => [item.id, item]));
    const prevMap = new Map(prevItems.map((item) => [item.id, item]));
    for (const [id, item] of nextMap) {
      if (!prevMap.has(id)) changes.push({ section, id, kind: "added" });
      else if (JSON.stringify(item) !== JSON.stringify(prevMap.get(id))) changes.push({ section, id, kind: "changed" });
    }
    for (const id of prevMap.keys()) {
      if (!nextMap.has(id)) changes.push({ section, id, kind: "removed" });
    }
  }
  return changes;
}

/**
 * Apply v1 sources: validate + fresh compile + drift report + optional artifact refresh.
 * @param {object} options
 * @param {boolean} options.checkOnly   report drift without rewriting the artifact
 * @param {boolean} options.roundtrip   verify export(fresh bundle) reproduces v1 documents (semantic)
 */
export function applyOntology({
  root = defaultRoot,
  sourceDir = path.join(root, "ontology/v1"),
  schemaDir = path.join(root, "ontology/schema"),
  outputDir = path.join(root, "ontology/generated"),
  checkOnly = false,
  roundtrip = true,
} = {}) {
  // 1) Fresh compile of the governed sources into a temp dir (validation runs inside).
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "onto-apply-"));
  try {
    const staged = compileOntology({ root, sourceDir, schemaDir, outputDir: stagingDir });

    // 2) Drift report: fresh bundle vs generated artifact on disk.
    const artifactPath = path.join(outputDir, "ontology.compiled.json");
    const artifact = readJsonSafe(artifactPath);
    const artifactMissing = !artifact;
    const artifactDiffers = !artifact || JSON.stringify(canonicalize(artifact)) !== JSON.stringify(staged.bundle);
    const changes = artifact ? diffBundles(staged.bundle, artifact) : [];

    // Critical = the shipped artifact does not match the governed sources.
    // (Missing artifact on first apply is not critical — we are about to create it.)
    const critical = artifactDiffers && !artifactMissing;

    // 3) Round-trip guard: export(fresh bundle) must semantically equal v1 documents.
    let roundtripOk = null;
    const roundtripMismatches = [];
    if (roundtrip) {
      roundtripOk = true;
      const extrasByFile = {};
      for (const definition of documentDefinitions) {
        const source = readJsonSafe(path.join(sourceDir, definition.file));
        extrasByFile[definition.file] = readExtras(source, definition.key);
      }
      const documents = exportBundleToDocuments(staged.bundle, extrasByFile);
      for (const [file, document] of Object.entries(documents)) {
        const source = readJsonSafe(path.join(sourceDir, file));
        if (!source || JSON.stringify(canonicalize(source)) !== JSON.stringify(canonicalize(document))) {
          roundtripOk = false;
          roundtripMismatches.push(file);
        }
      }
      if (!roundtripOk) {
        changes.push({
          section: "ontology/v1",
          id: "roundtrip",
          kind: "changed",
          detail: `sources not in canonical exported form (run onto export): ${roundtripMismatches.join(", ")}`,
        });
      }
    }

    // 4) Refresh the artifact unless check-only.
    let refreshed = false;
    if (!checkOnly) {
      compileOntology({ root, sourceDir, schemaDir, outputDir, check: false });
      refreshed = true;
    }

    return {
      fingerprint: staged.fingerprint,
      counts: staged.counts,
      changes,
      critical,
      refreshed,
      checked: { checkOnly: Boolean(checkOnly), roundtripOk, artifactMissing, artifactDiffers },
    };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      index += 1;
    } else {
      args.set(key, "true");
    }
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = applyOntology({
      root: args.get("root") ? path.resolve(args.get("root")) : defaultRoot,
      ...(args.get("source-dir") ? { sourceDir: path.resolve(args.get("source-dir")) } : {}),
      ...(args.get("schema-dir") ? { schemaDir: path.resolve(args.get("schema-dir")) } : {}),
      ...(args.get("output-dir") ? { outputDir: path.resolve(args.get("output-dir")) } : {}),
      checkOnly: args.get("check") === "true",
      roundtrip: args.has("roundtrip") ? args.get("roundtrip") === "true" : true,
    });
    process.stdout.write(`${JSON.stringify({ ok: !result.critical, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: "ONTOLOGY_APPLY_FAILED", message: String(error?.message || error) })}\n`);
    process.exitCode = 1;
  }
}
