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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const FULL_PICTURE_MODULE_ENDPOINTS = {
  dashboard_summary: "/api/full-picture/dashboard/summary",
  dashboard_tickets: "/api/full-picture/dashboard/tickets",
  top_issue_analysis: "/api/full-picture/top-issue-analysis",
  long_runner_analysis: "/api/full-picture/long-runner-analysis",
  defect_high_frequency_analysis: "/api/full-picture/defect-high-frequency-analysis",
};

export const MAIN_AGENT_TOOLS = [
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

function buildToolMessage(toolCall, content) {
  return {
    role: "tool",
    tool_call_id: toolCall?.id || "",
    name: toolCall?.function?.name || "",
    content,
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
  now,
} = {}) {
  const name = toolCall?.function?.name || "";
  try {
    if (name === "query_dashboard_summary") {
      return await executeDashboardSummary(toolCall, { analyticsFetch, analyticsApiBase });
    }
    if (name === "query_testing_coverage_project_status") {
      return await executeCoverageProjectStatus(toolCall, { analyticsFetch, analyticsApiBase });
    }
    if (name === "query_defect_high_frequency_analysis") {
      return await executeDefectHighFrequency(toolCall, { analyticsFetch, analyticsApiBase, now });
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
    const message = error instanceof Error ? error.message : String(error);
    const content = JSON.stringify({ error: message });
    return {
      toolMessage: buildToolMessage(toolCall, content),
      contextText: `# Main agent tool result\nTool: ${name}\nResult: failed: ${message}`,
    };
  }
}