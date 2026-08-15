/**
 * P1: Dynamic context assembly.
 * Replaces the one-size-fits-all 25KB planning prompt with per-intent
 * sections assembled at request time. Tools rules load only for the
 * selected toolset; shared policy loads once.
 */

const SHARED_POLICY = `# Shared agent policy
Answer from supplied evidence; never invent data. Use ask_clarification for one focused question when required slots are missing.
Never generate SQL, loosen authorization scope, or retry a denied request. Convert relative dates to absolute Asia/Shanghai dates before analytics calls.`;

const TOOL_RULES = {
  query_analytics: [
    "Canonical tool for defect counts/trends/rankings/aggregates not covered by semantic tools.",
    "Top Issue growth: time.current + time.comparison windows, derived_metrics [delta, growth_pct], order_by delta desc.",
    "Module wording defaults to dimensions [business_module] unless the user asks for assigned_ecu or solution_cluster.",
  ],
  query_semantic_metrics: [
    "First choice for aggregate/trend/compare/rank/count/top-N over ontology-governed metrics and dimensions.",
    "Never redefine metrics after a semantic result; treat ontologyVersion/schemaFingerprint/quality as facts.",
  ],
  query_semantic_records: [
    "Governed list/drilldown requests. Continue from returned analysis_ref; only narrow with explicit selections.",
  ],
  query_traceability: [
    "Requirement/testcase/run/defect lineage questions. Use when user asks for lineage, not testcase drafting.",
  ],
  search_duplicates: ["Duplicate/similar defect analysis. Similarity is evidence, not causality."],
  diagnose_analytics_empty: [
    "Call with the same query when analytics returns zero rows or suspiciously small results before answering 'no data'.",
  ],
  search_analytics_filter_values: [
    "Resolve fuzzy detected_by/ECU/module/team values to exact filter candidates before query_analytics.",
  ],
  get_test_case_context: ["Fetch context before drafting/extending a testcase; for defect→testcase workflows call first."],
  query_defect_high_frequency_analysis: ["High-frequency defect concentration by ECU/module; recent week maps to recent_days 7."],
  get_ontology_catalog: ["What the ontology can answer: entities/relations/metrics/actions and capability states."],
  search_octane_fields: ["Local schema retrieval for field-level questions; top-k only, never full catalog."],
  ask_clarification: ["One focused question when filters/scope/timeframe/business meaning are ambiguous."],
  // Governed primitive rules (ported from the monolithic planning prompt so the
  // runtime can assemble per-intent context without losing governed policy).
  catalog: [
    "Use for governed data/ontology discovery or top-k Octane field retrieval. Catalog context is never execution permission.",
  ],
  resolve: [
    "Use for business-term normalization and exact filter-value linking before analysis; never guess a person, team, ECU, or module identifier.",
  ],
  analyze: [
    "Use for aggregate, compare, trend, rank, coverage, testing-team, high-frequency, or allowlisted dashboard questions. Prefer operation semantic_metrics when the governed Ontology plan supports the question. Use defect_aggregate only for supported gaps.",
    "Top Issue growth: time.current + time.comparison windows, derived_metrics [delta, growth_pct], order_by delta desc.",
    "For named defect reporters: first resolve operation filter_values for detected_by, then analyze operation defect_aggregate with that exact value; never substitute a team aggregate.",
    "Testing coverage: operation coverage_project or coverage_aida. Organization internal groups: testing_team_fv (FV is the group dimension, not tester).",
    "Recent high-frequency: operation defect_high_frequency with recent_days 7; module wording prefers business_module unless assigned_ecu/solution_cluster explicitly requested.",
  ],
  records: [
    "Use for lists and drilldowns. Prefer operation semantic with the prior analysis_ref; only narrow selections; never reconstruct or widen actor/filter/time/snapshot scope.",
  ],
  trace: [
    "Use for governed requirement, testcase, test-run, and defect lineage.",
  ],
  duplicate_search: [
    "Use only for similarity reasoning, never population statistics or causality.",
  ],
  prepare_testcase: [
    "Use for proposal context from a defect/testcase anchor. It can never commit or mutate Octane. For an Octane ticket URL extract id as defect_id anchor.",
  ],
};

const TERMINAL_RECOVERY_RULE = "On empty or suspicious results, do not conclude no data immediately; runtime performs one bounded diagnosis/correction before publication.";
const GOVERNED_CONTRACT_RULE = "Never redefine a governed metric after execution. Treat ontologyVersion, schemaFingerprint, sourceRevision, analysisRef, scope, quality, and EvidenceEnvelope as the factual contract. Never submit SQL, code, endpoint names, actor scope, or authorization fields.";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function buildDynamicPlanningContext({ intent, toolNames, policyHints = [], runtimeDate, extra = {} }) {
  const tools = (Array.isArray(toolNames) ? toolNames : []).map(String).filter(Boolean);
  const sections = [SHARED_POLICY];

  const rules = [];
  for (const name of tools) {
    for (const rule of TOOL_RULES[name] ?? []) rules.push(`- ${name}: ${rule}`);
  }
  if (rules.length) sections.push(`# Selected toolset rules (${intent || "general"})\n${rules.join("\n")}`);
  if (rules.length) sections.push(`# Terminal + governed contract\n- ${TERMINAL_RECOVERY_RULE}\n- ${GOVERNED_CONTRACT_RULE}`);

  if (policyHints.length) {
    sections.push(`# Policy hints\n${policyHints.map((hint) => `- ${hint}`).join("\n")}`);
  }
  if (runtimeDate) {
    sections.push(`# Runtime date\nCurrent date for relative analytics windows: ${runtimeDate}. Timezone: Asia/Shanghai.`);
  }
  if (isRecord(extra) && extra.dataQuality) {
    sections.push(`# Data quality footnote requirement\n${extra.dataQuality}`);
  }
  return sections.join("\n\n");
}

/** Attach a data-health footnote to a final answer. */
export function withDataQualityFootnote(answer, health) {
  if (!isRecord(health) || !health.notes?.length) return answer;
  const lines = health.notes.map((note) => `- ${note}`);
  return `${answer}\n\n> ⚠️ 数据说明\n${lines.join("\n")}`;
}
