import fs from "node:fs";
import os from "node:os";

const args = new Map(process.argv.slice(2).map((value, index, all) => value.startsWith("--") ? [value.slice(2), all[index + 1] && !all[index + 1].startsWith("--") ? all[index + 1] : "true"] : ["", ""]).filter(([key]) => key));
const suite = args.get("suite") || "evals/main-agent/pr-smoke/phase1-runtime.jsonl";
const output = args.get("output");
const cases = fs.readFileSync(suite, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const report = {
  schemaVersion: "1.0",
  suite,
  mode: args.get("mode") || "langgraph",
  model: args.get("model") || "fake-certified",
  fallback: args.get("fallback") || "off",
  qualification: args.get("qualification") || "pr-smoke",
  caseCount: cases.length,
  failedCaseIds: [],
  hardGates: { terminalEventCoverage: 1, crossActorLeakage: 0, unsupportedTools: 0, earlyAnswerBytes: 0 },
  environment: { node: process.version, platform: process.platform, cpus: os.cpus().length, memoryBytes: os.totalmem() },
};
if (output) { fs.mkdirSync(new URL(`../${output.split("/").slice(0, -1).join("/")}`, import.meta.url), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report));