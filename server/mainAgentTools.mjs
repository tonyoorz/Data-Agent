import { semanticQuerySchema } from "./ontology/queryCompiler.mjs";
import { resolveAnalyticsApiBase } from "./analyticsApiConfig.mjs";
import { boundDefaultAnalyticsFetch } from "./boundedAnalyticsFetch.mjs";
import { isOidcScopedActor } from "./agentAuth.mjs";
import {
  ACTOR_CAPABILITY_HEADER,
  createActorCapability,
} from "./agentActorCapability.mjs";
import { mainAgentToolDataBoundary } from "./mainAgentToolDataBoundary.mjs";

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
  "detected_by",
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

const COVERAGE_WEEK_RE = /^(\d{2}|\d{4})\s*-\s*(?:CW|W)\s*(\d{1,2})$/i;

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
  "detected_by",
  "outcome_flag",
];

const ANALYTICS_FILTER_VALUE_FIELDS = ["detected_by", "assigned_ecu", "business_module", "problem_finder_team"];

const DEFECT_FILTER_PROPERTIES = {
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
  detected_by: STRING_OR_STRING_ARRAY_SCHEMA,
  business_module: STRING_OR_STRING_ARRAY_SCHEMA,
  business_modules: STRING_OR_STRING_ARRAY_SCHEMA,
};

const ANALYTICS_QUERY_PROPERTIES = {
  dataset: { type: "string", enum: ["defects"], description: "Analytics dataset. Phase 1 supports defects." },
  intent: { type: "string", enum: ["aggregate", "trend", "rank"], description: "Question shape. Phase 1 executes these through defect aggregate semantics." },
  metrics: { type: "array", items: { type: "string", enum: DEFECT_METRIC_VALUES } },
  dimensions: { type: "array", items: { type: "string", enum: DEFECT_DIMENSION_VALUES }, maxItems: 1 },
  derived_metrics: { type: "array", items: { type: "string", enum: ["delta", "growth_pct"] } },
  filters: { type: "object", properties: DEFECT_FILTER_PROPERTIES, additionalProperties: false },
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
};

const FALLBACK_DATASET_VALUES = ["defects", "manual_runs"];
const FALLBACK_FIELD_VALUES = [
  "defect_id",
  "name",
  "status_phase",
  "problem_finder_team",
  "year",
  "assigned_ecu",
  "top_aida",
  "phase",
  "solution_cluster",
  "lead_model",
  "project",
  "pu",
  "market",
  "creation_time",
  "last_modified",
  "detected_by",
  "team",
  "mr_id",
  "test_id",
  "test_name",
  "status",
  "test_week",
  "fv",
  "fvp",
  "tester",
];

const FALLBACK_FILTER_PROPERTIES = Object.fromEntries(
  FALLBACK_FIELD_VALUES.map((field) => [field, STRING_OR_STRING_ARRAY_SCHEMA]),
);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const FULL_PICTURE_MODULE_ENDPOINTS = {
  dashboard_summary: "/api/full-picture/dashboard/summary",
  dashboard_tickets: "/api/full-picture/dashboard/tickets",
  top_issue_analysis: "/api/full-picture/top-issue-analysis",
  long_runner_analysis: "/api/full-picture/long-runner-analysis",
  defect_high_frequency_analysis: "/api/full-picture/defect-high-frequency-analysis",
};

