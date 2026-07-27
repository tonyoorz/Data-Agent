import { semanticQuerySchema } from "./ontology/queryCompiler.mjs";

const DEFAULT_ANALYTICS_API_BASE = process.env.VIZION_ANALYTICS_API_BASE || "http://127.0.0.1:3003";

const DASHBOARD_SUMMARY_FILTER_KEYS = new Set([
  "years",
  "requirements",
  "china_scopes",
  "projects",
  "assigned_ecus",
  "problem_finder_teams",
  "aidas",
  "phases",
  "solution_clusters",
  "pus",
  "markets",
  "lead_models",
  "groups",
  "creation_time_start",
  "creation_time_end",
]);

const COVERAGE_FILTER_KEYS = new Set([
  "years",
  "projects",
  "test_weeks",
  "pus",
  "aidas",
  "statuses",
  "feature_regions",
  "fvps",
  "fvs",
]);

const STRING_OR_STRING_ARRAY_SCHEMA = {
  oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
};

const DEFECT_METRIC_VALUES = [
  "defect_count",
  "resolved_forward_count",
  "rejected_directly_count",
  "resolved_forward_rate",
  "rejected_directly_rate",
];

const DEFECT_DIMENSION_VALUES = [
  "business_module",
  "assigned_ecu",
  "solution_cluster",
  "defect_category",
  "phase",
  "aida",
  "project",
  "problem_finder_team",
  "outcome_flag",
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const FULL_PICTURE_MODULE_ENDPOINTS = {
  dashboard_summary: "/api/full-picture/dashboard/summary",
  dashboard_tickets: "/api/full-picture/dashboard/tickets",
  top_issue_analysis: "/api/full-picture/top-issue-analysis",
  long_runner_analysis: "/api/full-picture/long-runner-analysis",
  defect_high_frequency_analysis: "/api/full-picture/defect-high-frequency-analysis",
};

const SEMANTIC_TOOL_NAMES = new Set(["query_semantic_metrics", "query_semantic_records", "query_traceability"]);

export const MAIN_AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_data_catalog",
      description: "List the QGate analytics datasets, metrics, dimensions, filters, and allowed modules available to the main agent before choosing a data query tool.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_ontology_catalog",
      description: "Fetch the ontology catalog with entity types, relationship types, action capability states, guardrails, and available ontology-backed agent tools.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_octane_fields",
      description: "Search the local Octane field catalog for a small top-k set of relevant API/database fields. Use this for schema discovery before choosing metrics, dimensions, filters, or Octane action fields; do not ask for or return the full field catalog.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Business wording or field meaning to search for, such as DTSV, 车系, owner, phase, testcase, or software version.",
          },
          entity: {
            type: "string",
            description: "Optional normalized entity filter such as defect, manual_run, testcase, or feature.",
          },
          top_k: {
            type: "number",
            description: "Maximum field candidates to return. Use 10 unless the user asks for a broader schema audit.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resolve_business_terms",
      description: "Map common Chinese/English QGate analytics terms from a user question to safe datasets, metrics, filters, and clarification hints.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The user's analytics question or phrase to normalize.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_semantic_metrics",
      description: "Execute a validated Ontology metric query against the semantic analytics API. The query must come from the governed query planner.",
      parameters: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: { query: semanticQuerySchema },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_semantic_records",
      description: "Execute a validated Ontology record or drill-down query against the semantic analytics API.",
      parameters: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: { query: semanticQuerySchema },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_traceability",
      description: "Execute a validated Ontology traceability query across requirement, testcase, test-run, and defect relationships.",
      parameters: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: { query: semanticQuerySchema },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_dashboard_summary",
      description: "Query the QGate Main Dashboard summary through the analytics API using safe dashboard filters.",
      parameters: {
        type: "object",
        properties: {
          filters: {
            type: "object",
            description: "Dashboard filters. Use years and repository filter vocabulary when known.",
            properties: {
              years: { oneOf: [{ type: "string" }, { type: "number" }, { type: "array", items: { type: "string" } }] },
              requirements: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
              china_scopes: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
              projects: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
              assigned_ecus: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
              problem_finder_teams: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
              aidas: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
              phases: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
              solution_clusters: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
              pus: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
              markets: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
              lead_models: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
              groups: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
              creation_time_start: { type: "string" },
              creation_time_end: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        required: ["filters"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_testing_coverage_project_status",
      description: "Query Testing Coverage project-status rows through the analytics API using safe coverage filters.",
      parameters: {
        type: "object",
        properties: {
          filters: {
            type: "object",
            description: "Testing Coverage filters mapped to the coverage-analysis API.",
            properties: {
              years: STRING_OR_STRING_ARRAY_SCHEMA,
              projects: STRING_OR_STRING_ARRAY_SCHEMA,
              test_weeks: STRING_OR_STRING_ARRAY_SCHEMA,
              pus: STRING_OR_STRING_ARRAY_SCHEMA,
              aidas: STRING_OR_STRING_ARRAY_SCHEMA,
              statuses: STRING_OR_STRING_ARRAY_SCHEMA,
              feature_regions: STRING_OR_STRING_ARRAY_SCHEMA,
              fvps: STRING_OR_STRING_ARRAY_SCHEMA,
              fvs: STRING_OR_STRING_ARRAY_SCHEMA,
            },
            additionalProperties: false,
          },
        },
        required: ["filters"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_test_case_context",
      description: "Fetch ontology-backed context for creating or extending a test case from a test_id or defect_id anchor, including tested scope, run results, traceability, gaps, and provenance.",
      parameters: {
        type: "object",
        properties: {
          anchor: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["test_id", "defect_id"] },
              value: { type: "string" },
            },
            required: ["type", "value"],
            additionalProperties: false,
          },
          purpose: {
            type: "string",
            enum: ["create_test_case"],
            description: "The intended use of the context. Use create_test_case for testcase drafting or coverage-gap explanation.",
          },
        },
        required: ["anchor"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_defect_high_frequency_analysis",
      description: "Query Defect High Frequency analysis through the analytics API. Use this for newly created defects concentrated by ECU/module, repeat rate, or high-frequency defect modules.",
      parameters: {
        type: "object",
        properties: {
          filters: {
            type: "object",
            description: "Dashboard filters. For recent-window questions, either provide creation_time_start/end or set recent_days.",
            properties: {
              years: { oneOf: [{ type: "string" }, { type: "number" }, { type: "array", items: { type: "string" } }] },
              requirements: STRING_OR_STRING_ARRAY_SCHEMA,
              china_scopes: STRING_OR_STRING_ARRAY_SCHEMA,
              projects: STRING_OR_STRING_ARRAY_SCHEMA,
              assigned_ecus: STRING_OR_STRING_ARRAY_SCHEMA,
              problem_finder_teams: STRING_OR_STRING_ARRAY_SCHEMA,
              aidas: STRING_OR_STRING_ARRAY_SCHEMA,
              phases: STRING_OR_STRING_ARRAY_SCHEMA,
              solution_clusters: STRING_OR_STRING_ARRAY_SCHEMA,
              pus: STRING_OR_STRING_ARRAY_SCHEMA,
              markets: STRING_OR_STRING_ARRAY_SCHEMA,
              lead_models: STRING_OR_STRING_ARRAY_SCHEMA,
              groups: STRING_OR_STRING_ARRAY_SCHEMA,
              creation_time_start: { type: "string" },
              creation_time_end: { type: "string" },
              recent_days: { type: "number", description: "Relative creation-time window ending today, e.g. 7 for 最近一周." },
            },
            additionalProperties: false,
          },
          limit: {
            type: "number",
            description: "Maximum number of ECU/module frequency rows to return. Use 12 unless a smaller top N is requested.",
          },
        },
        required: ["filters"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_defect_aggregate",
      description: "Query governed defect aggregates from the Analytics Query Kernel using allowlisted metrics, one dimension, filters, and creation-time windows. Prefer this for flexible defect count, compare, concentration, and outcome-rate questions.",
      parameters: {
        type: "object",
        properties: {
          metrics: {
            type: "array",
            items: { type: "string", enum: DEFECT_METRIC_VALUES },
            description: "Defect metrics to compute. Use explicit rate metrics instead of generic ratios.",
          },
          dimensions: {
            type: "array",
            items: { type: "string", enum: DEFECT_DIMENSION_VALUES },
            maxItems: 1,
            description: "At most one v1 grouping dimension. Use business_module for solution_cluster else defect_category else UNCLASSIFIED.",
          },
          derived_metrics: {
            type: "array",
            items: { type: "string", enum: ["delta", "growth_pct"] },
            description: "Optional comparison metrics. When previous count is 0, growth_pct is null and is_new marks new groups.",
          },
          filters: {
            type: "object",
            properties: {
              years: { oneOf: [{ type: "string" }, { type: "number" }, { type: "array", items: { type: "string" } }] },
              months: STRING_OR_STRING_ARRAY_SCHEMA,
              requirements: STRING_OR_STRING_ARRAY_SCHEMA,
              china_scopes: STRING_OR_STRING_ARRAY_SCHEMA,
              projects: STRING_OR_STRING_ARRAY_SCHEMA,
              assigned_ecus: STRING_OR_STRING_ARRAY_SCHEMA,
              problem_finder_teams: STRING_OR_STRING_ARRAY_SCHEMA,
              aidas: STRING_OR_STRING_ARRAY_SCHEMA,
              phases: STRING_OR_STRING_ARRAY_SCHEMA,
              solution_clusters: STRING_OR_STRING_ARRAY_SCHEMA,
              pus: STRING_OR_STRING_ARRAY_SCHEMA,
              markets: STRING_OR_STRING_ARRAY_SCHEMA,
              lead_models: STRING_OR_STRING_ARRAY_SCHEMA,
              groups: STRING_OR_STRING_ARRAY_SCHEMA,
            },
            additionalProperties: false,
          },
          time: {
            type: "object",
            properties: {
              field: { type: "string", enum: ["creation_time"] },
              current: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
              comparison: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
              timezone: { type: "string", enum: ["Asia/Shanghai"] },
            },
            required: ["field", "current", "timezone"],
            additionalProperties: false,
          },
          order_by: {
            type: "array",
            items: {
              type: "object",
              properties: {
                field: { type: "string" },
                direction: { type: "string", enum: ["asc", "desc"] },
              },
              required: ["field", "direction"],
              additionalProperties: false,
            },
          },
          min_baseline_count: { type: "number" },
          limit: { type: "number" },
        },
        required: ["metrics", "dimensions", "filters", "time"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_defect_records",
      description: "Fetch example defect records for a query_defect_aggregate row using its drilldown_ref. Records illustrate cases; they do not prove causality.",
      parameters: {
        type: "object",
        properties: {
          drilldown_ref: { type: "string", description: "Opaque drilldown_ref returned by query_defect_aggregate." },
          limit: { type: "number", description: "Maximum records to return, capped by the server." },
        },
        required: ["drilldown_ref"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_full_picture_module",
      description: "Generic allowlisted Full Picture dashboard module query. Use this as a fallback for factual Full Picture questions not covered by a more specific tool.",
      parameters: {
        type: "object",
        properties: {
          module: {
            type: "string",
            enum: Object.keys(FULL_PICTURE_MODULE_ENDPOINTS),
            description: "Allowed Full Picture module endpoint to query.",
          },
          filters: {
            type: "object",
            description: "Dashboard filters using repository filter vocabulary.",
            properties: {
              years: { oneOf: [{ type: "string" }, { type: "number" }, { type: "array", items: { type: "string" } }] },
              requirements: STRING_OR_STRING_ARRAY_SCHEMA,
              china_scopes: STRING_OR_STRING_ARRAY_SCHEMA,
              projects: STRING_OR_STRING_ARRAY_SCHEMA,
              assigned_ecus: STRING_OR_STRING_ARRAY_SCHEMA,
              problem_finder_teams: STRING_OR_STRING_ARRAY_SCHEMA,
              aidas: STRING_OR_STRING_ARRAY_SCHEMA,
              phases: STRING_OR_STRING_ARRAY_SCHEMA,
              solution_clusters: STRING_OR_STRING_ARRAY_SCHEMA,
              pus: STRING_OR_STRING_ARRAY_SCHEMA,
              markets: STRING_OR_STRING_ARRAY_SCHEMA,
              lead_models: STRING_OR_STRING_ARRAY_SCHEMA,
              groups: STRING_OR_STRING_ARRAY_SCHEMA,
              creation_time_start: { type: "string" },
              creation_time_end: { type: "string" },
              recent_days: { type: "number" },
            },
            additionalProperties: false,
          },
          limit: { type: "number" },
          search: { type: "string" },
          page: { type: "number" },
          page_size: { type: "number" },
          sort_by: { type: "string" },
          sort_order: { type: "string", enum: ["asc", "desc"] },
        },
        required: ["module", "filters"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_duplicates",
      description: "Search QGate/Octane defects for possible duplicate or similar historical issues using the duplicate-search agent core.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The defect symptom, title, or user question to search for duplicates.",
          },
          top_k: {
            type: "number",
            description: "Maximum number of duplicate candidates to return. Use 5 unless the user asks for a different count.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_clarification",
      description: "Ask the user one focused clarification question when required filters, scope, timeframe, or business meaning are ambiguous. Use this instead of guessing missing analytics conditions.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "One concise question to ask the user.",
          },
          reason: {
            type: "string",
            description: "Why the clarification is needed before querying data.",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Optional short choices the user can pick from.",
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
  },
];

function parseToolArguments(rawArguments) {
  if (!rawArguments) {
    return {};
  }

  if (typeof rawArguments === "object") {
    return rawArguments;
  }

  return JSON.parse(String(rawArguments));
}

function appendFilterValue(searchParams, key, value) {
  if (value == null || value === "") {
    return;
  }

  if (Array.isArray(value)) {
    const normalized = value.map((item) => String(item).trim()).filter(Boolean).join(",");
    if (normalized) {
      searchParams.set(key, normalized);
    }
    return;
  }

  searchParams.set(key, String(value).trim());
}

function buildDashboardSummaryUrl(filters, analyticsApiBase) {
  const url = new URL("/api/full-picture/dashboard/summary", analyticsApiBase);
  for (const [key, value] of Object.entries(filters || {})) {
    if (!DASHBOARD_SUMMARY_FILTER_KEYS.has(key)) {
      continue;
    }
    appendFilterValue(url.searchParams, key, value);
  }
  return url.toString();
}

function buildCoverageProjectStatusUrl(filters, analyticsApiBase) {
  const url = new URL("/api/testing/coverage-analysis/project-status", analyticsApiBase);
  for (const [key, value] of Object.entries(filters || {})) {
    if (!COVERAGE_FILTER_KEYS.has(key)) {
      continue;
    }
    appendFilterValue(url.searchParams, key, value);
  }
  return url.toString();
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function resolveRelativeDateFilters(filters, now = new Date()) {
  const resolved = { ...(filters || {}) };
  const recentDays = Number(resolved.recent_days || 0);
  delete resolved.recent_days;
  if (!Number.isFinite(recentDays) || recentDays <= 0) {
    return resolved;
  }

  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Math.max(1, Math.round(recentDays)) + 1);

  if (!DATE_RE.test(String(resolved.creation_time_start || ""))) {
    resolved.creation_time_start = toIsoDate(start);
  }
  if (!DATE_RE.test(String(resolved.creation_time_end || ""))) {
    resolved.creation_time_end = toIsoDate(end);
  }
  if (!resolved.years) {
    resolved.years = String(end.getUTCFullYear());
  }
  return resolved;
}

function buildDefectHighFrequencyUrl({ filters, limit }, analyticsApiBase, now) {
  const url = new URL("/api/full-picture/defect-high-frequency-analysis", analyticsApiBase);
  const resolvedFilters = resolveRelativeDateFilters(filters, now);
  for (const [key, value] of Object.entries(resolvedFilters || {})) {
    if (!DASHBOARD_SUMMARY_FILTER_KEYS.has(key)) {
      continue;
    }
    appendFilterValue(url.searchParams, key, value);
  }
  const rowLimit = Math.max(1, Math.min(50, Number(limit || 12)));
  url.searchParams.set("limit", String(rowLimit));
  return url.toString();
}

function appendOptionalNumber(searchParams, key, value, { min = 1, max = 1000, fallback = null } = {}) {
  if (value == null && fallback == null) {
    return;
  }
  const numeric = Number(value ?? fallback);
  if (!Number.isFinite(numeric)) {
    return;
  }
  searchParams.set(key, String(Math.max(min, Math.min(max, Math.round(numeric)))));
}

function buildFullPictureModuleUrl(args, analyticsApiBase, now) {
  const moduleName = String(args.module || "").trim();
  const endpoint = FULL_PICTURE_MODULE_ENDPOINTS[moduleName];
  if (!endpoint) {
    return { error: `Unsupported full picture module: ${moduleName}`, url: "", moduleName };
  }

  const url = new URL(endpoint, analyticsApiBase);
  const resolvedFilters = resolveRelativeDateFilters(args.filters || {}, now);
  for (const [key, value] of Object.entries(resolvedFilters || {})) {
    if (!DASHBOARD_SUMMARY_FILTER_KEYS.has(key)) {
      continue;
    }
    appendFilterValue(url.searchParams, key, value);
  }

  if (args.limit != null) {
    appendOptionalNumber(url.searchParams, "limit", args.limit, { min: 1, max: 100 });
  }
  if (args.search) {
    url.searchParams.set("search", String(args.search).trim());
  }
  appendOptionalNumber(url.searchParams, "page", args.page, { min: 1, max: 10000 });
  appendOptionalNumber(url.searchParams, "page_size", args.page_size, { min: 1, max: 500 });
  if (args.sort_by) {
    url.searchParams.set("sort_by", String(args.sort_by).trim());
  }
  if (["asc", "desc"].includes(String(args.sort_order || "").toLowerCase())) {
    url.searchParams.set("sort_order", String(args.sort_order).toLowerCase());
  }

  return { url: url.toString(), moduleName };
}

async function postAnalyticsJson(path, payload, { analyticsFetch, analyticsApiBase }) {
  const url = new URL(path, analyticsApiBase).toString();
  const response = await analyticsFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { url, response };
}

function buildActorScope(actor) {
  const scopes = actor?.scopes || {};
  return {
    actorId: String(actor?.actorId || ""),
    scopeHash: String(actor?.scopeHash || ""),
    workspaceIds: Array.isArray(scopes.workspaceIds) ? scopes.workspaceIds.map(String) : [],
    projectIds: Array.isArray(scopes.projectIds) ? scopes.projectIds.map(String) : [],
    teamIds: Array.isArray(scopes.teamIds) ? scopes.teamIds.map(String) : [],
    allowedObjectTypes: Array.isArray(scopes.allowedObjectTypes) ? scopes.allowedObjectTypes.map(String) : [],
    allowedPropertyIds: Array.isArray(scopes.allowedPropertyIds) ? scopes.allowedPropertyIds.map(String) : [],
    rowPolicyIds: Array.isArray(scopes.rowPolicyIds) ? scopes.rowPolicyIds.map(String) : [],
    sensitiveFieldPolicyIds: Array.isArray(scopes.sensitiveFieldPolicyIds) ? scopes.sensitiveFieldPolicyIds.map(String) : [],
  };
}

function buildToolMessage(toolCall, content) {
  return {
    role: "tool",
    tool_call_id: toolCall?.id || "",
    name: toolCall?.function?.name || "",
    content,
  };
}

function formatSemanticContext(name, payload) {
  const metrics = payload?.summary?.metrics || {};
  const metricLines = Object.entries(metrics).map(([metricId, value]) => `${metricId}: ${value}`);
  const rows = Array.isArray(payload?.data) ? payload.data.length : 0;
  return [
    "# Main agent semantic tool result",
    `Tool: ${name}`,
    `Ontology: ${payload?.ontologyVersion || "unknown"} (${payload?.schemaFingerprint || "no fingerprint"})`,
    `Source revision: ${payload?.sourceRevision?.revisionId || "unpinned"}`,
    `Rows: ${rows}`,
    ...metricLines,
    `Completeness: ${payload?.quality?.completeness || "unknown"}`,
    "Use only the returned governed metrics, scope, source revision, and quality metadata as factual evidence.",
  ].join("\n");
}

async function executeSemanticQuery(toolCall, { analyticsFetch, analyticsApiBase, actor }) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const query = args.query;
  const url = new URL("/api/semantic/query", analyticsApiBase).toString();
  const body = {
    schemaVersion: "1.0",
    queryId: String(toolCall?.id || `semantic-${Date.now()}`),
    ontologyVersion: query?.ontologyVersion,
    schemaFingerprint: query?.schemaFingerprint,
    query,
    actorScope: buildActorScope(actor),
  };
  const response = await analyticsFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response?.ok) {
    let failure = {};
    try {
      failure = await response.json();
    } catch {
      failure = {};
    }
    const code = String(failure?.code || `SEMANTIC_API_HTTP_${response?.status || "UNKNOWN"}`);
    throw Object.assign(new Error(code), {
      code,
      status: response?.status === 403 ? "denied" : "failed",
      statusCode: response?.status || 502,
      retryable: response?.status === 429 || Number(response?.status || 0) >= 500,
    });
  }

  const payload = await response.json();
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: toolCall.function.name, result: payload })),
    contextText: formatSemanticContext(toolCall.function.name, payload),
  };
}

function buildDataCatalogPayload() {
  return {
    datasets: [
      {
        id: "defects",
        description: "QGate/Octane defect records for Main Dashboard, outcome, phase, team, project, AIDA, ECU, PU, market, lead model, and China/Global analysis.",
        metrics: DEFECT_METRIC_VALUES,
        dimensions: DEFECT_DIMENSION_VALUES,
        filters: Array.from(DASHBOARD_SUMMARY_FILTER_KEYS),
      },
      {
        id: "testing_coverage",
        description: "Manual-run and testcase execution data for Testing Coverage analysis.",
        metrics: ["run_count", "status_count", "testcase_count"],
        dimensions: Array.from(COVERAGE_FILTER_KEYS),
        filters: Array.from(COVERAGE_FILTER_KEYS),
      },
    ],
    modules: Object.keys(FULL_PICTURE_MODULE_ENDPOINTS),
    termHints: {
      "最近一周": { filter: "recent_days", value: 7 },
      "新增缺陷": { dataset: "defects", metric: "created_count", time_field: "creation_time" },
      DTSV: { filter: "problem_finder_teams", value: "DTSV_China" },
      ECU: { filter: "assigned_ecus" },
      "测试覆盖率": { dataset: "testing_coverage" },
    },
    guardrails: [
      "Use only listed filters, dimensions, and modules.",
      "Use query_defect_aggregate for flexible defect analysis, then query_defect_records only for examples from a returned drilldown_ref.",
      "Ask clarification when metric meaning or filter scope is ambiguous.",
      "Regression-commit causality is not available from these dashboard datasets alone.",
    ],
  };
}

function executeDataCatalog(toolCall) {
  const payload = buildDataCatalogPayload();
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: "get_data_catalog", result: payload })),
    contextText: [
      "# Main agent tool result",
      "Tool: get_data_catalog",
      `Datasets: ${payload.datasets.map((dataset) => dataset.id).join(", ")}`,
      `Full Picture modules: ${payload.modules.join(", ")}`,
      `Defect filters: ${payload.datasets[0].filters.join(", ")}`,
      `Testing Coverage filters: ${payload.datasets[1].filters.join(", ")}`,
      "Use this catalog to choose an allowlisted analytics tool. Do not invent fields, filters, modules, or SQL.",
    ].join("\n"),
  };
}

function summarizeCapabilityItems(items) {
  return (Array.isArray(items) ? items : [])
    .slice(0, 12)
    .map((item) => `${item.id || "unknown"} ${item.capability_state || "unknown"}`)
    .join(", ");
}

function formatOntologyCatalogContext(url, payload) {
  const entities = summarizeCapabilityItems(payload?.entity_types);
  const relationships = summarizeCapabilityItems(payload?.relationship_types);
  const agentTools = summarizeCapabilityItems(payload?.agent_tools);
  const actions = summarizeCapabilityItems(payload?.actions);
  const guardrails = Array.isArray(payload?.guardrails) ? payload.guardrails.slice(0, 5) : [];
  return [
    "# Main agent tool result",
    "Tool: get_ontology_catalog",
    `Source query: GET ${url}`,
    `Ontology version: ${payload?.ontology_version || "unknown"}`,
    entities ? `Entities: ${entities}` : "Entities: none",
    relationships ? `Relationships: ${relationships}` : "Relationships: none",
    agentTools ? `Agent tools: ${agentTools}` : "Agent tools: none",
    actions ? `Actions: ${actions}` : "Actions: none",
    guardrails.length ? `Guardrails: ${guardrails.join(" | ")}` : "Guardrails: none",
    "Use available capabilities normally, partial capabilities with caveats, and unavailable, disabled, or blocked capabilities as not executable.",
  ].join("\n");
}

async function executeOntologyCatalog(toolCall, { analyticsFetch, analyticsApiBase }) {
  const url = new URL("/api/ontology/catalog", analyticsApiBase).toString();
  const response = await analyticsFetch(url);
  if (!response?.ok) {
    const content = JSON.stringify({ error: `Analytics API request failed for get_ontology_catalog: ${response?.status || "unknown"}` });
    return {
      toolMessage: buildToolMessage(toolCall, content),
      contextText: `# Main agent tool result\nTool: get_ontology_catalog\nSource query: GET ${url}\nResult: unavailable because the analytics API request failed.`,
    };
  }

  const payload = await response.json();
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: "get_ontology_catalog", url, result: payload })),
    contextText: formatOntologyCatalogContext(url, payload),
  };
}

