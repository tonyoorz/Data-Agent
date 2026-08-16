/**
 * Eval regression gate — compares a fresh eval report against a stored baseline.
 * Exit 1 (CI semantics) when accuracy drops > TOLERANCE_PP percentage points
 * or the dataset shrank. Improvements always pass.
 *
 * Usage:
 *   node scripts/evalRegression.mjs                          # run + compare vs baseline
 *   node scripts/evalRegression.mjs --update-baseline        # run + overwrite baseline
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TOLERANCE_PP = 2;
const BASELINE_PATH = new URL("../src/test/server/evals/baseline.json", import.meta.url);
const DATASET_PATH = new URL("../src/test/server/evals/dataset/golden-v1.jsonl", import.meta.url);
const ANCHOR_AT = "2026-08-16T02:00:00.000Z"; // fixed anchor — bump with dataset version bumps

export function evaluateRegression(baseline, current) {
  const dropPp = Number(((baseline.accuracy - current.accuracy) * 100).toFixed(6));
  const reasons = [];
  if (current.total < baseline.total) reasons.push("DATASET_SHRINK");
  if (dropPp > TOLERANCE_PP) reasons.push(`ACCURACY_DROP_${dropPp.toFixed(2)}PP`);
  return { ok: reasons.length === 0, dropPp, reasons, tolerancePp: TOLERANCE_PP };
}

async function runEval() {
  const { createOntologyRegistry } = await import(pathToFileURL("server/ontology/registry.mjs").href);
  const { createSemanticResolver } = await import(pathToFileURL("server/ontology/resolver.mjs").href);
  const { createEvalRunner } = await import(pathToFileURL("server/agentRuntime/evalRunner.mjs").href);
  const actor = { actorId: "eval", scopeHash: "eval-scope", scopes: { workspaceIds: ["DTSV"], teamIds: ["DTSV"] } };
  const registry = createOntologyRegistry();
  const resolver = createSemanticResolver({ registry, now: () => ANCHOR_AT });
  const runner = createEvalRunner({ registry, resolver, now: () => ANCHOR_AT, actor });
  const cases = readFileSync(DATASET_PATH, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const report = runner.run(cases);
  return {
    dataset: "golden-v1.jsonl",
    anchorAt: ANCHOR_AT,
    total: report.total,
    passed: report.passed,
    accuracy: Number(report.accuracy.toFixed(4)),
    byIntent: report.byIntent,
    at: new Date().toISOString(),
  };
}

async function main() {
  const update = process.argv.includes("--update-baseline");
  const current = await runEval();

  if (update || !existsSync(BASELINE_PATH)) {
    writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + "\n", "utf8");
    console.log(`baseline ${update ? "updated" : "created"}: accuracy=${current.accuracy} (${current.passed}/${current.total})`);
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const verdict = evaluateRegression(baseline, current);
  console.log(JSON.stringify({
    baseline: { accuracy: baseline.accuracy, passed: baseline.passed, total: baseline.total },
    current: { accuracy: current.accuracy, passed: current.passed, total: current.total },
    dropPp: verdict.dropPp,
    tolerancePp: verdict.tolerancePp,
    ok: verdict.ok,
    reasons: verdict.reasons,
  }, null, 2));
  process.exit(verdict.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1]?.endsWith("evalRegression.mjs");
if (invokedDirectly) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
