#!/usr/bin/env node
// DTSV main-agent scorecard runner (task 27).
//
// Produces a single scorecard that combines:
//   - an offline routing baseline (replays agent-golden against
//     selectMainAgentToolset / shouldPlanMainAgentTools), and
//   - six runtime metrics aggregated from run-summaries.jsonl.
//
// Design notes:
//   - Reuses the existing evals/main-agent/target/agent-golden.jsonl as the
//     canonical routing bank instead of maintaining a parallel one.
//   - The runtime layer falls back to evals/scorecard/fixtures/ when no real
//     run-summaries.jsonl exists, so CI always produces a non-empty scorecard
//     and the `source` field records which data was used.
//   - The offline module is imported dynamically and degrades gracefully: if
//     its dependency chain (jose / langgraph) is unavailable, the offline
//     layer is reported as unavailable rather than crashing the runner.
//   - Exit code reflects ONLY the offline baseline (regression gate). Missing
//     runtime data is reported, not failed, since the agent may simply not
//     have served traffic yet.
//
// Usage:
//   node ./scripts/runScorecard.mjs
//   node ./scripts/runScorecard.mjs --runtime-file path/to/run-summaries.jsonl
//   node ./scripts/runScorecard.mjs --offline-skip
//   node ./scripts/runScorecard.mjs --out-dir /tmp/scorecards

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeOfflineBaseline,
  computeRuntimeMetrics,
  deriveIntentUniverse,
} from "../evals/scorecard/metrics.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "evals", "scorecard", "output");
const GOLDEN_PATH = path.join(REPO_ROOT, "evals", "main-agent", "target", "agent-golden.jsonl");
const DEFAULT_RUNTIME_PATH = path.join(REPO_ROOT, "logs", "agent-runtime", "run-summaries.jsonl");
const FIXTURE_PATH = path.join(REPO_ROOT, "evals", "scorecard", "fixtures", "sample-run-summaries.jsonl");

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parseArgs(argv) {
  const args = { runtimeFile: null, offlineSkip: false, outDir: DEFAULT_OUT_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--runtime-file") {
      args.runtimeFile = argv[i + 1];
      i += 1;
    } else if (token === "--offline-skip") {
      args.offlineSkip = true;
    } else if (token === "--out-dir") {
      args.outDir = argv[i + 1];
      i += 1;
    } else if (token === "-h" || token === "--help") {
      process.stdout.write(
        "Usage: runScorecard.mjs [--runtime-file PATH] [--offline-skip] [--out-dir PATH]\n",
      );
      process.exit(0);
    }
  }
  return args;
}

