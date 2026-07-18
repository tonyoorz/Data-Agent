#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { buildShadowQualification, qualifyCanaryRouting, qualifyRollbackSwitch } from "./lib/agentRolloutQualification.mjs";

function positiveNumber(value, label, { integer = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) throw new Error(`INVALID_${label}`);
  return parsed;
}

function parseArgs(argv) {
  const args = { mode: "preflight", strict: false, minSamples: 100, canaryPercentage: 5, sampleSize: 10_000, maxLatencyRegressionPct: 20, allowlist: ["qualification-allowlisted"] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") args.mode = String(argv[++index]);
    else if (arg === "--db-path") args.dbPath = String(argv[++index]);
    else if (arg === "--output") args.output = String(argv[++index]);
    else if (arg === "--strict") args.strict = true;
    else if (arg === "--min-samples") args.minSamples = positiveNumber(argv[++index], "MIN_SAMPLES", { integer: true });
    else if (arg === "--canary-percentage") args.canaryPercentage = Number(argv[++index]);
    else if (arg === "--sample-size") args.sampleSize = positiveNumber(argv[++index], "SAMPLE_SIZE", { integer: true });
    else if (arg === "--max-latency-regression-pct") args.maxLatencyRegressionPct = positiveNumber(argv[++index], "MAX_LATENCY_REGRESSION_PCT");
    else if (arg === "--allowlist") args.allowlist = String(argv[++index] || "").split(",").map((item) => item.trim()).filter(Boolean);
    else throw new Error(`UNKNOWN_ARGUMENT:${arg}`);
  }
  if (!["preflight", "shadow", "canary", "rollback"].includes(args.mode)) throw new Error("INVALID_QUALIFICATION_MODE");
  if (!Number.isFinite(args.canaryPercentage) || args.canaryPercentage < 0 || args.canaryPercentage > 100) throw new Error("INVALID_CANARY_PERCENTAGE");
  if (args.mode === "shadow" && !args.dbPath) throw new Error("DB_PATH_REQUIRED_FOR_SHADOW");
  return args;
}

function readShadowRows(dbPath) {
  const resolved = path.resolve(dbPath);
  const db = new Database(resolved, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT run_id, action, details_json, created_at FROM agent_audit WHERE action IN ('runtime.shadow_dispatch','runtime.shadow_legacy_result','runtime.shadow_result') ORDER BY created_at, audit_id").all();
  } finally {
    db.close();
  }
}

function actorFixture(count) {
  return Array.from({ length: count }, (_, index) => `qualification-actor-${String(index + 1).padStart(6, "0")}`);
}

function writeReport(outputPath, report) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, resolved);
  return resolved;
}

function evaluate(args) {
  const actors = actorFixture(args.sampleSize);
  if (args.mode === "shadow") {
    return buildShadowQualification(readShadowRows(args.dbPath), { minSamples: args.minSamples, maxLatencyRegressionPct: args.maxLatencyRegressionPct });
  }
  if (args.mode === "canary") {
    return qualifyCanaryRouting({ actorIds: actors, percentage: args.canaryPercentage, allowlist: args.allowlist });
  }
  if (args.mode === "rollback") return qualifyRollbackSwitch({ actorIds: actors.slice(0, 100) });
  const canary = qualifyCanaryRouting({ actorIds: actors, percentage: args.canaryPercentage, allowlist: args.allowlist });
  const rollback = qualifyRollbackSwitch({ actorIds: actors.slice(0, 100) });
  return { schemaVersion: "1.0", qualification: "rollout-preflight", canary, rollback, pass: canary.pass && rollback.pass };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = { ...evaluate(args), generatedAt: new Date().toISOString() };
  const outputPath = args.output ? writeReport(args.output, report) : null;
  process.stdout.write(`${JSON.stringify({ qualification: report.qualification, pass: report.pass, ...(outputPath ? { outputPath } : {}) })}\n`);
  if (args.strict && !report.pass) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