function formatOctaneFieldSearchContext(url, payload) {
  const rows = (Array.isArray(payload?.results) ? payload.results : []).slice(0, 12).map((field, index) => (
    `${index + 1}. ${field.id || "unknown"} entity=${field.entity || "unknown"} bucket=${field.businessBucket || "unknown"} status=${field.ontologyStatus || "unknown"} score=${field.score || 0}`
  ));
  return [
    "# Main agent tool result",
    "Tool: search_octane_fields",
    `Source query: POST ${url}`,
    `Catalog fields: ${payload?.summary?.fieldCount ?? "unknown"}; raw JSON fields: ${payload?.summary?.rawJsonFieldCount ?? "unknown"}; candidates: ${payload?.summary?.candidateFieldCount ?? "unknown"}`,
    rows.length ? "Field candidates:" : "Field candidates: none",
    ...rows,
    "Use these field candidates only as schema hints. Do not treat a field candidate as a governed metric or factual data result until an ontology or analytics tool validates it.",
  ].join("\n");
}

async function executeOctaneFieldSearch(toolCall, { analyticsFetch, analyticsApiBase }) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const payload = {
    query: String(args.query || "").trim(),
    ...(args.entity ? { entity: String(args.entity).trim() } : {}),
    top_k: Math.max(1, Math.min(50, Number(args.top_k || 10))),
  };
  const { url, response } = await postAnalyticsJson("/api/ontology/fields/search", payload, { analyticsFetch, analyticsApiBase });
  if (!response?.ok) {
    const content = JSON.stringify({ error: `Analytics API request failed for search_octane_fields: ${response?.status || "unknown"}` });
    return {
      toolMessage: buildToolMessage(toolCall, content),
      contextText: `# Main agent tool result\nTool: search_octane_fields\nSource query: POST ${url}\nResult: unavailable because the analytics API request failed.`,
    };
  }

  const result = await response.json();
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: "search_octane_fields", url, result })),
    contextText: formatOctaneFieldSearchContext(url, result),
  };
}

