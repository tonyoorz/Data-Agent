import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { canonicalize, fingerprintOntology } from "../server/ontology/fingerprint.mjs";
import { validateOntologyBundle } from "../server/ontology/validator.mjs";

const compilerVersion = "ontology-compiler-v1";
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const documentDefinitions = Object.freeze([
  { file: "sources.json", schema: "sources.schema.json", key: "sources" },
  { file: "entities.json", schema: "entities.schema.json", key: "entities" },
  { file: "relationships.json", schema: "relationships.schema.json", key: "relationships" },
  { file: "dimensions.json", schema: "dimensions.schema.json", key: "dimensions" },
  { file: "metrics.json", schema: "metrics.schema.json", key: "metrics" },
  { file: "vocab.zh-CN.json", schema: "vocabulary.schema.json", key: "terms" },
  { file: "policies.json", schema: "policies.schema.json", key: "policies" },
  { file: "constraints.json", schema: "constraints.schema.json", key: "constraints" },
]);

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`ONTOLOGY_JSON_INVALID:${filePath}:${error.message}`);
  }
}
function validationError(ajv, file, errors) {
  return new Error(`ONTOLOGY_SCHEMA_INVALID:${file}:${ajv.errorsText(errors, { separator: "; " })}`);
}

export function loadOntologySources({ sourceDir, schemaDir }) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const common = readJson(path.join(schemaDir, "common.schema.json"));
  ajv.addSchema(common);
  const documents = {};
  for (const definition of documentDefinitions) {
    const schema = readJson(path.join(schemaDir, definition.schema));
    const validate = ajv.compile(schema);
    const document = readJson(path.join(sourceDir, definition.file));
    if (!validate(document)) throw validationError(ajv, definition.file, validate.errors);
    documents[definition.key] = document[definition.key];
  }
  return documents;
}

function sortById(items) {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, filePath);
}

function generateEntityGraphMermaid(bundle) {
  const entities = bundle.entities || [];
  const relationships = bundle.relationships || [];
  const lines = ["```mermaid", "flowchart LR"];

  for (const entity of entities) {
    const id = entity.id;
    const label = entity.labels?.["zh-CN"] || entity.labels?.["en-US"] || id;
    const nodeId = id.replace(/\./g, "_");
    lines.push(`    ${nodeId}["${label}\\n(${id})"]`);
  }

  for (const relationship of relationships) {
    const sourceId = relationship.sourceEntity.replace(/\./g, "_");
    const targetId = relationship.targetEntity.replace(/\./g, "_");
    const predicate = relationship.predicate;
    const status = relationship.governance?.status;
    const edge = status === "draft" ? "-.->" : "-->";
    lines.push(`    ${sourceId} ${edge}|"${predicate}"| ${targetId}`);
  }

  lines.push("```");
  return lines.join("\n");
}

export function compileOntology({
  root = defaultRoot,
  sourceDir = path.join(root, "ontology/v1"),
  schemaDir = path.join(root, "ontology/schema"),
  outputDir = path.join(root, "ontology/generated"),
  check = false,
  emitGraph = false,
  graphPath = path.join(root, "docs/ontology/graph.md"),
} = {}) {
  const documents = loadOntologySources({ sourceDir, schemaDir });
  const bundle = canonicalize({
    schemaVersion: "1.0",
    ontologyVersion: "v1",
    compilerVersion,
    sources: sortById(documents.sources),
    entities: sortById(documents.entities),
    relationships: sortById(documents.relationships),
    dimensions: sortById(documents.dimensions),
    metrics: sortById(documents.metrics),
    terms: sortById(documents.terms),
    policies: sortById(documents.policies),
    constraints: sortById(documents.constraints),
  });
  const counts = validateOntologyBundle(bundle);
  const fingerprint = fingerprintOntology(bundle);
  const compiledPath = path.join(outputDir, "ontology.compiled.json");
  const fingerprintPath = path.join(outputDir, "fingerprint.txt");
  const compiledText = `${JSON.stringify(bundle, null, 2)}\n`;

  if (check) {
    if (!fs.existsSync(compiledPath) || !fs.existsSync(fingerprintPath)) throw new Error("ONTOLOGY_GENERATED_OUTPUT_MISSING");
    const existingBundle = readJson(compiledPath);
    const existingFingerprint = fs.readFileSync(fingerprintPath, "utf8").trim();
    if (fingerprintOntology(existingBundle) !== fingerprint || existingFingerprint !== fingerprint) {
      throw new Error("ONTOLOGY_GENERATED_OUTPUT_STALE");
    }
  } else {
    atomicWrite(compiledPath, compiledText);
    atomicWrite(fingerprintPath, `${fingerprint}\n`);
  }

  let graphOutputPath;
  if (emitGraph) {
    const graphContent = generateEntityGraphMermaid(bundle);
    const graphBody = `# Ontology Entity Relationship Graph\n\n> Auto-generated by \`compileOntology.mjs --emit-graph\`. Do not edit by hand.\n\n${graphContent}\n`;
    graphOutputPath = graphPath;
    atomicWrite(graphOutputPath, graphBody);
  }

  return { bundle, fingerprint, counts, compiledPath, fingerprintPath, check, graphOutputPath };
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
    const result = compileOntology({
      root: args.get("root") ? path.resolve(args.get("root")) : defaultRoot,
      ...(args.get("source-dir") ? { sourceDir: path.resolve(args.get("source-dir")) } : {}),
      ...(args.get("schema-dir") ? { schemaDir: path.resolve(args.get("schema-dir")) } : {}),
      ...(args.get("output-dir") ? { outputDir: path.resolve(args.get("output-dir")) } : {}),
      ...(args.get("graph-path") ? { graphPath: path.resolve(args.get("graph-path")) } : {}),
      check: args.get("check") === "true",
      emitGraph: args.get("emit-graph") === "true",
    });
    process.stdout.write(`${JSON.stringify({
      ontologyVersion: result.bundle.ontologyVersion,
      fingerprint: result.fingerprint,
      counts: result.counts,
      check: result.check,
      graphOutputPath: result.graphOutputPath,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: "ONTOLOGY_COMPILE_FAILED", message: String(error?.message || error) })}\n`);
    process.exitCode = 1;
  }
}
