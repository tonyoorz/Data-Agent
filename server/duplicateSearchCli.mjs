#!/usr/bin/env node
import duplicateBridgeRuntime from "./duplicateBridgeRuntime.cjs";
import { attachDuplicateSummary } from "./duplicateResultEnrichment.mjs";
import { loadLocalEnv } from "./loadLocalEnv.mjs";

loadLocalEnv();
if (!process.env.DUPLICATE_SUMMARY_TIMEOUT_MS) {
  process.env.DUPLICATE_SUMMARY_TIMEOUT_MS = "30000";
}

function parseArgs(argv) {
  const args = { query: "", topK: 5, model: "", language: "en" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--query") {
      args.query = String(argv[index + 1] || "").trim();
      index += 1;
    } else if (arg === "--top-k") {
      const topK = Number(argv[index + 1] || 5);
      args.topK = Number.isFinite(topK) ? Math.max(1, Math.min(20, Math.floor(topK))) : 5;
      index += 1;
    } else if (arg === "--model") {
      args.model = String(argv[index + 1] || "").trim();
      index += 1;
    } else if (arg === "--language") {
      args.language = String(argv[index + 1] || "en").trim() || "en";
      index += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.query) {
    throw new Error("--query is required");
  }

  const bridgeResult = await duplicateBridgeRuntime.runDuplicateBridge({
    action: "search",
    query: args.query,
    top_k: args.topK,
  });
  if (!bridgeResult?.success || !bridgeResult?.result) {
    throw new Error(bridgeResult?.error || "duplicate search failed");
  }

  const enrichedResult = await attachDuplicateSummary({
    query: args.query,
    selectedModel: args.model,
    result: bridgeResult.result,
    language: args.language,
  });
  process.stdout.write(JSON.stringify({ success: true, result: enrichedResult }));
}

main()
  .catch((error) => {
    process.stdout.write(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  })
  .finally(() => {
    duplicateBridgeRuntime.stopDuplicateBridgeRuntime();
  });
