import { extractLatestUserQuery } from "./aiContext.mjs";
import { buildShadowSemanticObservation } from "./agentRuntime/shadow.mjs";
import { safeTelemetryErrorCode } from "./agentRuntime/telemetry.mjs";
import { createQueryPlanner } from "./ontology/queryPlanner.mjs";
import { createSemanticResolver } from "./ontology/resolver.mjs";

const ANALYTICS_API_BASE = process.env.VIZION_ANALYTICS_API_BASE || "http://127.0.0.1:3003";

const ANALYTICS_CONTEXT = `# Analytics business context
Data sources:
- octane_defects: defect-level QGate/Octane data for Main Dashboard, outcome, phase, requirement, project, AIDA, PU, market, lead model, and China/Global analysis.
- octane_defect_history_events: defect phase/history changes; Resolved Forward means phase 08 -> 06, Rejected Directly means phase 01 -> 09.
- octane_manual_runs: manual-run/test execution data for Testing Coverage, including test_id, status, test_week, top_aida, project, fv, fvp, tester, team, and lead_model.
- octane_testcases and octane_testcase_relations: testcase-to-defect/feature/story traceability.

Business rules:
- Main Dashboard filters use the repository filter vocabulary: years, requirements, china_scopes, projects, assigned_ecus, problem_finder_teams, aidas, phases, solution_clusters, pus, markets, lead_models, groups.
- Phase groups: 02/07=Q-Gate, 00/01/06/08/09=Integration, 03/04/05=CoC, otherwise Other.
- China/Global prefers solution_cluster first; defect_category is only a fallback when solution_cluster is blank.
- Testing Coverage derives test_week from manual-run finished time when available and preserves TPMDashboard project/feature-region semantics.

Answer guardrails:
- Do not invent fields or metrics. If source fields are absent or coverage is unclear, say the data is not ready instead of treating missing data as zero.
- DTSV in user questions maps to problem_finder_team=DTSV_China unless a different DTSV team is explicitly named.
- For bug/defect questions, opened/created/raised/submitted/提/提交/创建 means octane_defects.creation_time, not current phase or duplicate-search candidates.
- Do not invent modules such as ai-chat, user-auth, payment, or data-pipeline. Those are not QGate dashboard modules.
- Keep duplicate-search ranking separate from analytics semantics unless explicit duplicate context is provided.`;

const MONTH_NAMES = new Map([
  ["january", 1],
  ["jan", 1],
  ["february", 2],
  ["feb", 2],
  ["march", 3],
  ["mar", 3],
  ["april", 4],
  ["apr", 4],
  ["may", 5],
  ["june", 6],
  ["jun", 6],
  ["july", 7],
  ["jul", 7],
  ["august", 8],
  ["aug", 8],
  ["september", 9],
  ["sep", 9],
  ["october", 10],
  ["oct", 10],
  ["november", 11],
  ["nov", 11],
  ["december", 12],
  ["dec", 12],
]);