const SEMANTIC_TOOL_NAMES = new Set(["query_semantic_metrics", "query_semantic_records", "query_traceability"]);
const SEMANTIC_RECORD_FIELD_VALUES = [
  "defect_id", "name", "creation_time", "status", "severity", "phase", "china_scope",
  "problem_finder_team", "project", "service_pack", "pu", "i_step", "os", "platform",
  "assigned_ecu", "model_series", "aida", "detected_by", "solution_cluster",
  "defect_category", "reporting_class", "problem_severity", "lead_model", "market", "year", "mr_id", "test_id", "test_name",
  "finished", "test_week", "tester", "team", "started", "release", "trace_status",
  "run_count", "scope_team", "scope_release",
];

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
      name: "search_analytics_filter_values",
      description: "Search canonical analytics filter values before executing defect queries. Use it to ground detected_by person names, assigned_ecu, business_module, and problem_finder_team values instead of guessing exact strings.",
      parameters: {
        type: "object",
        properties: {
          dataset: { type: "string", enum: ["defects"] },
          field: { type: "string", enum: ANALYTICS_FILTER_VALUE_FIELDS },
          query: { type: "string", description: "Partial value from the user question, such as Size, ECU-CAM, Camera, or DTSV." },
          filters: { type: "object", properties: DEFECT_FILTER_PROPERTIES, additionalProperties: false },
          limit: { type: "number", description: "Maximum candidate values to return, capped by the backend." },
        },
        required: ["dataset", "field", "query"],
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
      name: "query_analytics",
      description: "High-level analytics query tool. Use this first for defect counts, trends, rankings, and aggregate questions; it normalizes to the governed Analytics Query Kernel instead of choosing page endpoints directly.",
      parameters: {
        type: "object",
        required: ["dataset", "intent", "metrics", "dimensions", "filters", "time"],
        additionalProperties: false,
        properties: ANALYTICS_QUERY_PROPERTIES,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "diagnose_analytics_empty",
      description: "Diagnose empty or suspiciously small analytics results by replaying the same high-level query and relaxing one non-time filter at a time. Use before concluding that no data exists.",
      parameters: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: {
          query: {
            type: "object",
            required: ["dataset", "intent", "metrics", "dimensions", "filters", "time"],
            additionalProperties: false,
            properties: ANALYTICS_QUERY_PROPERTIES,
          },
          reason: { type: "string", description: "Why diagnosis is needed, for example query_analytics returned no rows." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_analytics_fallback",
      description: "Governed read-only analytics fallback for cases where specialized analytics tools are empty, unavailable, or too narrow. It accepts a structured query AST only, never raw SQL; the backend executes only allowlisted datasets and fields with a forced limit and audit metadata.",
      parameters: {
        type: "object",
        required: ["dataset", "metrics", "group_by", "filters"],
        additionalProperties: false,
        properties: {
          dataset: { type: "string", enum: FALLBACK_DATASET_VALUES },
          metrics: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: {
              type: "object",
              required: ["op", "field", "as"],
              additionalProperties: false,
              properties: {
                op: { type: "string", enum: ["count"] },
                field: { type: "string", enum: FALLBACK_FIELD_VALUES },
                as: { type: "string", enum: ["count", "row_count", "defect_count", "run_count"] },
              },
            },
          },
          group_by: {
            type: "array",
            maxItems: 2,
            items: { type: "string", enum: FALLBACK_FIELD_VALUES },
          },
          filters: {
            type: "object",
            properties: FALLBACK_FILTER_PROPERTIES,
            additionalProperties: false,
          },
          time: {
            type: "object",
            properties: {
              field: { type: "string", enum: ["creation_time", "last_modified"] },
              current: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
              timezone: { type: "string", enum: ["Asia/Shanghai"] },
            },
            required: ["field", "current", "timezone"],
            additionalProperties: false,
          },
          order_by: {
            type: "array",
            items: {
              type: "object",
              required: ["field", "direction"],
              additionalProperties: false,
              properties: {
                field: { type: "string" },
                direction: { type: "string", enum: ["asc", "desc"] },
              },
            },
          },
          limit: { type: "number", description: "Maximum rows, capped by the backend." },
          reason: { type: "string", description: "Why fallback is needed, for audit and later routing improvements." },
        },
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
      description: "Return governed raw records. For a drilldown, reuse analysis_ref from a prior semantic metric result and narrow it with selections; never reconstruct or widen the original scope.",
      parameters: {
        type: "object",
        required: ["ontology_version", "schema_fingerprint", "query", "analysis_ref", "selections", "fields", "page", "page_size"],
        additionalProperties: false,
        properties: {
          ontology_version: { type: "string", minLength: 1 },
          schema_fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
          query: { anyOf: [semanticQuerySchema, { type: "null" }] },
          analysis_ref: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
          selections: {
            type: "array",
            items: {
              type: "object",
              required: ["dimensionId", "operator", "values"],
              additionalProperties: false,
              properties: {
                dimensionId: { type: "string", minLength: 1 },
                operator: { enum: ["in", "eq"] },
                values: { type: "array", minItems: 1, items: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] } },
              },
            },
          },
          fields: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: { type: "string", enum: SEMANTIC_RECORD_FIELD_VALUES } },
          page: { type: "integer", minimum: 1 },
          page_size: { type: "integer", minimum: 1, maximum: 200 },
        },
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
              detected_by: STRING_OR_STRING_ARRAY_SCHEMA,
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
      name: "query_testing_coverage_aida_status",
      description: "Query Testing Coverage AIDA-status rows through the analytics API using safe coverage filters. Use for manual-run pass-rate or coverage questions grouped by AIDA.",
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
      name: "query_testing_team_fv_analysis",
      description: "Compare one organization team's internal manual-testing groups by FV. Use this for DTSV internal test-group comparisons; it returns each FV's executions, passed executions, distinct linked defects, pass rate, and defect discovery rate.",
      parameters: {
        type: "object",
        properties: {
          team: { type: "string", description: "Exact organization team scope, for example DTSV_China." },
          years: STRING_OR_STRING_ARRAY_SCHEMA,
          test_weeks: STRING_OR_STRING_ARRAY_SCHEMA,
        },
        required: ["team"],
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
              detected_by: STRING_OR_STRING_ARRAY_SCHEMA,
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
              detected_by: STRING_OR_STRING_ARRAY_SCHEMA,
              business_module: STRING_OR_STRING_ARRAY_SCHEMA,
              business_modules: STRING_OR_STRING_ARRAY_SCHEMA,
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
              detected_by: STRING_OR_STRING_ARRAY_SCHEMA,
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

function buildCoverageAidaStatusUrl(filters, analyticsApiBase) {
  const url = new URL("/api/testing/coverage-analysis/aida-status", analyticsApiBase);
  for (const [key, value] of Object.entries(filters || {})) {
    if (!COVERAGE_FILTER_KEYS.has(key)) {
      continue;
    }
    appendFilterValue(url.searchParams, key, value);
  }
  return url.toString();
}

function normalizeCoverageWeek(value) {
  const rawValue = String(value || "").trim();
  const match = rawValue.match(COVERAGE_WEEK_RE);
  if (!match) {
    return rawValue;
  }
  const yearValue = Number(match[1]);
  const year = yearValue < 100 ? 2000 + yearValue : yearValue;
  return `${String(year).padStart(4, "0")}-CW${String(Number(match[2])).padStart(2, "0")}`;
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

function normalizeAnalyticsQuery(rawQuery) {
  const query = rawQuery && typeof rawQuery === "object" ? rawQuery : {};
  const dataset = String(query.dataset || "defects").trim();
  if (dataset !== "defects") {
    throw new Error(`Unsupported analytics dataset: ${dataset || "unknown"}`);
  }
  return {
    dataset,
    intent: String(query.intent || "aggregate").trim() || "aggregate",
    metrics: Array.isArray(query.metrics) && query.metrics.length ? query.metrics.map(String) : ["defect_count"],
    dimensions: Array.isArray(query.dimensions) ? query.dimensions.map(String) : [],
    derived_metrics: Array.isArray(query.derived_metrics) ? query.derived_metrics.map(String) : [],
    filters: query.filters && typeof query.filters === "object" ? query.filters : {},
    time: query.time && typeof query.time === "object" ? query.time : {},
    order_by: Array.isArray(query.order_by) ? query.order_by : undefined,
    min_baseline_count: query.min_baseline_count,
    limit: query.limit,
  };
}

function buildDefectAggregatePayloadFromAnalyticsQuery(rawQuery) {
  const query = normalizeAnalyticsQuery(rawQuery);
  return Object.fromEntries(Object.entries({
    metrics: query.metrics,
    dimensions: query.dimensions,
    derived_metrics: query.derived_metrics.length ? query.derived_metrics : undefined,
    filters: query.filters,
    time: query.time,
    order_by: query.order_by,
    min_baseline_count: query.min_baseline_count,
    limit: query.limit,
  }).filter(([, value]) => value !== undefined));
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

function createAgentAnalyticsHeaders({
  actor,
  actorCapabilitySecret,
  actorCapabilityNow,
  actorCapabilityNonce,
  actorCapabilityEnv,
} = {}) {
  const capabilityOptions = {};
  if (actorCapabilitySecret !== undefined) capabilityOptions.secret = actorCapabilitySecret;
  if (actorCapabilityNow !== undefined) capabilityOptions.now = actorCapabilityNow;
  if (actorCapabilityNonce !== undefined) capabilityOptions.nonce = actorCapabilityNonce;
  if (actorCapabilityEnv !== undefined) capabilityOptions.env = actorCapabilityEnv;
  return {
    "Content-Type": "application/json",
    [ACTOR_CAPABILITY_HEADER]: createActorCapability(actor, capabilityOptions),
  };
}

async function postAgentAnalyticsJson(path, payload, dependencies = {}) {
  const url = new URL(path, dependencies.analyticsApiBase).toString();
  const response = await dependencies.analyticsFetch(url, {
    method: "POST",
    headers: createAgentAnalyticsHeaders(dependencies),
    body: JSON.stringify(payload),
  });
  return { url, response };
}

async function sanitizedHttpFailure(response) {
  let body = {};
  try {
    body = await response?.json();
  } catch {
    body = {};
  }
  const rawCode = typeof body?.code === "string" ? body.code.trim() : "";
  const code = /^[A-Z][A-Z0-9_]{2,127}$/.test(rawCode) ? rawCode : "HTTP_REQUEST_FAILED";
  return {
    statusCode: Number(response?.status || 0) || 502,
    code,
    retryable: response?.status === 408 || response?.status === 429 || Number(response?.status || 0) >= 500,
  };
}

function failedToolResult(toolCall, toolName, failure, contextText) {
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: false, tool: toolName, failure })),
    contextText,
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
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const rows = data.length;
  const rowLines = data.slice(0, 20).map((row) => JSON.stringify(row));
  const lineagePath = Array.isArray(payload?.lineage?.path) ? payload.lineage.path : [];
  const lineageText = lineagePath.map((relationship) => {
    const id = String(relationship?.id || "unknown");
    const source = String(relationship?.sourceEntity || "unknown");
    const target = String(relationship?.targetEntity || "unknown");
    const cardinality = String(relationship?.cardinality || "unknown");
    return `${id} (${source} -> ${target}; ${cardinality})`;
  }).join(" | ");
  const lineageRelationshipIds = Array.isArray(payload?.lineage?.evidence?.relationshipIds)
    ? payload.lineage.evidence.relationshipIds.map(String).join(", ")
    : "";
  const lineageRowCount = Number(payload?.lineage?.evidence?.rowCount);
  return [
    "# Main agent semantic tool result",
    `Tool: ${name}`,
    `Ontology: ${payload?.ontologyVersion || "unknown"} (${payload?.schemaFingerprint || "no fingerprint"})`,
    `Analysis ref: ${payload?.analysisRef || "unavailable"}`,
    `Source revision: ${payload?.sourceRevision?.revisionId || "unpinned"}`,
    `Revision status: ${payload?.sourceRevision?.status || "unknown"}`,
    `Rows: ${rows}`,
    ...(payload?.pagination ? [`Pagination: page ${payload.pagination.page}/${payload.pagination.totalPages}, total ${payload.pagination.totalRows}`] : []),
    ...metricLines,
    ...rowLines,
    ...(lineageText ? [`Lineage path: ${lineageText}`] : []),
    ...(lineageRelationshipIds ? [`Lineage evidence: ${Number.isFinite(lineageRowCount) ? lineageRowCount : rows} rows; relationships ${lineageRelationshipIds}`] : []),
    `Evidence: ${payload?.evidence?.kind || "unavailable"}`,
    `Business rules: ${(payload?.businessRules?.applied || []).join(", ") || "none"}`,
    `Completeness: ${payload?.quality?.completeness || "unknown"}`,
    `Warnings: ${(payload?.quality?.warnings || []).join(", ") || "none"}`,
    "Use only the returned governed metrics or records, scope, source revision, analysis ref, and evidence envelope as factual evidence.",
  ].join("\n");
}

async function executeSemanticQuery(toolCall, dependencies) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const query = args.query;
  const body = {
    schemaVersion: "1.0",
    queryId: String(toolCall?.id || `semantic-${Date.now()}`),
    ontologyVersion: query?.ontologyVersion,
    schemaFingerprint: query?.schemaFingerprint,
    query,
  };
  const { response } = await postAgentAnalyticsJson("/api/semantic/query", body, dependencies);
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

async function executeSemanticRecords(toolCall, dependencies) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const query = args.query && typeof args.query === "object" ? args.query : null;
  const body = {
    schemaVersion: "1.0",
    queryId: String(toolCall?.id || `semantic-records-${Date.now()}`),
    ontologyVersion: String(args.ontology_version || query?.ontologyVersion || ""),
    schemaFingerprint: String(args.schema_fingerprint || query?.schemaFingerprint || ""),
    query,
    analysisRef: args.analysis_ref == null ? null : String(args.analysis_ref),
    selections: Array.isArray(args.selections) ? args.selections : [],
    fields: Array.isArray(args.fields) ? args.fields.map(String) : [],
    page: Number(args.page || 1),
    pageSize: Number(args.page_size || 20),
  };
  const { response } = await postAgentAnalyticsJson("/api/semantic/records", body, dependencies);
  if (!response?.ok) {
    let failure = {};
    try {
      failure = await response.json();
    } catch {
      failure = {};
    }
    const code = String(failure?.code || `SEMANTIC_RECORDS_API_HTTP_${response?.status || "UNKNOWN"}`);
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
        metrics: ["run_count", "status_count", "testcase_count", "coverage_rate", "pass_rate", "execution_rate"],
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
      "测试执行覆盖率": { dataset: "testing_coverage", metric: "coverage_rate" },
      "manual-run": { dataset: "testing_coverage" },
      "通过率": { dataset: "testing_coverage", metric: "pass_rate" },
      "执行率": { dataset: "testing_coverage", metric: "execution_rate" },
      "测试小组": { dataset: "testing_coverage", dimension: "fv", tool: "query_testing_team_fv_analysis" },
    },
    guardrails: [
      "Use only listed filters, dimensions, and modules.",
      "Use query_analytics for flexible defect analysis, then query_defect_records only for examples from a returned drilldown_ref.",
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
    `Source query: POST ${url}`,
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

function formatAnalyticsFilterValueSearchContext(url, payload) {
  const values = Array.isArray(payload?.values) ? payload.values : [];
  const rows = values.slice(0, 12).map((item, index) => `${index + 1}. ${item.value || "unknown"}: ${Number(item.count || 0)}`);
  const field = payload?.field || "unknown";
  const query = payload?.query || "";
  return [
    "# Main agent tool result",
    "Tool: search_analytics_filter_values",
    `Source query: POST ${url}`,
    `Dataset: ${payload?.dataset || "unknown"}; snapshot: ${payload?.snapshot_version || "unknown"}`,
    `${field} candidates${query ? ` for ${query}` : ""}: ${Number(payload?.returned_values || 0)} returned of ${Number(payload?.total_values || 0)}`,
    rows.length ? "Candidate values:" : "Candidate values: none",
    ...rows,
    "Use these exact values for analytics filters. If no candidate matches, ask a focused clarification instead of guessing.",
  ].join("\n");
}

async function executeAnalyticsFilterValueSearch(toolCall, { analyticsFetch, analyticsApiBase }) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const payload = {
    dataset: String(args.dataset || "defects"),
    field: String(args.field || ""),
    query: String(args.query || ""),
    ...(args.filters && typeof args.filters === "object" ? { filters: args.filters } : {}),
    ...(args.limit ? { limit: Number(args.limit) } : {}),
  };
  const { url, response } = await postAnalyticsJson("/api/analytics/filter-values/search", payload, { analyticsFetch, analyticsApiBase });
  if (!response?.ok) {
    const content = JSON.stringify({ error: `Analytics API request failed for search_analytics_filter_values: ${response?.status || "unknown"}` });
    return {
      toolMessage: buildToolMessage(toolCall, content),
      contextText: `# Main agent tool result\nTool: search_analytics_filter_values\nSource query: POST ${url}\nResult: unavailable because the analytics value search API request failed.`,
    };
  }

  const result = await response.json();
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: "search_analytics_filter_values", url, result })),
    contextText: formatAnalyticsFilterValueSearchContext(url, result),
  };
}