function resolveBusinessTerms(query) {
  const text = String(query || "");
  const lowerText = text.toLowerCase();
  const resolved = [];
  const filters = {};
  const metrics = [];
  const datasets = new Set();
  const clarifications = [];

  if (/dtsv/i.test(text)) {
    filters.problem_finder_teams = ["DTSV_China"];
    resolved.push({ term: "DTSV", mapsTo: "problem_finder_teams", value: "DTSV_China" });
  }
  if (/最近一周|last\s*7\s*days|recent\s*week/i.test(text)) {
    filters.recent_days = 7;
    resolved.push({ term: "最近一周", mapsTo: "recent_days", value: 7 });
  }
  if (/新增|新建|创建|提交|提了|opened|created|raised|submitted/i.test(text)) {
    datasets.add("defects");
    metrics.push("created_count");
    resolved.push({ term: "新增/创建/提交", mapsTo: "octane_defects.creation_time" });
  }
  if (/ecu|模块/i.test(text)) {
    datasets.add("defects");
    resolved.push({ term: "ECU/模块", mapsTo: "assigned_ecus" });
  }
  if (/测试覆盖率|coverage|test/i.test(lowerText)) {
    datasets.add("testing_coverage");
    resolved.push({ term: "测试覆盖率", mapsTo: "testing_coverage" });
  }
  if (/执行效率|发现率/.test(text)) {
    clarifications.push("执行效率/缺陷发现率需要先确认口径，例如按测试用例数、执行次数、人员维度或缺陷/执行比计算。");
  }

  return {
    query: text,
    datasets: Array.from(datasets),
    metrics: Array.from(new Set(metrics)),
    filters,
    resolved_terms: resolved,
    confidence: resolved.length ? (clarifications.length ? "medium" : "high") : "low",
    clarifications,
  };
}