async function loadOfflineModule() {
  try {
    const mod = await import("../server/mainAgentToolPlanning.mjs");
    if (typeof mod.selectMainAgentToolset !== "function" || typeof mod.shouldPlanMainAgentTools !== "function") {
      return { ok: false, error: "required exports missing from mainAgentToolPlanning.mjs" };
    }
    return { ok: true, ...mod };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function replayOnce(item, selectMainAgentToolset, shouldPlanMainAgentTools) {
  const messages = [{ role: "user", content: item.query }];
  const expected = item.expected || {};
  try {
    const shouldPlan = shouldPlanMainAgentTools(messages);
    if (shouldPlan !== Boolean(expected.shouldPlanTools)) {
      return { ok: false, reason: `shouldPlanTools expected ${expected.shouldPlanTools} got ${shouldPlan}` };
    }
    const selected = selectMainAgentToolset(messages);
    if (expected.intent && selected.intent !== expected.intent) {
      return { ok: false, reason: `intent expected ${expected.intent} got ${selected.intent}` };
    }
    const toolNames = Array.isArray(selected.toolNames) ? selected.toolNames : [];
    for (const tool of expected.toolNamesInclude || []) {
      if (!toolNames.includes(tool)) {
        return { ok: false, reason: `missing required tool ${tool} in [${toolNames.join(", ")}]` };
      }
    }
    for (const tool of expected.toolNamesExclude || []) {
      if (toolNames.includes(tool)) {
        return { ok: false, reason: `forbidden tool ${tool} present in [${toolNames.join(", ")}]` };
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `replay threw: ${error?.message || String(error)}` };
  }
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# DTSV main-agent scorecard`);
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");

  lines.push("## Offline routing baseline (regression gate)");
  lines.push("");
  const off = report.offline;
  if (off.unavailable) {
    lines.push(`_Unavailable — ${off.reason}. The offline replay could not run; runtime metrics below are still valid._`);
  } else {
    lines.push("| metric | value |");
    lines.push("| --- | --- |");
    lines.push(`| sample size | ${off.sampleSize} |`);
    lines.push(`| passed | ${off.passed} |`);
    lines.push(`| failed | ${off.failed} |`);
    lines.push(`| pass rate | ${off.pass_rate_pct ?? "n/a"}% |`);
    if (off.failures && off.failures.length) {
      lines.push("");
      lines.push("### Failures");
      lines.push("");
      lines.push("| caseId | reason |");
      lines.push("| --- | --- |");
      for (const failure of off.failures) {
        lines.push(`| ${failure.caseId} | ${failure.reason} |`);
      }
    }
  }
  lines.push("");

  lines.push("## Runtime metrics");
  lines.push("");
  const rt = report.runtime;
  lines.push(`Data source: **${rt.source}**${rt.source === "logs" ? "" : " (sample — no live run-summaries.jsonl found)"}`);
  lines.push("");
  if (!rt.hasData) {
    lines.push("_No runtime rows available._");
  } else {
    lines.push("| metric | value |");
    lines.push("| --- | --- |");
    lines.push(`| sample size | ${rt.sampleSize} |`);
    lines.push(`| intent coverage | ${rt.intent_coverage_pct ?? "n/a"}% (universe ${rt.intent_universe_size}) |`);
    lines.push(`| citation pass rate | ${rt.citation_pass_rate_pct ?? "n/a"}% |`);
    lines.push(`| business-rule activation | ${rt.business_rule_activation_pct ?? "n/a"}% |`);
    lines.push(`| recovery success rate | ${rt.recovery_success_rate_pct ?? "n/a"}% |`);
    lines.push(`| latency p50 / p95 / max | ${rt.latency_ms.p50} / ${rt.latency_ms.p95} / ${rt.latency_ms.max} ms |`);
    lines.push("");
    lines.push("### Outcome distribution");
    lines.push("");
    lines.push("| outcome | share |");
    lines.push("| --- | --- |");
    for (const [key, share] of Object.entries(rt.outcome_distribution)) {
      lines.push(`| ${key} | ${share}% |`);
    }
    if (rt.failure_top_codes && rt.failure_top_codes.length) {
      lines.push("");
      lines.push("### Top failure codes");
      lines.push("");
      lines.push("| code | count |");
      lines.push("| --- | --- |");
      for (const entry of rt.failure_top_codes) {
        lines.push(`| ${entry.code} | ${entry.count} |`);
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const agentGolden = readJsonl(GOLDEN_PATH);
  if (agentGolden.length === 0) {
    process.stderr.write(`[scorecard] no agent-golden cases at ${GOLDEN_PATH}\n`);
    process.exit(2);
  }
  const intentUniverse = deriveIntentUniverse(agentGolden);

  let offline;
  if (args.offlineSkip) {
    offline = { unavailable: true, reason: "skipped via --offline-skip" };
  } else {
    const mod = await loadOfflineModule();
    if (mod.ok) {
      const results = agentGolden.map((item) => replayOnce(item, mod.selectMainAgentToolset, mod.shouldPlanMainAgentTools));
      offline = computeOfflineBaseline(agentGolden, results);
    } else {
      offline = { unavailable: true, reason: mod.error };
    }
  }

  const runtimePath = args.runtimeFile ? path.resolve(args.runtimeFile) : DEFAULT_RUNTIME_PATH;
  let runtimeRows = readJsonl(runtimePath);
  let runtimeSource = "logs";
  if (runtimeRows.length === 0) {
    runtimeRows = readJsonl(FIXTURE_PATH);
    runtimeSource = "fixture";
  }
  const runtimeMetrics = computeRuntimeMetrics(runtimeRows, { intentUniverse });

  const report = {
    generatedAt: new Date().toISOString(),
    intentUniverse: [...intentUniverse],
    offline,
    runtime: { ...runtimeMetrics, source: runtimeSource, path: runtimePath },
  };

  const outDir = args.outDir || DEFAULT_OUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(outDir, `scorecard-${stamp}.json`);
  const mdPath = path.join(outDir, `scorecard-${stamp}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdPath, renderMarkdown(report));

  process.stdout.write(renderMarkdown(report));
  process.stdout.write(`\n[scorecard] wrote ${path.relative(REPO_ROOT, jsonPath)} and ${path.relative(REPO_ROOT, mdPath)}\n`);

  const failedOffline = !offline.unavailable && offline.failed > 0;
  process.exit(failedOffline ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`[scorecard] fatal: ${error?.stack || error}\n`);
  process.exit(2);
});