const PERSON_FILTER_STOP_WORDS = new Set(["dtsv", "qgate", "octane", "defect", "defects", "ticket", "tickets"]);

function normalizePersonName(rawName, { allowSingleToken = false } = {}) {
  const tokens = String(rawName || "")
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^[^A-Za-z]+|[^A-Za-z.'-]+$/g, ""))
    .filter(Boolean);
  const nameTokens = [];
  for (const token of tokens) {
    const normalized = token.toLowerCase();
    if (PERSON_FILTER_STOP_WORDS.has(normalized) || /^[A-Z0-9_]{3,}$/.test(token)) {
      break;
    }
    nameTokens.push(token);
  }
  if (nameTokens.length < (allowSingleToken ? 1 : 2)) {
    return "";
  }
  return nameTokens
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join(" ");
}

export function extractDetectedByName(text) {
  const labeledName = String(text || "").match(/(?:人名|姓名|name)\s*[:：]?\s+([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){1,5})/i);
  const personLabelName = normalizePersonName(labeledName?.[1]);
  if (personLabelName) {
    return personLabelName;
  }

  const explicit = String(text || "").match(/\b(?:tester|detected\s*by|finder|reported\s*by|reporter|author)\s*[:：]?\s+([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,5})/i);
  const explicitName = normalizePersonName(explicit?.[1]);
  if (explicitName) {
    return explicitName;
  }

  const beforeTicketVerb = String(text || "").match(/\b([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){1,3})\s*(?:提了|提票|报票|提交|新增|创建|缺陷)/i);
  const fullName = normalizePersonName(beforeTicketVerb?.[1]);
  if (fullName) {
    return fullName;
  }

  const accountBeforeTicketVerb = String(text || "").match(/\b([A-Za-z][A-Za-z0-9._'-]{1,63})\s*(?:提了|提票|报票|提交|新增|创建|缺陷)/i);
  return normalizePersonName(accountBeforeTicketVerb?.[1], { allowSingleToken: true });
}

export function isDefectReporterTicketQuery(text) {
  return Boolean(extractDetectedByName(text))
    && /提了|提票|报票|提交|新增|新建|创建|opened|created|raised|submitted/i.test(String(text || ""));
}

function resolveBusinessTerms(query) {
  const text = String(query || "");
  const lowerText = text.toLowerCase();
  const resolved = [];
  const filters = {};
  const metrics = [];
  const datasets = new Set();
  const clarifications = [];
  const isTestingCoverageQuery = /测试.*覆盖率|覆盖率|manual[-\s]?run|通过率|执行率|执行效率|缺陷发现率|测试小组|coverage|pass\s*rate|execution\s*rate|\btest\b/i.test(lowerText);
  const isTestingTeamFvQuery = isTestingCoverageQuery && /测试小组|内部.*(?:小组|团队)|各(?:测试)?小组|\bfv\b/i.test(text);

  if (/dtsv/i.test(text)) {
    if (isTestingTeamFvQuery) {
      resolved.push({ term: "DTSV", mapsTo: "testing team scope with fv groups", value: "DTSV_China" });
    } else {
      filters.problem_finder_teams = ["DTSV_China"];
      resolved.push({ term: "DTSV", mapsTo: "problem_finder_teams", value: "DTSV_China" });
    }
  }
  if (/最近一周|last\s*7\s*days|recent\s*week/i.test(text)) {
    filters.recent_days = 7;
    resolved.push({ term: "最近一周", mapsTo: "recent_days", value: 7 });
  }
  if (/新增|新建|创建|提交|提了|提票|opened|created|raised|submitted|ticket/i.test(text)) {
    datasets.add("defects");
    metrics.push("defect_count");
    resolved.push({ term: "新增/创建/提交", mapsTo: "defect_count filtered by octane_defects.creation_time" });
  }
  const detectedByName = extractDetectedByName(text);
  if (detectedByName) {
    datasets.add("defects");
    filters.detected_by = [detectedByName];
    resolved.push({ term: "tester/提票人", mapsTo: "detected_by", value: detectedByName });
  }
  if (/ecu|模块/i.test(text) && !isTestingCoverageQuery) {
    datasets.add("defects");
    resolved.push({ term: "ECU/模块", mapsTo: "assigned_ecus" });
  }
  if (/ecu|模块/i.test(text) && isTestingCoverageQuery) {
    resolved.push({ term: "ECU/模块", mapsTo: "testing_coverage project-status dimensions fv/fvp" });
  }
  if (isTestingCoverageQuery) {
    datasets.add("testing_coverage");
    resolved.push({ term: "测试覆盖率", mapsTo: "testing_coverage" });
    if (isTestingTeamFvQuery) {
      metrics.push("pass_rate", "defect_discovery_rate");
      resolved.push({ term: "内部测试小组", mapsTo: "query_testing_team_fv_analysis grouped by fv" });
    }
    if (/通过率|pass\s*rate/i.test(lowerText)) {
      metrics.push("pass_rate");
    }
    if (/执行率|execution\s*rate/i.test(lowerText)) {
      metrics.push("execution_rate");
    }
    if (/覆盖率|coverage/i.test(lowerText) || !metrics.length) {
      metrics.push("coverage_rate");
    }
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

function formatCoverageAidaStatusContext(url, payload) {
  const rows = Array.isArray(payload) ? payload : [];
  return [
    "# Main agent tool result",
    "Tool: query_testing_coverage_aida_status",
    `Source query: GET ${url}`,
    `Rows: ${rows.length}`,
    "Rows are grouped by test_week, top_aida, status, and count. To compute pass rate, divide Passed count by total count per top_aida. Do not treat missing rows as zero coverage.",
  ].join("\n");
}

function formatTestingTeamFvAnalysisContext(url, payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const rowLines = rows.slice(0, 20).map((row) => (
    `FV ${row?.fv || "unknown"}: executions=${Number(row?.total_runs || 0)}, passed=${Number(row?.passed_runs || 0)}, linked_defects=${Number(row?.linked_defects || 0)}, pass_rate=${Number(row?.pass_rate || 0)}%, defect_discovery_rate=${Number(row?.defect_discovery_rate || 0)}%`
  ));
  return [
    "# Main agent tool result",
    "Tool: query_testing_team_fv_analysis",
    `Source query: GET ${url}`,
    `Team: ${payload?.team || "unknown"}`,
    `Group dimension: ${payload?.group_by || "fv"}`,
    `Test weeks: ${(Array.isArray(payload?.test_weeks) ? payload.test_weeks.join(", ") : "all") || "all"}`,
    `Rows: ${rows.length}`,
    ...rowLines,
    "Each row is one FV-based internal test group. pass_rate and defect_discovery_rate are percentages; do not replace FV with tester or the organization team.",
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

async function executeCoverageAidaStatus(toolCall, { analyticsFetch, analyticsApiBase }) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const url = buildCoverageAidaStatusUrl(args.filters || {}, analyticsApiBase);
  const response = await analyticsFetch(url);
  if (!response?.ok) {
    const content = JSON.stringify({ error: `Analytics API request failed for query_testing_coverage_aida_status: ${response?.status || "unknown"}` });
    return {
      toolMessage: buildToolMessage(toolCall, content),
      contextText: `# Main agent tool result\nTool: query_testing_coverage_aida_status\nSource query: GET ${url}\nResult: unavailable because the analytics API request failed.`,
    };
  }

  const payload = await response.json();
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: "query_testing_coverage_aida_status", url, result: payload })),
    contextText: formatCoverageAidaStatusContext(url, payload),
  };
}

async function executeTestingTeamFvAnalysis(toolCall, dependencies) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const team = String(args.team || "").trim();
  if (!team) {
    const content = JSON.stringify({ error: "query_testing_team_fv_analysis requires team" });
    return {
      toolMessage: buildToolMessage(toolCall, content),
      contextText: "# Main agent tool result\nTool: query_testing_team_fv_analysis\nResult: unavailable because team is required.",
    };
  }
  const requestPayload = {
    team,
    ...(args.years == null ? {} : { years: (Array.isArray(args.years) ? args.years : [args.years]).map(String).map((value) => value.trim()).filter(Boolean) }),
    ...(args.test_weeks == null ? {} : { test_weeks: (Array.isArray(args.test_weeks) ? args.test_weeks : [args.test_weeks]).map(normalizeCoverageWeek).filter(Boolean) }),
  };
  const { url, response } = await postAgentAnalyticsJson(
    "/api/agent/analytics/testing/team-fv-analysis",
    requestPayload,
    dependencies,
  );
  if (!response?.ok) {
    const content = JSON.stringify({ error: `Analytics API request failed for query_testing_team_fv_analysis: ${response?.status || "unknown"}` });
    return {
      toolMessage: buildToolMessage(toolCall, content),
      contextText: `# Main agent tool result\nTool: query_testing_team_fv_analysis\nSource query: POST ${url}\nResult: unavailable because the analytics API request failed.`,
    };
  }
  const resultPayload = await response.json();
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: "query_testing_team_fv_analysis", url, result: resultPayload })),
    contextText: formatTestingTeamFvAnalysisContext(url, resultPayload),
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