function executeResolveBusinessTerms(toolCall) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const payload = resolveBusinessTerms(args.query);
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: "resolve_business_terms", result: payload })),
    contextText: [
      "# Main agent tool result",
      "Tool: resolve_business_terms",
      `Datasets: ${payload.datasets.join(", ") || "unknown"}`,
      `Metrics: ${payload.metrics.join(", ") || "unknown"}`,
      `Filters: ${JSON.stringify(payload.filters)}`,
      `Confidence: ${payload.confidence}`,
      payload.clarifications.length ? `Clarification needed: ${payload.clarifications.join(" ")}` : "",
      "Use these normalized terms to choose allowlisted analytics tools. Ask clarification when confidence is low or a clarification is listed.",
    ].filter(Boolean).join("\n"),
  };
}

function formatDashboardSummaryContext(url, payload) {
  const ticketCount = Number(payload?.overview?.ticket_count);
  const resultText = Number.isFinite(ticketCount)
    ? `Result: ${ticketCount} defects`
    : "Result: unavailable because overview.ticket_count is missing.";

  return [
    "# Main agent tool result",
    "Tool: query_dashboard_summary",
    `Source query: GET ${url}`,
    resultText,
    payload?.snapshot_version ? `Snapshot: ${payload.snapshot_version}` : "",
    "Use this tool result as factual dashboard data. Do not invent fields or metrics beyond the payload.",
  ].filter(Boolean).join("\n");
}

