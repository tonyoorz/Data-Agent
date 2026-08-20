/**
 * P1-C4: Ontology-as-code round-trip — `onto export`.
 * Splits the compiled ontology bundle back into ontology/v1/*.json documents
 * (sorted keys, sorted arrays by id, trailing newline) so generated artifacts
 * stay git-diff friendly and reproducible.
 *
 * Contract:
 *   compile(v1 sources) == compiled  →  export(compiled) == v1 sources (normalized)
 * CI guard: export → `git diff --exit-code ontology/v1` must be clean.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "../server/ontology/fingerprint.mjs";
import { documentDefinitions } from "./compileOntology.mjs";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sortDeep(value) {
  const canonical = canonicalize(value); // object keys sorted recursively
  return canonical;
}

/**
 * Export a compiled bundle into per-document payloads.
 * Pure function (no fs) so tests can round-trip in memory.
 * @param {Record<string, object>} extrasByFile  preserved envelope fields per file
 *   (e.g. vocab locale, business_rules description/rules) — required by schemas.
 */
export function exportBundleToDocuments(bundle, extrasByFile = {}) {
  if (!bundle || typeof bundle !== "object") throw new Error("ONTOLOGY_EXPORT_INVALID: bundle required");
  const documents = {};
  const missing = [];
  for (const definition of documentDefinitions) {
    const items = bundle[definition.key];
    if (!Array.isArray(items)) {
      missing.push(definition.key);
      continue;
    }
    const sortedItems = [...items].sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const extras = extrasByFile[definition.file] || {};
    documents[definition.file] = {
      schemaVersion: "1.0",
      ontologyVersion: "v1",
      ...sortDeep(extras),
      [definition.key]: sortDeep(sortedItems),
    };
  }
  if (missing.length) {
    throw new Error(`ONTOLOGY_EXPORT_INVALID: bundle missing arrays: ${missing.join(", ")}`);
  }
  return documents;
}

/** Serialize one document git-friendly: 2-space indent + trailing newline. */
export function serializeDocument(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Envelope fields beyond {schemaVersion, ontologyVersion, <collection>} that schemas require. */
function readExtrasFromSource(sourceDocument, collectionKey) {
  if (!sourceDocument || typeof sourceDocument !== "object") return {};
  const extras = {};
  for (const [key, value] of Object.entries(sourceDocument)) {
    if (key === "schemaVersion" || key === "ontologyVersion" || key === collectionKey) continue;
    extras[key] = value;
  }
  return extras;
}

/**
 * Export compiled ontology onto disk.
 * @param {object} options
 * @param {string} options.compiledPath  path to ontology.compiled.json
 * @param {string} options.targetDir     where v1/*.json files are written (default ontology/v1)
 * @param {string} options.extrasFromDir dir with existing source docs to preserve envelope extras
 * @param {boolean} options.dryRun       when true, compute the plan without writing
 * @returns {{ written: string[], changed: string[], unchanged: string[], dryRun: boolean }}
 */
export function exportOntology({
  root = defaultRoot,
  compiledPath = path.join(root, "ontology/generated/ontology.compiled.json"),
  targetDir = path.join(root, "ontology/v1"),
  extrasFromDir = targetDir,
  dryRun = false,
} = {}) {
  const bundle = JSON.parse(fs.readFileSync(compiledPath, "utf8"));
  const extrasByFile = {};
  for (const definition of documentDefinitions) {
    const existingPath = path.join(extrasFromDir, definition.file);
    if (fs.existsSync(existingPath)) {
      extrasByFile[definition.file] = readExtrasFromSource(
        JSON.parse(fs.readFileSync(existingPath, "utf8")),
        definition.key,
      );
    }
  }
  const documents = exportBundleToDocuments(bundle, extrasByFile);
  fs.mkdirSync(targetDir, { recursive: true });

  const written = [];
  const changed = [];
  const unchanged = [];
  for (const [file, document] of Object.entries(documents)) {
    const text = serializeDocument(document);
    const target = path.join(targetDir, file);
    const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    if (existing === text) {
      unchanged.push(file);
      continue;
    }
    changed.push(file);
    if (!dryRun) {
      const temporary = `${target}.tmp-${process.pid}`;
      fs.writeFileSync(temporary, text);
      fs.renameSync(temporary, target);
    }
    written.push(file);
  }
  return { written, changed, unchanged, dryRun: Boolean(dryRun) };
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
    const result = exportOntology({
      root: args.get("root") ? path.resolve(args.get("root")) : defaultRoot,
      ...(args.get("compiled-path") ? { compiledPath: path.resolve(args.get("compiled-path")) } : {}),
      ...(args.get("target-dir") ? { targetDir: path.resolve(args.get("target-dir")) } : {}),
      dryRun: args.get("dry-run") === "true",
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: "ONTOLOGY_EXPORT_FAILED", message: String(error?.message || error) })}\n`);
    process.exitCode = 1;
  }
}