function formatDefectAggregateContext(payload, { toolName = "query_defect_aggregate" } = {}) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const metrics = Array.isArray(payload?.applied_query?.metrics) ? payload.applied_query.metrics : ["defect_count"];
  const derivedMetrics = Array.isArray(payload?.applied_query?.derived_metrics) ? payload.applied_query.derived_metrics : [];
  const dimensions = Array.isArray(payload?.applied_query?.dimensions) ? payload.applied_query.dimensions : [];
  const dimension = dimensions[0] || "scope";
  const rowLines = rows.slice(0, 8).map((row, index) => {
    const label = String(row[dimension] || row.business_module || row.assigned_ecu || row.project || "all_defects").trim();
    const comparisonText = [];
    if (derivedMetrics.length) {
      comparisonText.push(`current_count ${row.current_count ?? "N/A"}`);
      comparisonText.push(`previous_count ${row.previous_count ?? "N/A"}`);
    }
    if (derivedMetrics.includes("delta")) {
      comparisonText.push(`delta ${row.delta ?? "N/A"}`);
    }
    if (derivedMetrics.includes("growth_pct")) {
      const growthValue = row.growth_pct === null && row.is_new === true
        ? "new_group"
        : row.growth_pct === null || row.growth_pct === undefined
          ? "N/A"
          : `${row.growth_pct}%`;
      comparisonText.push(`growth_pct ${growthValue}`);
    }
    if (row.is_new === true) {
      comparisonText.push("is_new true");
    }
    const metricText = [...metrics
      .map((metric) => `${metric} ${row[metric] ?? "N/A"}`)
      , ...comparisonText].join(", ");
    const drilldownRef = row.drilldown_ref ? `; drilldown_ref: ${row.drilldown_ref}` : "";
    return `${index + 1}. ${label}: ${metricText}${drilldownRef}`;
  });

  return [
    "# Main agent tool result",
    `Tool: ${toolName}`,
    `Snapshot: ${payload?.snapshot_version || "unknown"}`,
    `Query fingerprint: ${payload?.query_fingerprint || "unknown"}`,
    `Groups: ${Number(payload?.returned_groups || 0)} returned of ${Number(payload?.total_groups || 0)}${payload?.truncated ? " (truncated)" : ""}`,
    rowLines.length ? "Aggregate rows:" : "Aggregate rows: none",
    ...rowLines,
    Array.isArray(payload?.warnings) && payload.warnings.length ? `Warnings: ${payload.warnings.join(" | ")}` : "",
    "Use aggregate results for counts/rates. Use drilldown_ref with query_defect_records only for example tickets, not causality proof.",
  ].filter(Boolean).join("\n");
}