async function executeDashboardSummary(toolCall, { analyticsFetch, analyticsApiBase }) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const url = buildDashboardSummaryUrl(args.filters || {}, analyticsApiBase);
  const response = await analyticsFetch(url);
  if (!response?.ok) {
    const content = JSON.stringify({ error: `Analytics API request failed for query_dashboard_summary: ${response?.status || "unknown"}` });
    return {
      toolMessage: buildToolMessage(toolCall, content),
      contextText: `# Main agent tool result\nTool: query_dashboard_summary\nSource query: GET ${url}\nResult: unavailable because the analytics API request failed.`,
    };
  }

  const payload = await response.json();
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: "query_dashboard_summary", url, result: payload })),
    contextText: formatDashboardSummaryContext(url, payload),
  };
}

function formatCoverageProjectStatusContext(url, payload) {
  const rows = Array.isArray(payload) ? payload : [];
  return [
    "# Main agent tool result",
    "Tool: query_testing_coverage_project_status",
    `Source query: GET ${url}`,
    `Rows: ${rows.length}`,
    "Use these Testing Coverage project-status rows as factual dashboard data. Do not treat missing rows as zero coverage.",
  ].join("\n");
}

async function executeCoverageProjectStatus(toolCall, { analyticsFetch, analyticsApiBase }) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const url = buildCoverageProjectStatusUrl(args.filters || {}, analyticsApiBase);
  const response = await analyticsFetch(url);
  if (!response?.ok) {
    const content = JSON.stringify({ error: `Analytics API request failed for query_testing_coverage_project_status: ${response?.status || "unknown"}` });
    return {
      toolMessage: buildToolMessage(toolCall, content),
      contextText: `# Main agent tool result\nTool: query_testing_coverage_project_status\nSource query: GET ${url}\nResult: unavailable because the analytics API request failed.`,
    };
  }

  const payload = await response.json();
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: "query_testing_coverage_project_status", url, result: payload })),
    contextText: formatCoverageProjectStatusContext(url, payload),
  };
}

