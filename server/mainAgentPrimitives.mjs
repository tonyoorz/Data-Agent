import { MAIN_AGENT_TOOLS as LEGACY_MAIN_AGENT_TOOLS } from "./mainAgentTools.mjs";

const LEGACY_BY_NAME = new Map(LEGACY_MAIN_AGENT_TOOLS.map((tool) => [tool.function.name, tool]));

function parametersFor(name) {
  const parameters = LEGACY_BY_NAME.get(name)?.function?.parameters;
  if (!parameters) throw new Error(`LEGACY_TOOL_SCHEMA_MISSING:${name}`);
  return parameters;
}

function operationBranch(operation, adapterTool) {
  return {
    type: "object",
    required: ["operation", "input"],
    additionalProperties: false,
    properties: {
      operation: { const: operation },
      input: parametersFor(adapterTool),
    },
  };
}

function planReferenceBranch(operation) {
  return {
    type: "object",
    required: ["operation", "input"],
    additionalProperties: false,
    properties: {
      operation: { const: operation },
      input: {
        type: "object",
        required: ["plan_ref"],
        additionalProperties: false,
        properties: {
          plan_ref: { type: "string", minLength: 1 },
          step_ref: { type: "string", minLength: 1 },
        },
      },
    },
  };
}

function semanticRecordsBranch() {
  const legacy = parametersFor("query_semantic_records");
  return {
    type: "object",
    required: ["operation", "input"],
    additionalProperties: false,
    properties: {
      operation: { const: "semantic" },
      input: {
        oneOf: [
          {
            type: "object",
            required: ["plan_ref"],
            additionalProperties: false,
            properties: {
              plan_ref: { type: "string", minLength: 1 },
              step_ref: { type: "string", minLength: 1 },
            },
          },
          {
            type: "object",
            required: ["analysis_ref", "ontology_version", "schema_fingerprint", "selections", "fields", "page", "page_size"],
            additionalProperties: false,
            properties: {
              analysis_ref: legacy.properties.analysis_ref,
              ontology_version: legacy.properties.ontology_version,
              schema_fingerprint: legacy.properties.schema_fingerprint,
              selections: legacy.properties.selections,
              fields: legacy.properties.fields,
              page: legacy.properties.page,
              page_size: legacy.properties.page_size,
            },
          },
        ],
      },
    },
  };
}

export const MAIN_AGENT_PRIMITIVE_NAMES = Object.freeze([
  "catalog",
  "resolve",
  "analyze",
  "records",
  "trace",
  "duplicate_search",
  "prepare_testcase",
]);