async function executeQueryAnalytics(toolCall, dependencies) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const requestPayload = buildDefectAggregatePayloadFromAnalyticsQuery(args);
  const { url, response } = await postAgentAnalyticsJson("/api/agent/analytics/defects/aggregate", requestPayload, dependencies);
  if (!response?.ok) {
    return failedToolResult(
      toolCall,
      "query_analytics",
      await sanitizedHttpFailure(response),
      `# Main agent tool result\nTool: query_analytics\nSource query: POST ${url}\nResult: unavailable because the analytics API request failed.`,
    );
  }
  const payload = await response.json();
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: "query_analytics", url, request: requestPayload, result: payload })),
    contextText: [
      formatDefectAggregateContext(payload, { toolName: "query_analytics" }),
      "This high-level tool executed through the governed defect aggregate API. If rows are empty or unexpectedly small, call diagnose_analytics_empty before answering no data.",
    ].join("\n"),
  };
}

async function executeDefectAggregate(toolCall, dependencies) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const { url, response } = await postAgentAnalyticsJson("/api/agent/analytics/defects/aggregate", args, dependencies);
  if (!response?.ok) {
    return failedToolResult(
      toolCall,
      "query_defect_aggregate",
      await sanitizedHttpFailure(response),
      `# Main agent tool result\nTool: query_defect_aggregate\nSource query: POST ${url}\nResult: unavailable because the analytics API request failed.`,
    );
  }
  const payload = await response.json();
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: "query_defect_aggregate", url, result: payload })),
    contextText: formatDefectAggregateContext(payload),
  };
}

