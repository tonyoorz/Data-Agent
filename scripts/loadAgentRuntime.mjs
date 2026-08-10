import fs from "node:fs";
import path from "node:path";
import { runLoadTest } from "./lib/agentRuntimeLoadRunner.mjs";

function parseArgs(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--" || !value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next && next !== "--" && !next.startsWith("--")) {
      result.set(key, next);
      index += 1;
    } else {
      result.set(key, "true");
    }
  }
  return result;
}

function writeReport(filePath, report) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, resolved);
}

const args = parseArgs(process.argv.slice(2));

try {
  const report = await runLoadTest({
    baseUrl: args.get("base-url"),
    iterations: Number(args.get("iterations") || 5),
    concurrency: Number(args.get("concurrency") || 2),
    timeoutMs: Number(args.get("timeout-ms") || 10000),
    maxP95Ms: Number(args.get("max-p95-ms") || 2000),
    seed: Number(args.get("seed") || 20260716),
  });
  if (args.get("output")) writeReport(args.get("output"), report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (args.get("strict") === "true" && !report.passed) process.exitCode = 1;
} catch (error) {
  const rawCode = String(error?.code || error?.message || "");
  const code = /^[A-Z][A-Z0-9_:-]{2,79}$/.test(rawCode) ? rawCode : "LOAD_RUNNER_FAILED";
  process.stderr.write(`${JSON.stringify({
    schemaVersion: "2.0",
    passed: false,
    code,
    message: code,
  })}\n`);
  process.exitCode = 1;
}