function formatTestCaseContext(url, payload) {
  const anchor = payload?.anchor || {};
  const defectContext = payload?.defect_context || {};
  const scope = payload?.business_scope || {};
  const summary = payload?.coverage_summary || {};
  const traceability = payload?.traceability || {};
  const features = Array.isArray(traceability.features) ? traceability.features : [];
  const stories = Array.isArray(traceability.stories) ? traceability.stories : [];
  const defects = Array.isArray(traceability.defects) ? traceability.defects : [];
  const gaps = Array.isArray(payload?.gaps) ? payload.gaps : [];
  const featureLines = features.slice(0, 5).map((feature) => `Feature: ${feature.name || feature.id}`);
  const storyLines = stories.slice(0, 5).map((story) => `Story: ${story.name || story.id}`);
  const defectLines = defects.slice(0, 5).map((defect) => `Linked defect: ${defect.id}${defect.name ? ` ${defect.name}` : ""}`);
  const gapLines = gaps.slice(0, 5).map((gap) => `Gap: ${gap.gap_type}${gap.description ? ` - ${gap.description}` : ""}`);
  const defectContextLines = [];
  if (defectContext.defect_id || defectContext.name) {
    defectContextLines.push(`Defect: ${defectContext.defect_id || "unknown"}${defectContext.name ? ` ${defectContext.name}` : ""}`);
  }
  if (defectContext.description) {
    defectContextLines.push(`Defect description: ${String(defectContext.description).slice(0, 800)}`);
  }
  if (defectContext.requirement) {
    defectContextLines.push(`Requirement: ${defectContext.requirement}`);
  }

  return [
    "# Main agent tool result",
    "Tool: get_test_case_context",
    `Source query: POST ${url}`,
    `Anchor: ${anchor.node_id || "unknown"}${anchor.label ? ` (${anchor.label})` : ""}`,
    `Scope: project ${scope.project || "unknown"}; release ${scope.release || "unknown"}; week ${scope.planned_week || "unknown"}; AIDA ${scope.aida || "unknown"}`,
    `Runs: ${Number(summary.latest_runs || 0)}; passed ${Number(summary.passed || 0)}; failed ${Number(summary.failed || 0)}; requires_attention ${Number(summary.requires_attention || 0)}; linked_defects ${Number(summary.linked_defects || 0)}`,
    ...defectContextLines,
    ...featureLines,
    ...storyLines,
    ...defectLines,
    ...gapLines,
    "Use this ontology context as factual background for testcase drafting. Missing data is unknown, not zero.",
  ].join("\n");
}

async function executeTestCaseContext(toolCall, { analyticsFetch, analyticsApiBase }) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const { url, response } = await postAnalyticsJson("/api/ontology/context", args, { analyticsFetch, analyticsApiBase });
  if (!response?.ok) {
    const content = JSON.stringify({ error: `Analytics API request failed for get_test_case_context: ${response?.status || "unknown"}` });
    return {
      toolMessage: buildToolMessage(toolCall, content),
      contextText: `# Main agent tool result\nTool: get_test_case_context\nSource query: POST ${url}\nResult: unavailable because the analytics API request failed.`,
    };
  }

  const payload = await response.json();
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: "get_test_case_context", url, result: payload })),
    contextText: formatTestCaseContext(url, payload),
  };
}

function formatDefectHighFrequencyContext(url, payload) {
  const rows = Array.isArray(payload?.frequency_rows) ? payload.frequency_rows : [];
  const overview = payload?.overview || {};
  const rowLines = rows.slice(0, 8).map((row, index) => {
    const moduleName = String(row.module || "未归类 ECU").trim();
    return `${index + 1}. ${moduleName}: ${Number(row.count || 0)} (${row.severity || "severity unknown"})`;
  });

  return [
    "# Main agent tool result",
    "Tool: query_defect_high_frequency_analysis",
    `Source query: GET ${url}`,
    `Total defects: ${Number(overview.total_count || 0)}`,
    `ECU/module count: ${Number(overview.module_count || 0)}`,
    `Repeat rate: ${Number(overview.repeat_rate || 0)}%`,
    `Critical defects: ${Number(overview.critical_count || 0)}`,
    rowLines.length ? "Top ECU/module frequency rows:" : "Top ECU/module frequency rows: none",
    ...rowLines,
    "This tool answers ECU/module concentration from octane_defects assigned_ecu and creation_time filters. It does not prove regression-commit causality by itself.",
  ].join("\n");
}

async function executeDefectHighFrequency(toolCall, { analyticsFetch, analyticsApiBase, now }) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const url = buildDefectHighFrequencyUrl({ filters: args.filters || {}, limit: args.limit }, analyticsApiBase, now);
  const response = await analyticsFetch(url);
  if (!response?.ok) {
    const content = JSON.stringify({ error: `Analytics API request failed for query_defect_high_frequency_analysis: ${response?.status || "unknown"}` });
    return {
      toolMessage: buildToolMessage(toolCall, content),
      contextText: `# Main agent tool result\nTool: query_defect_high_frequency_analysis\nSource query: GET ${url}\nResult: unavailable because the analytics API request failed.`,
    };
  }

  const payload = await response.json();
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: "query_defect_high_frequency_analysis", url, result: payload })),
    contextText: formatDefectHighFrequencyContext(url, payload),
  };
}