function aggregateDefectCount(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  return rows.reduce((total, row) => total + Number(row?.defect_count || 0), 0);
}

const STABLE_DIAGNOSIS_FILTER_KEYS = new Set(["years", "months"]);
const COMMON_CHINESE_SURNAME_TOKENS = new Set([
  "chen", "cai", "deng", "dong", "feng", "gao", "guo", "han", "he", "huang", "li", "lin", "luo", "ma", "qiao", "song", "tang", "wang", "wu", "xie", "xu", "yang", "zhang", "zhao", "zhou",
]);

async function executeDiagnosisProbe({ label, query, ...dependencies }) {
  const requestPayload = buildDefectAggregatePayloadFromAnalyticsQuery(query);
  const { url, response } = await postAgentAnalyticsJson("/api/agent/analytics/defects/aggregate", requestPayload, dependencies);
  if (!response?.ok) {
    return {
      label,
      url,
      ok: false,
      status: response?.status || "unknown",
      filters: requestPayload.filters || {},
      defect_count: null,
    };
  }
  const payload = await response.json();
  return {
    label,
    url,
    ok: true,
    filters: requestPayload.filters || {},
    defect_count: aggregateDefectCount(payload),
    snapshot_version: payload?.snapshot_version || "unknown",
    returned_groups: Number(payload?.returned_groups || 0),
  };
}

function buildDiagnosisRecommendation(probes) {
  const original = probes[0];
  const originalCount = Number(original?.defect_count || 0);
  const improved = probes.slice(1).find((probe) => Number(probe.defect_count || 0) > originalCount);
  if (!improved) {
    return "No single relaxed filter recovered data; verify the time window, data refresh, and whether the selected dataset supports the requested entity.";
  }
  if (improved.alias_filter === "detected_by" && improved.alias_value) {
    return `Try detected_by=${improved.alias_value}; the person name may be stored in Octane as given-name-first while the user typed surname-first.`;
  }
  const relaxedKey = String(improved.relaxed_filter || "filter");
  return `${relaxedKey} may be too restrictive or mapped to the wrong field; verify the exact value or ask the user to choose from available values before concluding no data.`;
}

function buildStructuredDiagnosis({ probes, baseQuery }) {
  const original = probes[0];
  const originalCount = Number(original?.defect_count || 0);
  const improved = probes.slice(1).find((probe) => Number(probe.defect_count || 0) > originalCount);
  if (!improved) {
    return {
      causeCode: "NO_SINGLE_FILTER_RECOVERY",
      retryQuery: null,
      candidateValues: [],
      recommendedClarification: "Verify the time window, data refresh, and whether this dataset supports the requested entity.",
    };
  }

  if (improved.alias_filter === "detected_by" && improved.alias_value) {
    return {
      causeCode: "FILTER_VALUE_ALIAS",
      retryQuery: { ...baseQuery, filters: improved.filters || {} },
      candidateValues: [{ field: "detected_by", value: improved.alias_value, count: Number(improved.defect_count || 0) }],
      recommendedClarification: `Use detected_by=${improved.alias_value} if that is the intended person.`,
    };
  }

  const relaxedFilter = String(improved.relaxed_filter || "filter");
  return {
    causeCode: "FILTER_TOO_RESTRICTIVE",
    retryQuery: { ...baseQuery, filters: improved.filters || {} },
    candidateValues: [],
    recommendedClarification: `Verify the exact ${relaxedFilter} value or choose from available values.`,
  };
}