export const MAIN_AGENT_PRIMITIVE_TOOLS = Object.freeze([
  {
    type: "function",
    function: {
      name: "catalog",
      description: "Discover governed data, ontology capabilities, or a small top-k Octane field set. Catalog output is context, not permission to execute.",
      parameters: {
        oneOf: [
          operationBranch("data", "get_data_catalog"),
          operationBranch("ontology", "get_ontology_catalog"),
          operationBranch("octane_fields", "search_octane_fields"),
        ],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resolve",
      description: "Resolve business wording or canonical filter values before analysis. It cannot widen actor scope or execute data queries.",
      parameters: {
        oneOf: [
          operationBranch("business_terms", "resolve_business_terms"),
          operationBranch("filter_values", "search_analytics_filter_values"),
        ],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze",
      description: "Run a governed aggregate, comparison, ranking, coverage, or allowlisted dashboard analysis. Choose one typed operation; raw SQL, endpoint names, and actor scope are never accepted.",
      parameters: {
        oneOf: [
          planReferenceBranch("semantic_metrics"),
          operationBranch("defect_aggregate", "query_analytics"),
          operationBranch("coverage_project", "query_testing_coverage_project_status"),
          operationBranch("coverage_aida", "query_testing_coverage_aida_status"),
          operationBranch("testing_team_fv", "query_testing_team_fv_analysis"),
          operationBranch("dashboard_summary", "query_dashboard_summary"),
          operationBranch("defect_high_frequency", "query_defect_high_frequency_analysis"),
          operationBranch("full_picture", "query_full_picture_module"),
        ],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "records",
      description: "Return governed records or narrow a prior aggregate through its analysis reference. Record fields, pagination, snapshot, and actor scope remain server enforced.",
      parameters: {
        oneOf: [
          semanticRecordsBranch(),
          operationBranch("defects", "query_defect_records"),
        ],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "trace",
      description: "Traverse the approved Ontology relationship path contained in a server-governed plan. The model cannot submit its own graph query.",
      parameters: {
        type: "object",
        required: ["plan_ref"],
        additionalProperties: false,
        properties: {
          plan_ref: { type: "string", minLength: 1 },
          step_ref: { type: "string", minLength: 1 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "duplicate_search",
      description: "Search scoped historical defects for similarity candidates. Similarity is supporting evidence, never a population metric or causal conclusion.",
      parameters: parametersFor("search_duplicates"),
    },
  },
  {
    type: "function",
    function: {
      name: "prepare_testcase",
      description: "Retrieve scoped defect context, generate a testcase draft, sanitize it, and verify quality. This returns a digest-bound proposal only and never commits or mutates Octane.",
      parameters: {
        type: "object",
        required: ["anchor", "purpose"],
        additionalProperties: false,
        properties: {
          anchor: {
            type: "object",
            required: ["type", "value"],
            additionalProperties: false,
            properties: { type: { const: "defect_id" }, value: { type: "string", minLength: 1 } },
          },
          purpose: { const: "create_test_case" },
        },
      },
    },
  },
]);

const OPERATION_ADAPTERS = Object.freeze({
  catalog: Object.freeze({
    data: "get_data_catalog",
    ontology: "get_ontology_catalog",
    octane_fields: "search_octane_fields",
  }),
  resolve: Object.freeze({
    business_terms: "resolve_business_terms",
    filter_values: "search_analytics_filter_values",
  }),
  analyze: Object.freeze({
    semantic_metrics: "query_semantic_metrics",
    defect_aggregate: "query_analytics",
    coverage_project: "query_testing_coverage_project_status",
    coverage_aida: "query_testing_coverage_aida_status",
    testing_team_fv: "query_testing_team_fv_analysis",
    dashboard_summary: "query_dashboard_summary",
    defect_high_frequency: "query_defect_high_frequency_analysis",
    full_picture: "query_full_picture_module",
  }),
  records: Object.freeze({
    semantic: "query_semantic_records",
    defects: "query_defect_records",
  }),
});

const DIRECT_ADAPTERS = Object.freeze({
  trace: "query_traceability",
  duplicate_search: "search_duplicates",
  prepare_testcase: "get_test_case_context",
});

const LEGACY_TO_PRIMITIVE = new Map([
  ["get_data_catalog", ["catalog", "data"]],
  ["get_ontology_catalog", ["catalog", "ontology"]],
  ["search_octane_fields", ["catalog", "octane_fields"]],
  ["resolve_business_terms", ["resolve", "business_terms"]],
  ["search_analytics_filter_values", ["resolve", "filter_values"]],
  ["query_semantic_metrics", ["analyze", "semantic_metrics"]],
  ["query_analytics", ["analyze", "defect_aggregate"]],
  ["query_defect_aggregate", ["analyze", "defect_aggregate"]],
  ["query_testing_coverage_project_status", ["analyze", "coverage_project"]],
  ["query_testing_coverage_aida_status", ["analyze", "coverage_aida"]],
  ["query_testing_team_fv_analysis", ["analyze", "testing_team_fv"]],
  ["query_dashboard_summary", ["analyze", "dashboard_summary"]],
  ["query_defect_high_frequency_analysis", ["analyze", "defect_high_frequency"]],
  ["query_full_picture_module", ["analyze", "full_picture"]],
  ["query_semantic_records", ["records", "semantic"]],
  ["query_defect_records", ["records", "defects"]],
  ["query_traceability", ["trace", null]],
  ["search_duplicates", ["duplicate_search", null]],
  ["get_test_case_context", ["prepare_testcase", null]],
]);

function parseArguments(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function selectGovernedStep(governedQueryPlan, adapterInput, predicate) {
  if (String(governedQueryPlan?.planId || "") !== String(adapterInput?.plan_ref || "")) {
    throw new Error("PRIMITIVE_PLAN_REF_INVALID");
  }
  const candidates = (Array.isArray(governedQueryPlan?.steps) ? governedQueryPlan.steps : []).filter(predicate);
  const stepRef = String(adapterInput?.step_ref || "").trim();
  const selected = stepRef
    ? candidates.filter((step) => String(step?.stepId || "") === stepRef)
    : candidates;
  if (selected.length !== 1 || !selected[0]?.canonicalArgs) throw new Error("PRIMITIVE_PLAN_STEP_INVALID");
  return selected[0];
}

export function primitiveForLegacyTool(name) {
  return LEGACY_TO_PRIMITIVE.get(String(name || ""))?.[0] || "";
}

export function toPrimitiveToolCall(toolCall) {
  const name = String(toolCall?.function?.name || "");
  if (MAIN_AGENT_PRIMITIVE_NAMES.includes(name)) return toolCall;
  const mapping = LEGACY_TO_PRIMITIVE.get(name);
  if (!mapping) return null;
  const [primitive, operation] = mapping;
  const input = parseArguments(toolCall?.function?.arguments);
  const args = operation ? { operation, input } : input;
  return {
    ...toolCall,
    function: {
      ...toolCall.function,
      name: primitive,
      arguments: JSON.stringify(args),
    },
  };
}

export function expandPrimitiveToolCall(toolCall, { governedQueryPlan } = {}) {
  const primitive = String(toolCall?.function?.name || "");
  const args = parseArguments(toolCall?.function?.arguments);
  const operation = String(args.operation || "");
  const adapterTool = DIRECT_ADAPTERS[primitive] || OPERATION_ADAPTERS[primitive]?.[operation];
  if (!adapterTool) throw new Error(`PRIMITIVE_OPERATION_NOT_ALLOWED:${primitive}:${operation || "direct"}`);
  let adapterInput = DIRECT_ADAPTERS[primitive] ? args : args.input;
  if (primitive === "analyze" && operation === "semantic_metrics" && adapterInput?.plan_ref) {
    adapterInput = selectGovernedStep(
      governedQueryPlan,
      adapterInput,
      (step) => step?.toolName === "query_semantic_metrics" && step?.operation === "semantic_metric_query",
    ).canonicalArgs;
  }
  if (primitive === "trace") {
    if (!adapterInput?.plan_ref) throw new Error("PRIMITIVE_INPUT_INVALID:trace:direct");
    adapterInput = selectGovernedStep(
      governedQueryPlan,
      adapterInput,
      (step) => step?.toolName === "query_traceability" && step?.operation === "traceability_query",
    ).canonicalArgs;
  }
  if (primitive === "records" && operation === "semantic") {
    if (adapterInput?.plan_ref) {
      adapterInput = selectGovernedStep(
        governedQueryPlan,
        adapterInput,
        (step) => step?.toolName === "query_semantic_records" && step?.operation === "semantic_record_query",
      ).canonicalArgs;
    } else if (adapterInput?.analysis_ref) {
      adapterInput = {
        query: null,
        analysis_ref: String(adapterInput.analysis_ref),
        ontology_version: String(adapterInput.ontology_version),
        schema_fingerprint: String(adapterInput.schema_fingerprint),
        selections: adapterInput.selections,
        fields: adapterInput.fields,
        page: adapterInput.page,
        page_size: adapterInput.page_size,
      };
    } else {
      throw new Error("PRIMITIVE_INPUT_INVALID:records:semantic");
    }
  }
  if (!adapterInput || typeof adapterInput !== "object" || Array.isArray(adapterInput)) {
    throw new Error(`PRIMITIVE_INPUT_INVALID:${primitive}:${operation || "direct"}`);
  }
  return {
    primitive,
    operation: operation || "direct",
    adapterTool,
    adapterCall: {
      ...toolCall,
      function: {
        ...toolCall.function,
        name: adapterTool,
        arguments: JSON.stringify(adapterInput),
      },
    },
  };
}

export function wrapPrimitiveResult(toolCall, expansion, result) {
  let payload;
  try {
    payload = JSON.parse(String(result?.toolMessage?.content || "{}"));
  } catch {
    payload = { ok: false, error: "PRIMITIVE_ADAPTER_RESULT_INVALID" };
  }
  const content = JSON.stringify({
    ...payload,
    tool: expansion.primitive,
    primitive: expansion.primitive,
    operation: expansion.operation,
    adapterTool: expansion.adapterTool,
  });
  return {
    ...result,
    toolMessage: {
      ...(result?.toolMessage || {}),
      role: "tool",
      tool_call_id: toolCall?.id || "",
      name: expansion.primitive,
      content,
    },
    contextText: [
      "# Governed agent primitive",
      `Primitive: ${expansion.primitive}`,
      `Operation: ${expansion.operation}`,
      `Private adapter: ${expansion.adapterTool}`,
      result?.contextText || "",
    ].filter(Boolean).join("\n"),
    primitive: expansion.primitive,
    operation: expansion.operation,
    adapterTool: expansion.adapterTool,
  };
}