function extractRecentUserText(messages, limit = 3) {
  if (!Array.isArray(messages)) {
    return "";
  }

  return messages
    .filter((message) => message?.role === "user")
    .slice(-limit)
    .map((message) => {
      if (typeof message.content === "string") {
        return message.content;
      }
      if (Array.isArray(message.content)) {
        return message.content
          .map((part) => (typeof part?.text === "string" ? part.text : typeof part === "string" ? part : ""))
          .join("\n");
      }
      return "";
    })
    .join("\n")
    .trim();
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function monthEndDay(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function detectMonthWindow(queryText, now) {
  const text = String(queryText || "");
  const explicitYear = text.match(/\b(20\d{2})\b/);
  const year = explicitYear ? Number(explicitYear[1]) : now.getUTCFullYear();
  const chineseMonth = text.match(/(?:^|[^\d])([1-9]|1[0-2])\s*月(?:份)?/);
  let month = chineseMonth ? Number(chineseMonth[1]) : null;

  if (month == null) {
    const lowerText = text.toLowerCase();
    for (const [name, value] of MONTH_NAMES) {
      if (new RegExp(`\\b${name}\\b`, "i").test(lowerText)) {
        month = value;
        break;
      }
    }
  }

  if (month == null) {
    return null;
  }

  return {
    year,
    month,
    start: `${year}-${pad2(month)}-01`,
    end: `${year}-${pad2(month)}-${pad2(monthEndDay(year, month))}`,
  };
}

function detectOpenedDtsvMetric(queryText, now, semanticFrame) {
  const text = String(queryText || "");
  if (!/DTSV/i.test(text)) {
    return null;
  }
  if (!/(bug|defect|缺陷)/i.test(text)) {
    return null;
  }
  if (!/(opened|created|raised|submitted|open|提了|提交|创建|新建)/i.test(text)) {
    return null;
  }

  const window = detectMonthWindow(text, now);
  if (!window) {
    return null;
  }

  const searchParams = new URLSearchParams({
    years: String(window.year),
    problem_finder_teams: "DTSV_China",
    creation_time_start: window.start,
    creation_time_end: window.end,
  });
  for (const filter of semanticFrame?.filters || []) {
    if (!Array.isArray(filter.values) || !filter.values.length) continue;
    if (filter.dimensionId === "org.problem_finder_team") searchParams.set("problem_finder_teams", filter.values.join(","));
    if (filter.dimensionId === "product.project") searchParams.set("projects", filter.values.join(","));
  }

  return {
    ...window,
    team: "DTSV_China",
    url: `${ANALYTICS_API_BASE}/api/full-picture/dashboard/summary?${searchParams.toString()}`,
  };
}

function governedContext(frame, plan, registry) {
  const metrics = (frame.metricIds || []).map((metricId) => {
    const metric = registry.getMetric(metricId);
    return `${metric.id}@${metric.definitionVersion} [${metric.governance.status}] ${metric.labels?.["zh-CN"] || metric.id}`;
  });
  const scope = (frame.filters || []).map((filter) => `${filter.source}:${filter.dimensionId}:${filter.operator}:${(filter.values || []).join("|")}`);
  const times = (frame.timeScopes || []).map((time) => `${time.role}:${time.fieldId}:${time.start}..${time.end}:${time.timezone}`);
  return [
    "# Governed Ontology interpretation",
    `Intent: ${frame.intent}`,
    `Metrics: ${metrics.join(", ") || "none"}`,
    `Dimensions: ${(frame.dimensionIds || []).join(", ") || "none"}`,
    `Authorized filters: ${scope.join("; ") || "none"}`,
    `Time scopes: ${times.join("; ") || "none"}`,
    `Plan status: ${plan.status}`,
    `Approved tools: ${(plan.steps || []).map((step) => step.toolName).join(", ") || "none"}`,
    "This interpretation is authoritative. Do not redefine metrics, remove policy filters, or infer unavailable values.",
  ].join("\n");
}

async function resolveDetectedMetricContext(metric, analyticsFetch) {
  if (!metric || typeof analyticsFetch !== "function") {
    return "";
  }

  try {
    const response = await analyticsFetch(metric.url);
    if (!response?.ok) {
      return [
        "# Resolved analytics query",
        `Intent: count defects opened/created by DTSV in ${metric.year}-${pad2(metric.month)}.`,
        "DTSV maps to problem_finder_team=DTSV_China.",
        "opened/created means octane_defects.creation_time.",
        `Source query: GET ${metric.url}`,
        "Result: unavailable because the analytics summary API did not return OK.",
        "Do not invent modules such as ai-chat, user-auth, payment, or data-pipeline.",
      ].join("\n");
    }

    const payload = await response.json();
    const ticketCount = Number(payload?.overview?.ticket_count);
    const resultText = Number.isFinite(ticketCount)
      ? `Result: ${ticketCount} defects`
      : "Result: unavailable because overview.ticket_count is missing.";

    return [
      "# Resolved analytics query",
      `Intent: count defects opened/created by DTSV in ${metric.year}-${pad2(metric.month)}.`,
      "DTSV maps to problem_finder_team=DTSV_China.",
      "opened/created means octane_defects.creation_time.",
      `Source query: GET ${metric.url}`,
      resultText,
      payload?.snapshot_version ? `Snapshot: ${payload.snapshot_version}` : "",
      "Answer this directly before adding caveats.",
      "Do not invent modules such as ai-chat, user-auth, payment, or data-pipeline.",
    ].filter(Boolean).join("\n");
  } catch (error) {
    const code = safeTelemetryErrorCode(error, "ANALYTICS_QUERY_FAILED");
    return [
      "# Resolved analytics query",
      `Intent: count defects opened/created by DTSV in ${metric.year}-${pad2(metric.month)}.`,
      "DTSV maps to problem_finder_team=DTSV_China.",
      "opened/created means octane_defects.creation_time.",
      `Source query: GET ${metric.url}`,
      `Result: unavailable because the analytics summary query failed: ${code}`,
      "Do not invent modules such as ai-chat, user-auth, payment, or data-pipeline.",
    ].join("\n");
  }
}

export async function resolveAiAnalyticsContext({ messages, analyticsFetch = globalThis.fetch, now = new Date(), actor, ontologyRegistry }) {
  const queryText = extractLatestUserQuery(messages);
  if (!queryText) {
    return { queryText: "", contextText: "" };
  }

  const recentUserText = extractRecentUserText(messages);
  let semanticFrame;
  let semanticPlan;
  let semanticContext = "";
  let shadowObservation = {};
  let governanceFailed = false;
  if (actor && ontologyRegistry) {
    try {
      const resolver = createSemanticResolver({ registry: ontologyRegistry, now: () => now.toISOString() });
      semanticFrame = resolver.resolve({ query: recentUserText || queryText, actor, requestAnchorAt: now.toISOString() });
      semanticPlan = createQueryPlanner({ registry: ontologyRegistry }).createPlan({ frame: semanticFrame, actor, query: recentUserText || queryText });
      semanticContext = governedContext(semanticFrame, semanticPlan, ontologyRegistry);
      shadowObservation = buildShadowSemanticObservation({ semanticFrame, plan: semanticPlan });
    } catch (error) {
      governanceFailed = true;
      semanticContext = `# Governed Ontology interpretation\nStatus: ${safeTelemetryErrorCode(error, "SEMANTIC_CONTEXT_UNAVAILABLE")}\nDo not answer analytics questions without governed evidence.`;
    }
  }
  const detectedMetric = governanceFailed ? null : detectOpenedDtsvMetric(recentUserText, now, semanticFrame);
  const detectedMetricContext = await resolveDetectedMetricContext(detectedMetric, analyticsFetch);

  return {
    queryText,
    contextText: [ANALYTICS_CONTEXT, semanticContext, detectedMetricContext].filter(Boolean).join("\n\n"),
    skipDefectContext: Boolean(detectedMetric),
    shadowObservation,
    shadowQueryText: recentUserText || queryText,
  };
}