function formatDefectAggregateContext(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const metrics = Array.isArray(payload?.applied_query?.metrics) ? payload.applied_query.metrics : ["defect_count"];
  const dimensions = Array.isArray(payload?.applied_query?.dimensions) ? payload.applied_query.dimensions : [];
  const dimension = dimensions[0] || "scope";
  const rowLines = rows.slice(0, 8).map((row, index) => {
    const label = String(row[dimension] || row.business_module || row.assigned_ecu || row.project || "all_defects").trim();
    const metricText = metrics
      .map((metric) => `${metric} ${row[metric] ?? "N/A"}`)
      .join(", ");
    const drilldownRef = row.drilldown_ref ? `; drilldown_ref: ${row.drilldown_ref}` : "";
    return `${index + 1}. ${label}: ${metricText}${drilldownRef}`;
  });

  return [
    "# Main agent tool result",
    "Tool: query_defect_aggregate",
    `Snapshot: ${payload?.snapshot_version || "unknown"}`,
    `Query fingerprint: ${payload?.query_fingerprint || "unknown"}`,
    `Groups: ${Number(payload?.returned_groups || 0)} returned of ${Number(payload?.total_groups || 0)}${payload?.truncated ? " (truncated)" : ""}`,
    rowLines.length ? "Aggregate rows:" : "Aggregate rows: none",
    ...rowLines,
    Array.isArray(payload?.warnings) && payload.warnings.length ? `Warnings: ${payload.warnings.join(" | ")}` : "",
    "Use aggregate results for counts/rates. Use drilldown_ref with query_defect_records only for example tickets, not causality proof.",
  ].filter(Boolean).join("\n");
}

async function executeDefectAggregate(toolCall, { analyticsFetch, analyticsApiBase }) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const { url, response } = await postAnalyticsJson("/api/analytics/defects/aggregate", args, { analyticsFetch, analyticsApiBase });
  if (!response?.ok) {
    const content = JSON.stringify({ error: `Analytics API request failed for query_defect_aggregate: ${response?.status || "unknown"}` });
    return {
      toolMessage: buildToolMessage(toolCall, content),
      contextText: `# Main agent tool result\nTool: query_defect_aggregate\nSource query: POST ${url}\nResult: unavailable because the analytics API request failed.`,
    };
  }
  const payload = await response.json();
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: "query_defect_aggregate", url, result: payload })),
    contextText: formatDefectAggregateContext(payload),
  };
}

function formatDefectRecordsContext(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const rowLines = rows.slice(0, 8).map((row, index) => {
    const ticketId = String(row.ticket_id || "N/A").trim();
    const ticketName = String(row.ticket_name || "Untitled").replace(/\s+/g, " ").trim();
    return `${index + 1}. ${ticketId}: ${ticketName}`;
  });
  return [
    "# Main agent tool result",
    "Tool: query_defect_records",
    `Snapshot: ${payload?.snapshot_version || "unknown"}`,
    `Query fingerprint: ${payload?.query_fingerprint || "unknown"}`,
    `Rows: ${Number(payload?.returned_rows || 0)} returned of ${Number(payload?.total_rows || 0)}${payload?.truncated ? " (truncated)" : ""}`,
    rowLines.length ? "Example records:" : "Example records: none",
    ...rowLines,
    Array.isArray(payload?.warnings) && payload.warnings.length ? `Warnings: ${payload.warnings.join(" | ")}` : "",
  ].filter(Boolean).join("\n");
}

async function executeDefectRecords(toolCall, { analyticsFetch, analyticsApiBase }) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const { url, response } = await postAnalyticsJson("/api/analytics/defects/records", args, { analyticsFetch, analyticsApiBase });
  if (!response?.ok) {
    const content = JSON.stringify({ error: `Analytics API request failed for query_defect_records: ${response?.status || "unknown"}` });
    return {
      toolMessage: buildToolMessage(toolCall, content),
      contextText: `# Main agent tool result\nTool: query_defect_records\nSource query: POST ${url}\nResult: unavailable because the analytics API request failed.`,
    };
  }
  const payload = await response.json();
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: "query_defect_records", url, result: payload })),
    contextText: formatDefectRecordsContext(payload),
  };
}

function summarizeFullPicturePayload(payload) {
  if (Array.isArray(payload)) {
    return [`Rows: ${payload.length}`];
  }

  if (!payload || typeof payload !== "object") {
    return ["Result: non-object payload"];
  }

  const lines = [];
  if (payload.snapshot_version) {
    lines.push(`Snapshot: ${payload.snapshot_version}`);
  }
  if (payload.total_rows != null) {
    lines.push(`total_rows: ${payload.total_rows}`);
  }
  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: ${value.length} rows`);
    }
  }
  if (payload.overview && typeof payload.overview === "object") {
    lines.push(`overview: ${JSON.stringify(payload.overview).slice(0, 240)}`);
  }
  return lines.length ? lines : ["Result: object payload returned"];
}

async function executeFullPictureModule(toolCall, { analyticsFetch, analyticsApiBase, now }) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const resolved = buildFullPictureModuleUrl(args, analyticsApiBase, now);
  if (resolved.error) {
    const content = JSON.stringify({ error: resolved.error });
    return {
      toolMessage: buildToolMessage(toolCall, content),
      contextText: `# Main agent tool result\nTool: query_full_picture_module\nResult: ${resolved.error}`,
    };
  }

  const response = await analyticsFetch(resolved.url);
  if (!response?.ok) {
    const content = JSON.stringify({ error: `Analytics API request failed for query_full_picture_module: ${response?.status || "unknown"}` });
    return {
      toolMessage: buildToolMessage(toolCall, content),
      contextText: `# Main agent tool result\nTool: query_full_picture_module\nModule: ${resolved.moduleName}\nSource query: GET ${resolved.url}\nResult: unavailable because the analytics API request failed.`,
    };
  }

  const payload = await response.json();
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: "query_full_picture_module", module: resolved.moduleName, url: resolved.url, result: payload })),
    contextText: [
      "# Main agent tool result",
      "Tool: query_full_picture_module",
      `Module: ${resolved.moduleName}`,
      `Source query: GET ${resolved.url}`,
      ...summarizeFullPicturePayload(payload),
      "This is an allowlisted Full Picture module query, not arbitrary SQL.",
    ].join("\n"),
  };
}