function formatDiagnosisContext(payload) {
  const probes = Array.isArray(payload?.probes) ? payload.probes : [];
  const lines = probes.map((probe, index) => `${index + 1}. ${probe.label}: defect_count ${probe.defect_count ?? "unavailable"}`);
  return [
    "# Main agent tool result",
    "Tool: diagnose_analytics_empty",
    payload?.reason ? `Reason: ${payload.reason}` : "Reason: empty or suspicious analytics result",
    `Cause: ${payload?.causeCode || "UNKNOWN"}`,
    lines.length ? "Diagnosis probes:" : "Diagnosis probes: none",
    ...lines,
    `Recommendation: ${payload?.recommendation || "No recommendation available."}`,
    "Use this diagnosis to retry with corrected filters, ask a focused clarification, or state the data limitation with evidence.",
  ].join("\n");
}

async function executeDiagnoseAnalyticsEmpty(toolCall, dependencies) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const baseQuery = normalizeAnalyticsQuery(args.query || args);
  const baseFilters = baseQuery.filters && typeof baseQuery.filters === "object" ? baseQuery.filters : {};
  const detectedByAliases = buildDetectedByAliasFilters(baseFilters);
  const removableFilterKeys = Object.keys(baseFilters)
    .filter((key) => !STABLE_DIAGNOSIS_FILTER_KEYS.has(key))
    .slice(0, 6);
  const probes = [];
  probes.push(await executeDiagnosisProbe({ label: "original", query: baseQuery, ...dependencies }));
  for (const aliasProbe of detectedByAliases) {
    probes.push({
      ...(await executeDiagnosisProbe({
        label: `detected_by alias ${aliasProbe.alias}`,
        query: { ...baseQuery, filters: aliasProbe.filters },
        ...dependencies,
      })),
      alias_filter: "detected_by",
      alias_value: aliasProbe.alias,
    });
  }
  for (const filterKey of removableFilterKeys) {
    const relaxedFilters = { ...baseFilters };
    delete relaxedFilters[filterKey];
    probes.push({
      ...(await executeDiagnosisProbe({
        label: `without ${filterKey}`,
        query: { ...baseQuery, filters: relaxedFilters },
        ...dependencies,
      })),
      relaxed_filter: filterKey,
    });
  }
  const payload = {
    reason: String(args.reason || "").trim(),
    query: baseQuery,
    probes,
    ...buildStructuredDiagnosis({ probes, baseQuery }),
    recommendation: buildDiagnosisRecommendation(probes),
  };
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: "diagnose_analytics_empty", result: payload })),
    contextText: formatDiagnosisContext(payload),
  };
}

function formatAnalyticsFallbackContext(url, payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const columns = Array.isArray(payload?.columns) ? payload.columns.map(String) : [];
  const metricColumns = columns.filter((column) => /count|rate|total|rows/i.test(column));
  const labelColumns = columns.filter((column) => !metricColumns.includes(column));
  const rowLines = rows.slice(0, 8).map((row, index) => {
    const label = labelColumns.map((column) => String(row?.[column] ?? "").trim()).filter(Boolean).join(" / ") || "all_rows";
    const metricText = (metricColumns.length ? metricColumns : columns)
      .map((column) => `${column} ${row?.[column] ?? "N/A"}`)
      .join(", ");
    return `${index + 1}. ${label}: ${metricText}`;
  });

  return [
    "# Main agent tool result",
    "Tool: query_analytics_fallback",
    `Source query: POST ${url}`,
    `Dataset: ${payload?.dataset || "unknown"}`,
    `Source table: ${payload?.source_table || "unknown"}`,
    `Query fingerprint: ${payload?.query_fingerprint || "unknown"}`,
    `Rows: ${Number(payload?.returned_rows || 0)}${payload?.truncated ? " (truncated)" : ""}`,
    rowLines.length ? "Fallback rows:" : "Fallback rows: none",
    ...rowLines,
    `Audit: readonly=${Boolean(payload?.audit?.readonly)} allowlisted=${Boolean(payload?.audit?.allowlisted)}`,
    "This is an allowlisted read-only fallback result, not arbitrary SQL or full-database search.",
  ].join("\n");
}

async function executeAnalyticsFallback(toolCall, { analyticsFetch, analyticsApiBase }) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const { url, response } = await postAnalyticsJson("/api/analytics/fallback/query", args, { analyticsFetch, analyticsApiBase });
  if (!response?.ok) {
    const content = JSON.stringify({ error: `Analytics API request failed for query_analytics_fallback: ${response?.status || "unknown"}` });
    return {
      toolMessage: buildToolMessage(toolCall, content),
      contextText: `# Main agent tool result\nTool: query_analytics_fallback\nSource query: POST ${url}\nResult: unavailable because the governed fallback API request failed.`,
    };
  }
  const payload = await response.json();
  return {
    toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: "query_analytics_fallback", url, request: args, result: payload })),
    contextText: formatAnalyticsFallbackContext(url, payload),
  };
}

