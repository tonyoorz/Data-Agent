// Scorecard metrics for the DTSV main agent (task 27).
//
// The scorecard has two complementary layers:
//
//   1. Offline baseline — deterministic replay of the agent-golden routing cases
//      against selectMainAgentToolset / shouldPlanMainAgentTools. This confirms
//      intent classification and toolset selection have not regressed, with no
//      dependency on live traffic. It reuses the existing golden dataset rather
//      than maintaining a parallel bank.
//
//   2. Runtime metrics — six aggregate indicators derived from run-summaries.jsonl
//      (each row is written by runtimeAuditStore.appendRunSummary). Every metric
//      has a clear better/worse semantics so the trend is trackable run over run.
//      When no runtime data is available yet, each metric reports null + hasData
//      stays false, so CI does not fail simply because the agent has not served
//      traffic — only the offline baseline is reported in that case.
//
// Pure node only (no jose / langgraph / vitest imports), so the runner works in
// minimal environments and in CI.

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo);
}

function round1(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 10) / 10;
}

// Derive the canonical intent universe from the agent-golden cases. The runtime
// coverage metric is measured against this baseline so the number reflects "how
// many of the intents the agent is expected to handle have actually been seen".
export function deriveIntentUniverse(agentGoldenCases) {
  const set = new Set();
  for (const item of agentGoldenCases || []) {
    const intent = item?.expected?.intent;
    if (typeof intent === "string" && intent.trim()) set.add(intent.trim());
  }
  return set;
}

// Six runtime metrics over an array of parsed run-summaries.jsonl rows.
// options.intentUniverse — a Set of intents considered in-baseline (from golden).
export function computeRuntimeMetrics(summaries, options = {}) {
  const rows = Array.isArray(summaries) ? summaries : [];
  const total = rows.length;
  const intentUniverse = options.intentUniverse instanceof Set && options.intentUniverse.size > 0
    ? options.intentUniverse
    : new Set();

  const empty = {
    sampleSize: 0,
    hasData: false,
    intent_coverage_pct: null,
    intent_universe_size: intentUniverse.size,
    outcome_distribution: {},
    citation_pass_rate_pct: null,
    business_rule_activation_pct: null,
    recovery_success_rate_pct: null,
    latency_ms: { p50: null, p95: null, max: null },
    failure_top_codes: [],
  };
  if (total === 0) return empty;

  // 1. Intent coverage — share of the golden intent universe observed in runs.
  const seen = new Set();
  for (const row of rows) {
    if (row && typeof row.intent === "string" && row.intent) seen.add(row.intent);
  }
  const universe = [...intentUniverse];
  const covered = universe.filter((i) => seen.has(i)).length;
  const intentCoverage = universe.length > 0 ? (covered / universe.length) * 100 : null;

  // 2. Outcome distribution — completed / blocked / denied / needs_clarification / error / other.
  const buckets = {};
  for (const row of rows) {
    const key = row && typeof row.outcome === "string" && row.outcome ? row.outcome : "unknown";
    buckets[key] = (buckets[key] || 0) + 1;
  }
  const outcomeDistribution = Object.fromEntries(
    Object.entries(buckets)
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => [key, round1((count / total) * 100)]),
  );

  // 3. Citation pass rate — share of runs whose answer citations validated as pass.
  const citationPass = rows.filter((r) => r && r.citationValidation === "pass").length;
  const citationPassRate = (citationPass / total) * 100;

  // 4. Business-rule activation rate — share of runs that activated at least one
  //    approved business rule (planner effect rule or validator rule). Measures
  //    whether the governed business-knowledge layer is actually engaged.
  const ruleActivated = rows.filter(
    (r) => Array.isArray(r && r.businessRuleCodes) && r.businessRuleCodes.length > 0,
  ).length;
  const ruleActivationRate = (ruleActivated / total) * 100;

  // 5. Recovery success rate — among runs that attempted recovery, share that recovered.
  const recoveryRuns = rows.filter(
    (r) => Array.isArray(r && r.recoveryOutcomes) && r.recoveryOutcomes.length > 0,
  );
  const recoveryTotal = recoveryRuns.length;
  let recoverySuccessRate = null;
  if (recoveryTotal > 0) {
    const recovered = recoveryRuns.filter(
      (r) => r.recoveryOutcomes.some((o) => /recover(ed)?/iu.test(String(o))),
    ).length;
    recoverySuccessRate = (recovered / recoveryTotal) * 100;
  }

  // 6. Latency p50 / p95 / max in ms.
  const latencies = rows
    .map((r) => Number(r && r.latencyMs))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  const latency = latencies.length
    ? {
        p50: Math.round(percentile(latencies, 50)),
        p95: Math.round(percentile(latencies, 95)),
        max: Math.round(latencies[latencies.length - 1]),
      }
    : { p50: null, p95: null, max: null };

  // Diagnostic: top failure codes (not one of the six, but surfaces what breaks).
  const failBuckets = {};
  for (const row of rows) {
    const code = row && typeof row.failureCode === "string" && row.failureCode ? row.failureCode : null;
    if (!code) continue;
    failBuckets[code] = (failBuckets[code] || 0) + 1;
  }
  const failureTop = Object.entries(failBuckets)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([code, count]) => ({ code, count }));

  return {
    sampleSize: total,
    hasData: true,
    intent_coverage_pct: round1(intentCoverage),
    intent_universe_size: universe.length,
    outcome_distribution: outcomeDistribution,
    citation_pass_rate_pct: round1(citationPassRate),
    business_rule_activation_pct: round1(ruleActivationRate),
    recovery_success_rate_pct: round1(recoverySuccessRate),
    latency_ms: latency,
    failure_top_codes: failureTop,
  };
}

// Offline baseline over agent-golden cases replayed against the pure routing
// functions. `results` is a parallel array of { ok, reason? }.
export function computeOfflineBaseline(cases, results) {
  const total = cases.length;
  const passed = results.filter((r) => r && r.ok).length;
  return {
    sampleSize: total,
    passed,
    failed: total - passed,
    pass_rate_pct: total === 0 ? null : round1((passed / total) * 100),
    failures: results
      .map((r, i) => (r && r.ok
        ? null
        : { caseId: cases[i]?.caseId || `case-${i + 1}`, reason: r?.reason || "unknown" }))
      .filter(Boolean),
  };
}
