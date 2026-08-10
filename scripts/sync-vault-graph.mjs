// Syncs the vizion-lab ontology graph into the tonystark Obsidian vault.
//
// Data flow:
//   ontology/v1/*.json        hand-maintained source of truth (10 files)
//     -> schema validation + canonicalization   (compileOntology.mjs)
//     -> docs/ontology/graph.md                  (mermaid graph, --emit-graph)
//     -> ../tonystark/graph.md                   (vault read-only snapshot)
//
// The compile step validates every v1 source against its JSON Schema, so a
// malformed ontology fails here rather than corrupting the vault copy.
//
// Usage:
//   node scripts/sync-vault-graph.mjs                 # compile + sync to vault
//   node scripts/sync-vault-graph.mjs --dry-run       # compile, show diff, no write
//   node scripts/sync-vault-graph.mjs --no-compile     # skip compile, sync existing graph
//   node scripts/sync-vault-graph.mjs --vault <path>   # override vault graph path
//
// Output: single-line JSON (matches compileOntology.mjs style, pipe-friendly).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileOntology } from "./compileOntology.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// Vault lives one dir up from vizion-lab: ~/Desktop/tonystark/graph.md.
const DEFAULT_VAULT_GRAPH = path.resolve(root, "..", "tonystark", "graph.md");
const VIZION_GRAPH_PATH = path.join(root, "docs", "ontology", "graph.md");

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

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, filePath);
}

function fail(code, message) {
  process.stderr.write(`${JSON.stringify({ code, message })}\n`);
  process.exitCode = 1;
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const vaultGraphPath = args.get("vault") ? path.resolve(args.get("vault")) : DEFAULT_VAULT_GRAPH;
const dryRun = args.get("dry-run") === "true";
const skipCompile = args.get("no-compile") === "true";

// 1. Compile ontology from v1 source (validates against schema) + emit graph.
let result = null;
if (skipCompile) {
  if (!fs.existsSync(VIZION_GRAPH_PATH)) {
    fail("SYNC_NO_GRAPH", `graph.md missing: ${VIZION_GRAPH_PATH} (run without --no-compile)`);
  }
} else {
  try {
    result = compileOntology({ root, emitGraph: true });
  } catch (error) {
    fail("SYNC_COMPILE_FAILED", String(error?.message || error));
  }
}

// 2. Compare generated graph with the vault snapshot.
const sourceContent = fs.readFileSync(VIZION_GRAPH_PATH, "utf8");
const vaultExisted = fs.existsSync(vaultGraphPath);
const vaultContent = vaultExisted ? fs.readFileSync(vaultGraphPath, "utf8") : null;
const inSync = vaultContent === sourceContent;

// 3. Sync (unless dry-run). Don't create a stray tonystark/ tree silently.
if (!inSync && !dryRun) {
  const vaultParent = path.dirname(vaultGraphPath);
  if (!fs.existsSync(vaultParent)) {
    fail("SYNC_VAULT_MISSING", `vault dir not found: ${vaultParent} (pass --vault <path>)`);
  }
  atomicWrite(vaultGraphPath, sourceContent);
}

const summary = {
  source: VIZION_GRAPH_PATH,
  vault: vaultGraphPath,
  vaultExisted,
  inSync,
  dryRun,
  action: inSync ? "noop" : dryRun ? "would-sync" : "synced",
  ...(result ? { fingerprint: result.fingerprint, counts: result.counts } : {}),
};

process.stdout.write(`${JSON.stringify(summary)}\n`);