function formatDuplicateSearchContext(payload) {
  const result = payload?.result || payload;
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  const rows = candidates.slice(0, 5).map((candidate, index) => {
    const title = String(candidate.name || "Untitled").replace(/\s+/g, " ").trim();
    const score = candidate.confidenceScore1to10 ?? candidate.score1to10 ?? "N/A";
    return `${index + 1}. Ticket ${candidate.ticketId || "N/A"}: ${title} (score ${score}/10)`;
  });

  return [
    "# Main agent tool result",
    "Tool: search_duplicates",
    `Candidate count: ${candidates.length}`,
    result?.modelPhase ? `Model phase: ${result.modelPhase}` : "",
    result?.feedbackCount != null ? `Feedback samples: ${result.feedbackCount}` : "",
    result?.dataset_size != null ? `Dataset size: ${result.dataset_size}` : "",
    rows.length ? "Top candidates:" : "Top candidates: none",
    ...rows,
    "Use duplicate-search results only for similarity/duplication reasoning; keep analytics counts separate.",
  ].filter(Boolean).join("\n");
}

async function executeDuplicateSearch(toolCall, { runDuplicateBridge, ensureDuplicateWarmup }) {
  if (typeof runDuplicateBridge !== "function") {
    const content = JSON.stringify({ error: "Duplicate bridge is not available" });
    return {
      toolMessage: buildToolMessage(toolCall, content),
      contextText: "# Main agent tool result\nTool: search_duplicates\nResult: unavailable because duplicate bridge is not configured.",
    };
  }

  const args = parseToolArguments(toolCall?.function?.arguments);
  const query = String(args.query || "").trim();
  const topK = Math.max(1, Math.min(10, Number(args.top_k || 5)));
  if (!query) {
    const content = JSON.stringify({ error: "search_duplicates requires query" });
    return {
      toolMessage: buildToolMessage(toolCall, content),
      contextText: "# Main agent tool result\nTool: search_duplicates\nResult: unavailable because query is empty.",
    };
  }

  if (typeof ensureDuplicateWarmup === "function") {
    await ensureDuplicateWarmup();
  }

  const payload = await runDuplicateBridge({
    action: "search",
    query,
    top_k: topK,
  });

  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: Boolean(payload?.success), tool: "search_duplicates", result: payload?.result || payload })),
    contextText: formatDuplicateSearchContext(payload),
  };
}

function executeAskClarification(toolCall) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const question = String(args.question || "").trim() || "请补充一个筛选条件后我再查询。";
  const reason = String(args.reason || "").trim();
  const options = Array.isArray(args.options)
    ? args.options.map((option) => String(option || "").trim()).filter(Boolean).slice(0, 6)
    : [];
  const payload = {
    question,
    ...(reason ? { reason } : {}),
    ...(options.length ? { options } : {}),
  };

  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify(payload)),
    contextText: [
      "# Main agent tool result",
      "Tool: ask_clarification",
      `Question: ${question}`,
      reason ? `Reason: ${reason}` : "",
      options.length ? `Options: ${options.join(" | ")}` : "",
      "Ask this question directly. Do not query analytics data until the user answers.",
    ].filter(Boolean).join("\n"),
    requiresUserInput: true,
  };
}

export async function executeMainAgentToolCall(toolCall, {
  analyticsFetch = globalThis.fetch,
  analyticsApiBase = DEFAULT_ANALYTICS_API_BASE,
  runDuplicateBridge,
  ensureDuplicateWarmup,
  actor,
  now,
} = {}) {
  const name = toolCall?.function?.name || "";
  try {
    if (name === "get_data_catalog") {
      return executeDataCatalog(toolCall);
    }
    if (name === "get_ontology_catalog") {
      return await executeOntologyCatalog(toolCall, { analyticsFetch, analyticsApiBase });
    }
    if (name === "search_octane_fields") {
      return await executeOctaneFieldSearch(toolCall, { analyticsFetch, analyticsApiBase });
    }
    if (name === "resolve_business_terms") {
      return executeResolveBusinessTerms(toolCall);
    }
    if (SEMANTIC_TOOL_NAMES.has(name)) {
      return await executeSemanticQuery(toolCall, { analyticsFetch, analyticsApiBase, actor });
    }
    if (name === "query_dashboard_summary") {
      return await executeDashboardSummary(toolCall, { analyticsFetch, analyticsApiBase });
    }
    if (name === "query_testing_coverage_project_status") {
      return await executeCoverageProjectStatus(toolCall, { analyticsFetch, analyticsApiBase });
    }
    if (name === "get_test_case_context") {
      return await executeTestCaseContext(toolCall, { analyticsFetch, analyticsApiBase });
    }
    if (name === "query_defect_high_frequency_analysis") {
      return await executeDefectHighFrequency(toolCall, { analyticsFetch, analyticsApiBase, now });
    }
    if (name === "query_defect_aggregate") {
      return await executeDefectAggregate(toolCall, { analyticsFetch, analyticsApiBase });
    }
    if (name === "query_defect_records") {
      return await executeDefectRecords(toolCall, { analyticsFetch, analyticsApiBase });
    }
    if (name === "query_full_picture_module") {
      return await executeFullPictureModule(toolCall, { analyticsFetch, analyticsApiBase, now });
    }
    if (name === "search_duplicates") {
      return await executeDuplicateSearch(toolCall, { runDuplicateBridge, ensureDuplicateWarmup });
    }
    if (name === "ask_clarification") {
      return executeAskClarification(toolCall);
    }
    const content = JSON.stringify({ error: `Unsupported tool: ${name}` });
    return {
      toolMessage: buildToolMessage(toolCall, content),
      contextText: `# Main agent tool result\nTool: ${name || "unknown"}\nResult: Unsupported tool: ${name}`,
    };
  } catch (error) {
    if (SEMANTIC_TOOL_NAMES.has(name)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const content = JSON.stringify({ error: message });
    return {
      toolMessage: buildToolMessage(toolCall, content),
      contextText: `# Main agent tool result\nTool: ${name}\nResult: failed: ${message}`,
    };
  }
}