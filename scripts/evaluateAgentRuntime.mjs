import fs from "node:fs";
import path from "node:path";
import { evaluateSuite, reportToJunit } from "./lib/agentRuntimeEvaluator.mjs";

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

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function parseRequestHeaders(value) {
  if (!value) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw Object.assign(new Error("QUALIFICATION_HEADERS_INVALID"), { code: "QUALIFICATION_HEADERS_INVALID" });
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw Object.assign(new Error("QUALIFICATION_HEADERS_INVALID"), { code: "QUALIFICATION_HEADERS_INVALID" });
  }
  const forbiddenHeaders = new Set(["connection", "content-length", "host", "transfer-encoding"]);
  return Object.fromEntries(Object.entries(parsed).map(([name, headerValue]) => {
    if (!name || /[\r\n]/.test(name) || forbiddenHeaders.has(name.toLowerCase()) || typeof headerValue !== "string" || /[\r\n]/.test(headerValue)) {
      throw Object.assign(new Error("QUALIFICATION_HEADERS_INVALID"), { code: "QUALIFICATION_HEADERS_INVALID" });
    }
    return [name, headerValue];
  }));
}

function normalizeRealModelBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error("REAL_MODEL_BASE_URL_INVALID"), { code: "REAL_MODEL_BASE_URL_INVALID" });
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw Object.assign(new Error("REAL_MODEL_BASE_URL_INVALID"), { code: "REAL_MODEL_BASE_URL_INVALID" });
  }
  return url.toString().replace(/\/$/, "");
}

const args = parseArgs(process.argv.slice(2));
const suitePath = args.get("suite") || "evals/main-agent/baseline/runtime.jsonl";
const jsonOutput = args.get("json-output") || args.get("output");
const junitOutput = args.get("junit-output");
const strict = args.get("strict") === "true";
const qualification = args.get("qualification") || (suitePath.includes("/target/") ? "target" : "baseline");
const selectedModel = args.get("model") || "fake-certified";
let baseUrl = args.get("base-url");
const requestHeadersJson = qualification === "real-model"
  ? process.env.MAIN_AGENT_QUALIFICATION_HEADERS_JSON
  : args.get("headers-json");

try {
  if (qualification === "real-model" && !baseUrl) throw Object.assign(new Error("REAL_MODEL_BASE_URL_REQUIRED"), { code: "REAL_MODEL_BASE_URL_REQUIRED" });
  if (qualification === "real-model" && selectedModel === "fake-certified") throw Object.assign(new Error("REAL_MODEL_ID_REQUIRED"), { code: "REAL_MODEL_ID_REQUIRED" });
  if (qualification === "real-model" && args.has("headers-json")) throw Object.assign(new Error("QUALIFICATION_HEADERS_CLI_FORBIDDEN"), { code: "QUALIFICATION_HEADERS_CLI_FORBIDDEN" });
  if (qualification === "real-model") baseUrl = normalizeRealModelBaseUrl(baseUrl);
  const report = await evaluateSuite({
    suitePath,
    schemaPath: args.get("schema") || "evals/main-agent/schema/eval-case.schema.json",
    baseUrl,
    timeoutMs: Number(args.get("timeout-ms") || 10000),
    mode: args.get("mode") || "langgraph",
    model: selectedModel,
    requestHeaders: parseRequestHeaders(requestHeadersJson),
    qualification,
  });
  if (jsonOutput) writeFile(jsonOutput, `${JSON.stringify(report, null, 2)}\n`);
  if (junitOutput) writeFile(junitOutput, reportToJunit(report));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.hardGatesPassed || (strict && !report.passed)) process.exitCode = 1;
} catch (error) {
  const rawCode = String(error?.code || error?.message || "");
  const code = /^[A-Z][A-Z0-9_:-]{2,79}$/.test(rawCode) ? rawCode : "EVALUATOR_FAILED";
  const failure = {
    schemaVersion: "2.0",
    passed: false,
    code,
    message: code,
  };
  process.stderr.write(`${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
}