function buildDetectedByAliasFilters(baseFilters) {
  const detectedBy = baseFilters.detected_by;
  const values = Array.isArray(detectedBy) ? detectedBy : detectedBy ? [detectedBy] : [];
  const probes = [];
  for (const value of values) {
    const tokens = String(value || "").trim().split(/\s+/).filter(Boolean);
    if (tokens.length !== 2 || !COMMON_CHINESE_SURNAME_TOKENS.has(tokens[0].toLowerCase())) {
      continue;
    }
    const alias = [tokens[1], tokens[0]].join(" ");
    if (alias === value) {
      continue;
    }
    probes.push({ alias, filters: { ...baseFilters, detected_by: [alias] } });
  }
  return probes;
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

async function executeDefectRecords(toolCall, dependencies) {
  const args = parseToolArguments(toolCall?.function?.arguments);
  const { url, response } = await postAgentAnalyticsJson("/api/agent/analytics/defects/records", args, dependencies);
  if (!response?.ok) {
    return failedToolResult(
      toolCall,
      "query_defect_records",
      await sanitizedHttpFailure(response),
      `# Main agent tool result\nTool: query_defect_records\nSource query: POST ${url}\nResult: unavailable because the analytics API request failed.`,
    );
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
    "Constraint: similarity.not_population_statistic",
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
  analyticsApiBase = resolveAnalyticsApiBase(),
  runDuplicateBridge,
  runTestCaseBridge,
  ensureDuplicateWarmup,
  actor,
  actorCapabilitySecret,
  actorCapabilityNow,
  actorCapabilityNonce,
  actorCapabilityEnv,
  governedQueryPlan,
  generateTestCaseProposalContent,
  now,
} = {}) {
  analyticsFetch = boundDefaultAnalyticsFetch(analyticsFetch);
  if (toolCall?.function?.name === "prepare_testcase") {
    const args = parseToolArguments(toolCall?.function?.arguments);
    if (args?.anchor?.type !== "defect_id" || !String(args?.anchor?.value || "").trim()) {
      throw Object.assign(new Error("TESTCASE_DEFECT_ANCHOR_REQUIRED"), { code: "TESTCASE_DEFECT_ANCHOR_REQUIRED", status: "denied" });
    }
    const { prepareTestCaseProposal } = await import("./testCaseProposal.mjs");
    const proposal = await prepareTestCaseProposal({
      defectId: String(args.anchor.value).trim(),
      runTestCaseBridge,
      generateContent: generateTestCaseProposalContent,
      generatedAt: now instanceof Date ? now.toISOString() : new Date().toISOString(),
    });
    return {
      toolMessage: buildToolMessage(toolCall, JSON.stringify({ ok: true, tool: "prepare_testcase", result: proposal })),
      contextText: [
        "# Main agent testcase proposal",
        `Defect: ${proposal.defectId}`,
        `Proposal digest: ${proposal.proposalDigest}`,
        `Verification passed: ${proposal.verification?.passed === true}`,
        "Proposal only: no Octane mutation occurred. Ask the user to review it; never call a commit action from the Agent.",
      ].join("\n"),
    };
  }
  if (["catalog", "resolve", "analyze", "records", "trace", "duplicate_search"].includes(toolCall?.function?.name)) {
    const { expandPrimitiveToolCall, wrapPrimitiveResult } = await import("./mainAgentPrimitives.mjs");
    const expansion = expandPrimitiveToolCall(toolCall, { governedQueryPlan });
    const result = await executeMainAgentToolCall(expansion.adapterCall, {
      analyticsFetch,
      analyticsApiBase,
      runDuplicateBridge,
      runTestCaseBridge,
      ensureDuplicateWarmup,
      actor,
      actorCapabilitySecret,
      actorCapabilityNow,
      actorCapabilityNonce,
      actorCapabilityEnv,
      governedQueryPlan,
      generateTestCaseProposalContent,
      now,
    });
    return wrapPrimitiveResult(toolCall, expansion, result);
  }
  const agentAnalyticsDependencies = {
    analyticsFetch,
    analyticsApiBase,
    actor,
    actorCapabilitySecret,
    actorCapabilityNow,
    actorCapabilityNonce,
    actorCapabilityEnv,
  };
  const name = toolCall?.function?.name || "";
  const dataBoundary = mainAgentToolDataBoundary(name);
  if (isOidcScopedActor(actor) && dataBoundary === "internal_only") {
    return failedToolResult(
      toolCall,
      name,
      {
        code: "OIDC_INTERNAL_ONLY_TOOL_DENIED",
        dataBoundary,
        statusCode: 403,
        retryable: false,
      },
      `# Main agent tool result\nTool: ${name}\nResult: unavailable for OIDC actors until a scope-aware capability backend exists.`,
    );
  }
  if (isOidcScopedActor(actor) && dataBoundary !== "metadata" && dataBoundary !== "scoped_data") {
    return failedToolResult(
      toolCall,
      name || "unknown_tool",
      {
        code: "OIDC_TOOL_DATA_BOUNDARY_UNCLASSIFIED",
        statusCode: 403,
        retryable: false,
      },
      `# Main agent tool result\nTool: ${name || "unknown_tool"}\nResult: denied because the OIDC data boundary is unclassified.`,
    );
  }
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
    if (name === "search_analytics_filter_values") {
      return await executeAnalyticsFilterValueSearch(toolCall, { analyticsFetch, analyticsApiBase });
    }
    if (name === "resolve_business_terms") {
      return executeResolveBusinessTerms(toolCall);
    }
    if (name === "query_analytics") {
      return await executeQueryAnalytics(toolCall, agentAnalyticsDependencies);
    }
    if (name === "diagnose_analytics_empty") {
      return await executeDiagnoseAnalyticsEmpty(toolCall, agentAnalyticsDependencies);
    }
    if (name === "query_analytics_fallback") {
      return await executeAnalyticsFallback(toolCall, { analyticsFetch, analyticsApiBase });
    }
    if (name === "query_semantic_records") {
      return await executeSemanticRecords(toolCall, agentAnalyticsDependencies);
    }
    if (name === "query_semantic_metrics" || name === "query_traceability") {
      return await executeSemanticQuery(toolCall, agentAnalyticsDependencies);
    }
    if (name === "query_dashboard_summary") {
      return await executeDashboardSummary(toolCall, { analyticsFetch, analyticsApiBase });
    }
    if (name === "query_testing_coverage_project_status") {
      return await executeCoverageProjectStatus(toolCall, { analyticsFetch, analyticsApiBase });
    }
    if (name === "query_testing_coverage_aida_status") {
      return await executeCoverageAidaStatus(toolCall, { analyticsFetch, analyticsApiBase });
    }
    if (name === "query_testing_team_fv_analysis") {
      return await executeTestingTeamFvAnalysis(toolCall, agentAnalyticsDependencies);
    }
    if (name === "get_test_case_context") {
      return await executeTestCaseContext(toolCall, { analyticsFetch, analyticsApiBase });
    }
    if (name === "query_defect_high_frequency_analysis") {
      return await executeDefectHighFrequency(toolCall, { analyticsFetch, analyticsApiBase, now });
    }
    if (name === "query_defect_aggregate") {
      return await executeDefectAggregate(toolCall, agentAnalyticsDependencies);
    }
    if (name === "query_defect_records") {
      return await executeDefectRecords(toolCall, agentAnalyticsDependencies);
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
