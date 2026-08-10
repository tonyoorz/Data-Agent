import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { applyCleanupPlan, buildCleanupPlan } from "./lib/agentRuntimeCleanup.mjs";

function parseArgs(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const next = argv[index + 1];
    result.set(value.slice(2), next && !next.startsWith("--") ? next : "true");
    if (next && !next.startsWith("--")) index += 1;
  }
  return result;
}

const isoBefore = (asOf, days) => new Date(Date.parse(asOf) - days * 24 * 60 * 60 * 1000).toISOString();
const args = parseArgs(process.argv.slice(2));
const asOf = args.get("as-of") || new Date().toISOString();
const apply = args.get("apply") === "true";
if (apply && args.get("confirm") !== "DELETE_EXPIRED_AGENT_DATA") throw new Error("CLEANUP_CONFIRMATION_REQUIRED");
const dbPath = path.resolve(args.get("db") || process.env.VIZION_AGENT_RUNTIME_DB || "database/runtime/agent-runtime.db");
const db = new Database(dbPath, { readonly: !apply, fileMustExist: true });
try {
  db.pragma("foreign_keys = ON");
  const cutoffs = {
    eventsBefore: args.get("events-before") || isoBefore(asOf, 30),
    checkpointsBefore: args.get("checkpoints-before") || isoBefore(asOf, 30),
    journalBefore: args.get("journal-before") || isoBefore(asOf, 30),
    artifactsBefore: args.get("artifacts-before") || asOf,
    threadsBefore: args.get("threads-before") || isoBefore(asOf, 30),
    auditBefore: args.get("audit-before") || isoBefore(asOf, 180),
  };
  const plan = buildCleanupPlan({ db, cutoffs });
  const report = {
    schemaVersion: "1.0",
    mode: apply ? "apply" : "dry-run",
    asOf,
    dbPath,
    planHash: plan.planHash,
    cutoffs,
    candidates: plan.counts,
    deleted: apply ? applyCleanupPlan({ db, plan }) : null,
  };
  const manifest = args.get("manifest");
  if (manifest) {
    fs.mkdirSync(path.dirname(path.resolve(manifest)), { recursive: true });
    fs.writeFileSync(manifest, `${JSON.stringify(report, null, 2)}\n`, { flag: apply ? "wx" : "w" });
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  db.close();
}
