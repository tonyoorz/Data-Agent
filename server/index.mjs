import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import duplicateBridgeRuntime from "./duplicateBridgeRuntime.cjs";
import { streamLangGraphChatResponse } from "./agentRuntime/langGraphChatHandler.mjs";
import { createLangGraphChatRuntime, resolveAgentRuntimeMode } from "./agentRuntime/langGraphChatRuntime.mjs";
import { createFileAgentRuntimeStore } from "./agentRuntime/runtimeAuditStore.mjs";
import { createSessionEventLog } from "./agentRuntime/sessionEventLog.mjs";
import { createEvalMetricsService, deriveOfflineVsOnline, readOfflineBaseline } from "./agentRuntime/evalMetrics.mjs";
import { createApprovalFlow } from "./agentRuntime/approvalFlow.mjs";
import { createActionRuntime, createInMemoryWriteStore } from "./agentRuntime/actionRuntime.mjs";
import { createFeedbackLoop, createSemanticCache } from "./agentRuntime/feedbackAndCache.mjs";
import { createSandboxSqlGuard, isSandboxSqlEnabled } from "./ontology/sandboxSql.mjs";
import { createOntologyRegistry } from "./ontology/registry.mjs";
import { resolveAgentOperationsResponse } from "./agentOperations.mjs";
import { resolveAiAnalyticsContext } from "./aiAnalyticsContext.mjs";
import { resolveMainAgentToolContext } from "./mainAgentToolLoop.mjs";
import { shouldPlanMainAgentTools } from "./mainAgentToolPlanning.mjs";
import { createDuplicateWarmupManager } from "./duplicateWarmup.mjs";
import { extractLatestUserQuery, resolveAiDefectContext } from "./aiContext.mjs";
import { streamCompanyChatCompletion, writeSseEvent } from "./companyChat.mjs";
import { createLocalHttpBoundary } from "./localHttpBoundary.mjs";
import { resolveRequestUrl } from "./httpRequestUrl.mjs";
import { resolveInternalAuxiliaryActor, runAuthenticatedChatRequest, toSafeAgentAuthResponse } from "./agentAuth.mjs";
import { attachDuplicateSummary } from "./duplicateResultEnrichment.mjs";
import { loadLocalEnv } from "./loadLocalEnv.mjs";
import {
  defaultQGateReportsRoot,
  findLatestQGateDashboardReport,
  resolveQGateDashboardHtmlPath,
} from "./qgateReports.mjs";
import { handleTranscribeRequest } from "./transcribe.mjs";
import { resolveChatModelConfig } from "./chatModelConfig.mjs";
import testcaseBridgeRuntime from "./testcaseBridgeRuntime.cjs";
import { prepareTestCaseProposal } from "./testCaseProposal.mjs";

const { runDuplicateBridge, stopDuplicateBridgeRuntime } = duplicateBridgeRuntime;
const { runTestCaseBridge, stopTestCaseBridgeRuntime } = testcaseBridgeRuntime;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
loadLocalEnv();
const port = Number(process.env.VIZION_API_PORT || 3004);
const localHttpBoundary = createLocalHttpBoundary(process.env);
const staticDir = fs.existsSync(path.join(repoRoot, "dist")) ? path.join(repoRoot, "dist") : "";
const duplicateWarmupManager = createDuplicateWarmupManager({
  runDuplicateBridge,
  logger: console,
});
const agentRuntimeStore = createFileAgentRuntimeStore();
const sessionEventLog = createSessionEventLog();
const evalMetricsService = createEvalMetricsService({ sessionEventLog });
const approvalFlow = createApprovalFlow({ eventLog: sessionEventLog });
const actionRuntime = createActionRuntime({
  registry: createOntologyRegistry(),
  eventLog: sessionEventLog,
  writeStore: createInMemoryWriteStore(),
});
const feedbackLoop = createFeedbackLoop();
const semanticCache = createSemanticCache();
// Governed sandbox SQL (strategic item): lazily built, default OFF via VIZION_SANDBOX_SQL=1.
let sandboxSqlGuardInstance;
function getSandboxSqlGuard() {
  if (sandboxSqlGuardInstance === undefined) {
    try {
      sandboxSqlGuardInstance = createSandboxSqlGuard({ registry: createOntologyRegistry() });
    } catch {
      sandboxSqlGuardInstance = null; // ontology not compiled in this environment
    }
  }
  return sandboxSqlGuardInstance;
}
const langGraphChatRuntime = createLangGraphChatRuntime({
  runtimeStore: agentRuntimeStore,
  sessionEventLog,
  approvalFlow,
  feedbackLoop,
  semanticCache,
});

function nowMs() {
  return performance.now();
}

function roundMs(value) {
  return Number(value.toFixed(1));
}

function buildRequestId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function summarizeQuery(queryText) {
  const normalized = String(queryText || "").replace(/\s+/g, " ").trim();
  return {
    length: normalized.length,
    preview: normalized.slice(0, 80),
  };
}

function logMetric(event, payload) {
  console.info(`[vizion-metric] ${JSON.stringify({ event, ...payload })}`);
}

function shouldResolveGatewayAnalyticsContext({ runtimeMode, useAnalyticsContext } = {}) {
  if (useAnalyticsContext !== true) {
    return false;
  }
  return String(runtimeMode || "").trim().toLowerCase() !== "langgraph";
}

export async function handleAiChatRequest(request, response) {
  return runAuthenticatedChatRequest(request, {
    env: process.env,
    readBody: () => readJsonBody(request),
    runChat: (body) => handleAuthenticatedAiChatRequest(body, response),
    sendAuthResponse: (authResponse) => sendJson(response, authResponse.statusCode, authResponse.payload),
    sendBadRequestResponse: (badRequestResponse) => sendJson(
      response,
      badRequestResponse.statusCode,
      badRequestResponse.payload,
    ),
  });
}

async function requireInternalAuxiliaryActor(request, response) {
  try {
    await resolveInternalAuxiliaryActor(request, { env: process.env });
    return true;
  } catch (error) {
    const safe = toSafeAgentAuthResponse(error);
    sendJson(response, safe?.statusCode || 503, safe?.payload || { success: false, error: "AUXILIARY_ROUTE_UNAVAILABLE" });
    return false;
  }
}

async function handleAuthenticatedAiChatRequest(body, response) {
  const startedAt = nowMs();
  const requestId = buildRequestId("ai-chat");
  const queryText = extractLatestUserQuery(body?.messages);
  const runtimeMode = resolveAgentRuntimeMode(process.env);
  const useDefectContext = body?.useDefectContext === true;
  const useAnalyticsContext = body?.useAnalyticsContext === true;
  const analyticsContext = shouldResolveGatewayAnalyticsContext({ runtimeMode, useAnalyticsContext })
    ? await resolveAiAnalyticsContext({ messages: body?.messages })
    : null;
  let aiContext = null;
  let mainAgentToolContext = null;
  let streamMetrics = null;

  try {
    if (runtimeMode === "langgraph") {
      const graphResult = await streamLangGraphChatResponse({
        body,
        response,
        runtime: langGraphChatRuntime,
        sessionEventLog,
        toolDependencies: {
          runDuplicateBridge,
          ensureDuplicateWarmup: () => duplicateWarmupManager.ensureWarm({ reason: "langgraph-agent-tool" }),
          runTestCaseBridge,
          generateTestCaseProposalContent: (defectInfo, fewShotText) => generateTestCaseContent(
            defectInfo,
            fewShotText,
            resolveChatModelConfig(undefined, process.env),
          ),
        },
        onCompleted: async (completed) => {
          await agentRuntimeStore.appendRunEvent({
            runId: completed.runtimeResult?.runId || "",
            threadId: completed.runtimeResult?.threadId || "",
            actorScope: completed.runtimeResult?.actorScope || {},
            type: "agent-stream-completed",
            ...(Number.isFinite(Number(completed.streamMetrics?.streamTotalMs)) ? { latencyMs: Number(completed.streamMetrics.streamTotalMs) } : {}),
            ...(completed.streamMetrics?.tokenUsage ? { tokenUsage: completed.streamMetrics.tokenUsage } : {}),
            citationValidation: completed.answerValidation
              ? completed.answerValidation.valid ? "pass" : "blocked"
              : "not_required",
          });
        },
      });
      streamMetrics = graphResult.streamMetrics;
      logMetric("ai_chat_request", {
        requestId,
        runtime: runtimeMode,
        model: String(body?.model || ""),
        query: summarizeQuery(graphResult.runtimeResult?.queryText || queryText),
        aiContextEnabled: graphResult.runtimeResult?.metrics?.aiContextEnabled || false,
        analyticsContextEnabled: graphResult.runtimeResult?.metrics?.analyticsContextEnabled || false,
        mainAgentToolCallCount: graphResult.runtimeResult?.metrics?.mainAgentToolCallCount || 0,
        aiContextTimings: graphResult.runtimeResult?.metrics?.aiContextTimings || null,
        streamMetrics,
        totalMs: roundMs(nowMs() - startedAt),
      });
      return;
    }

    if (useDefectContext && !analyticsContext?.skipDefectContext) {
      writeSseEvent(response, {
        type: "status",
        message: "正在检索 qgate 相关缺陷…",
      });

      aiContext = await resolveAiDefectContext({
        runDuplicateBridge,
        ensureDuplicateWarmup: () => duplicateWarmupManager.ensureWarm({ reason: "ai-chat-defect-context" }),
        messages: body?.messages,
        topK: 5,
      });
    }

    const baseContext = [body?.context, analyticsContext?.contextText, aiContext?.contextText].filter(Boolean).join("\n\n");
    if (useAnalyticsContext && !analyticsContext?.skipDefectContext && shouldPlanMainAgentTools(body?.messages)) {
      writeSseEvent(response, {
        type: "status",
        message: "正在判断是否需要调用 dashboard 工具…",
      });
      try {
        mainAgentToolContext = await resolveMainAgentToolContext({
          messages: body?.messages,
          model: body?.model,
          context: baseContext,
          toolDependencies: {
            runDuplicateBridge,
            ensureDuplicateWarmup: () => duplicateWarmupManager.ensureWarm({ reason: "main-agent-tool-search-duplicates" }),
            runTestCaseBridge,
            generateTestCaseProposalContent: (defectInfo, fewShotText) => generateTestCaseContent(
              defectInfo,
              fewShotText,
              resolveChatModelConfig(undefined, process.env),
            ),
          },
        });
        if (mainAgentToolContext.toolCalls.length) {
          writeSseEvent(response, {
            type: "status",
            message: `已调用 ${mainAgentToolContext.toolCalls.length} 个 dashboard 工具，正在生成回答…`,
          });
        }
      } catch (error) {
        console.warn("[ai-chat] main agent tool planning failed", error);
        writeSseEvent(response, {
          type: "status",
          message: "dashboard 工具暂不可用，改用已检索上下文回答…",
        });
      }
    }

    const mergedContext = [baseContext, mainAgentToolContext?.contextText].filter(Boolean).join("\n\n");
    const finalMessages = [
      ...(Array.isArray(body?.messages) ? body.messages : []),
      ...(mainAgentToolContext?.toolConversationMessages || []),
    ];
    await streamCompanyChatCompletion({
      messages: finalMessages,
      model: body?.model,
      context: mergedContext,
      response,
      prefaceEvents: [
        ...(mainAgentToolContext?.toolEvents || []),
        ...(aiContext?.duplicateSearchResult
          ? [
              {
                type: "context",
                context: aiContext.contextText,
                result: aiContext.duplicateSearchResult,
                timings: aiContext.timings,
              },
            ]
          : []),
      ],
      onMetrics: (metrics) => {
        streamMetrics = metrics;
      },
    });

    logMetric("ai_chat_request", {
      requestId,
      runtime: runtimeMode,
      model: String(body?.model || ""),
      query: summarizeQuery(aiContext?.queryText || queryText),
      aiContextEnabled: useDefectContext,
      analyticsContextEnabled: useAnalyticsContext,
      mainAgentToolCallCount: mainAgentToolContext?.toolCalls?.length || 0,
      aiContextTimings: aiContext?.timings || null,
      streamMetrics,
      totalMs: roundMs(nowMs() - startedAt),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error";
    logMetric("ai_chat_request_failed", {
      requestId,
      runtime: runtimeMode,
      model: String(body?.model || ""),
      query: summarizeQuery(aiContext?.queryText || queryText),
      aiContextEnabled: useDefectContext,
      analyticsContextEnabled: useAnalyticsContext,
      mainAgentToolCallCount: mainAgentToolContext?.toolCalls?.length || 0,
      aiContextTimings: aiContext?.timings || null,
      streamMetrics,
      totalMs: roundMs(nowMs() - startedAt),
      error: message,
    });
    if (response.headersSent) {
      writeSseEvent(response, { type: "error", message });
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }
    throw error;
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

async function proxyAnalyticsJson(pathname, searchParams, response) {
  const analyticsUrl = new URL(pathname, "http://127.0.0.1:3003");
  searchParams.forEach((value, key) => analyticsUrl.searchParams.append(key, value));
  const analyticsResponse = await fetch(analyticsUrl);
  const payload = await analyticsResponse.text();
  response.writeHead(analyticsResponse.status, {
    "Content-Type": analyticsResponse.headers.get("content-type") || "application/json; charset=utf-8",
  });
  response.end(payload);
}

async function generateTestCaseContent(defectInfo, fewShotText, chatConfig) {
  const { buildChatCompletionRequest } = await import("./chatModelConfig.mjs");

  if (!chatConfig.credential) {
    throw new Error("LLM credentials not configured — set DUPSEARCH_CHAT_ACCESS_CODE or DUPSEARCH_CHAT_API_KEY");
  }

  const systemPrompt = [
    "You are a test case generator for BMW ALM Octane (workspace 1002/2001).",
    "Generate a structured manual test case (test_manual) from a defect's reproduction information.",
    "",
    "Output format — return a JSON object with exactly these fields:",
    '{"testName": "[project][SW] Regression - short summary (D<defect_id>)", "descriptionHtml": "<html><body>...</body></html>", "stepsText": "- [PreCon] ...\\n- action step\\n- ? checkpoint"}',
    "",
    "Description HTML sections: Objective, Reference (defect link), Preconditions, baseline/regression tables (if quantitative data), pass/fail criteria.",
    "Steps text format: one step per line, prefixed by kind: '- [PreCon] <text>' (precondition), '- <text>' (action step), '- ? <text>' (checkpoint/expected result).",
    "Do NOT put the procedure in the description — it goes in stepsText only.",
    "Checkpoints must have specific values/thresholds (numbers, percentages), not vague 'check it works'.",
  ].join("\n");

  const userPrompt = [
    `Defect ID: ${defectInfo.defect_id}`,
    `Name: ${defectInfo.name}`,
    `Severity: ${defectInfo.severity}`,
    `Software: ${defectInfo.software_version}`,
    `ECU: ${defectInfo.assigned_ecu}`,
    `Lead model: ${defectInfo.lead_model}`,
    `Project: ${defectInfo.project}`,
    "",
    "Defect description:",
    defectInfo.description?.slice(0, 3000) || "(no description)",
    "",
    fewShotText ? `Reference test cases (style/structure examples):\n${fewShotText}\n` : "",
    "Generate the test case now. Return ONLY the JSON object, no markdown code fence.",
  ].join("\n");

  const requestConfig = buildChatCompletionRequest({
    selectedModel: chatConfig.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    env: process.env,
  });

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 120000);
  let response;
  try {
    response = await fetch(requestConfig.url, {
      method: "POST",
      headers: requestConfig.headers,
      body: JSON.stringify(requestConfig.body),
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "";
  // Parse JSON from the LLM response (it may be wrapped in code fences)
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("LLM did not return a JSON object");
  }
  const parsed = JSON.parse(jsonMatch[0]);

  return {
    testName: String(parsed.testName || `[${defectInfo.project}] Regression - ${defectInfo.name?.slice(0, 60)} (D${defectInfo.defect_id})`),
    descriptionHtml: String(parsed.descriptionHtml || ""),
    stepsText: String(parsed.stepsText || ""),
  };
}

function serveStaticAsset(request, response, url) {
  if (!staticDir || request.method !== "GET") {
    return false;
  }

  const rawPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const assetPath = path.normalize(path.join(staticDir, rawPath));
  if (!assetPath.startsWith(staticDir) || !fs.existsSync(assetPath) || fs.statSync(assetPath).isDirectory()) {
    const indexPath = path.join(staticDir, "index.html");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fs.readFileSync(indexPath));
    return true;
  }

  const ext = path.extname(assetPath).toLowerCase();
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };

  response.writeHead(200, {
    "Content-Type": contentTypes[ext] || "application/octet-stream",
  });
  response.end(fs.readFileSync(assetPath));
  return true;
}

const server = http.createServer(async (request, response) => {
  const admission = localHttpBoundary.evaluate({ method: request.method, headers: request.headers });
  if (!admission.allowed) {
    sendJson(response, admission.statusCode, { success: false, error: admission.code });
    return;
  }
  if (admission.corsOrigin) {
    response.setHeader("Access-Control-Allow-Origin", admission.corsOrigin);
  }

  const url = resolveRequestUrl(request.url, request.headers.host);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      ...(admission.corsOrigin ? { "Access-Control-Allow-Origin": admission.corsOrigin } : {}),
      "Access-Control-Allow-Headers": "content-type, authorization",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    response.end();
    return;
  }

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/agent-operations/summary") {
      const result = await resolveAgentOperationsResponse({
        request,
        operation: "summary",
        env: process.env,
        rootDir: agentRuntimeStore.rootDir,
      });
      sendJson(response, result.statusCode, result.payload);
      return;
    }

    const operationRunMatch = request.method === "GET" && /^\/api\/agent-operations\/runs\/([^/]+)$/.exec(url.pathname);
    if (operationRunMatch) {
      const result = await resolveAgentOperationsResponse({
        request,
        operation: "run",
        runId: decodeURIComponent(operationRunMatch[1]),
        env: process.env,
        rootDir: agentRuntimeStore.rootDir,
      });
      sendJson(response, result.statusCode, result.payload);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/qgate-reports/latest-dashboard") {
      sendJson(response, 200, findLatestQGateDashboardReport(defaultQGateReportsRoot));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/qgate-reports/weekly-report") {
      await proxyAnalyticsJson(url.pathname, url.searchParams, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/qgate-reports/dashboard-html") {
      const filePath = resolveQGateDashboardHtmlPath(
        defaultQGateReportsRoot,
        url.searchParams.get("run"),
        url.searchParams.get("file"),
      );
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(fs.readFileSync(filePath));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/context") {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      const startedAt = nowMs();
      const requestId = buildRequestId("ai-context");
      const body = await readJsonBody(request);
      const aiContext = await resolveAiDefectContext({
        runDuplicateBridge,
        ensureDuplicateWarmup: () => duplicateWarmupManager.ensureWarm({ reason: "ai-context-endpoint" }),
        messages: body?.messages,
        topK: 5,
      });
      logMetric("ai_context_request", {
        requestId,
        query: summarizeQuery(aiContext.queryText),
        timings: aiContext.timings,
        totalMs: roundMs(nowMs() - startedAt),
      });
      sendJson(response, 200, {
        success: true,
        queryText: aiContext.queryText,
        context: aiContext.contextText,
        result: aiContext.duplicateSearchResult,
        timings: aiContext.timings,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/duplicate-search/warmup-status") {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      sendJson(response, 200, duplicateWarmupManager.getStatus());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/duplicate-search/warmup") {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      const body = await readJsonBody(request);
      const status = await duplicateWarmupManager.ensureWarm({
        reason: typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim() : "manual",
      });
      sendJson(response, 200, status);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/chat") {
      await handleAiChatRequest(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/transcribe") {
      const body = await readJsonBody(request);
      const result = await handleTranscribeRequest(body);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      await handleAiChatRequest(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/duplicate-search") {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      const body = await readJsonBody(request);
      const query = typeof body?.query === "string" ? body.query.trim() : "";
      const selectedModel = typeof body?.model === "string" ? body.model.trim() : "";
      const topKRaw = Number(body?.top_k ?? 8);
      const topK = Number.isFinite(topKRaw) ? Math.max(1, Math.min(20, Math.floor(topKRaw))) : 8;

      if (!query) {
        sendJson(response, 400, { success: false, error: "query is required" });
        return;
      }

      const warmupStatus = duplicateWarmupManager.getStatus();
      if (warmupStatus.state === "warming") {
        stopDuplicateBridgeRuntime();
      }

      const result = await runDuplicateBridge({
        action: "search",
        query,
        top_k: topK,
      });

      if (result?.success && result?.result) {
        result.result = await attachDuplicateSummary({
          query,
          selectedModel,
          result: result.result,
        });
      }

      sendJson(response, result?.success ? 200 : 500, result);
      return;
    }

    // --- Agent feedback loop (P0-4) ---
    if (request.method === "POST" && url.pathname === "/api/ai/feedback") {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      const body = await readJsonBody(request);
      const thumb = typeof body?.thumb === "string" ? body.thumb.trim().toLowerCase() : "";
      if (!["up", "down"].includes(thumb)) {
        sendJson(response, 400, { success: false, error: "thumb must be up|down" });
        return;
      }
      try {
        const record = await feedbackLoop.recordThumb({
          sessionId: body?.sessionId,
          queryText: body?.queryText,
          intent: body?.intent,
          toolNames: Array.isArray(body?.toolNames) ? body.toolNames : [],
          thumb,
          note: body?.note || "",
        });
        const adjustments = await feedbackLoop.derivePolicyAdjustments();
        sendJson(response, 200, { success: true, record, policyAdjustments: adjustments });
      } catch (error) {
        sendJson(response, 500, { success: false, error: String(error?.message || error) });
      }
      return;
    }

    // --- Approval flow (P0-3): list pending + decide ---
    if (request.method === "GET" && url.pathname === "/api/ai/approvals") {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      const sessionId = url.searchParams?.get("sessionId") || undefined;
      const pending = approvalFlow.listPending(sessionId);
      await approvalFlow.expireStale().catch(() => []);
      sendJson(response, 200, { success: true, pending });
      return;
    }

    if (request.method === "POST" && /^\/api\/ai\/approvals\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      const approvalId = url.pathname.split("/").pop();
      const body = await readJsonBody(request);
      const decision = typeof body?.decision === "string" ? body.decision.trim().toLowerCase() : "";
      if (!["approved", "rejected"].includes(decision)) {
        sendJson(response, 400, { success: false, error: "decision must be approved|rejected" });
        return;
      }
      try {
        const outcome = await approvalFlow.decide({
          approvalId,
          decision,
          decidedBy: body?.decidedBy || "user",
        });
        sendJson(response, outcome?.status === "ok" ? 200 : 404, { success: outcome?.status === "ok", outcome });
      } catch (error) {
        sendJson(response, 500, { success: false, error: String(error?.message || error) });
      }
      return;
    }

    // --- Action runtime (P1-C2): governed transactional writeback ---
    if (request.method === "POST" && /^\/api\/ai\/actions\/[A-Za-z0-9._-]+\/submit$/.test(url.pathname)) {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      const actionId = url.pathname.split("/").at(-2);
      const body = await readJsonBody(request);
      try {
        const submission = await actionRuntime.submitAction({
          actionId,
          payload: body?.payload ?? {},
          actor: body?.actor ?? { actorId: "anonymous", scopes: {} },
          sessionId: body?.sessionId || "anonymous",
        });
        sendJson(response, 200, { success: true, submission });
      } catch (error) {
        sendJson(response, 400, { success: false, error: String(error?.message || error) });
      }
      return;
    }

    if (request.method === "POST" && /^\/api\/ai\/actions\/[A-Za-z0-9._-]+\/approve$/.test(url.pathname)) {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      const actionId = url.pathname.split("/").at(-2);
      const body = await readJsonBody(request);
      const decision = typeof body?.decision === "string" ? body.decision.trim().toLowerCase() : "approved";
      if (!["approved", "rejected"].includes(decision)) {
        sendJson(response, 400, { success: false, error: "decision must be approved|rejected" });
        return;
      }
      try {
        const outcome = await actionRuntime.decide({
          submissionId: body?.submissionId,
          decision,
          decidedBy: body?.decidedBy || "user",
          sessionId: body?.sessionId || "anonymous",
        });
        sendJson(response, outcome?.status === "not_found" ? 404 : 200, { success: outcome?.status !== "not_found", actionId, outcome });
      } catch (error) {
        sendJson(response, 500, { success: false, error: String(error?.message || error) });
      }
      return;
    }

    // --- Action log timeline (P1-C3): quality.action_log audit query ---
    if (request.method === "GET" && url.pathname === "/api/ai/actions/log") {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      const entity = url.searchParams.get("entity") || undefined;
      const since = url.searchParams.get("since") || undefined;
      const actionId = url.searchParams.get("actionId") || undefined;
      const limit = url.searchParams.get("limit") || undefined;
      sendJson(response, 200, { success: true, log: actionRuntime.queryLog({ entity, since, actionId, limit }) });
      return;
    }

    // --- Session event log (P0-1): durable model-visible stream ---
    if (request.method === "GET" && /^\/api\/ai\/sessions\/[A-Za-z0-9._-]+\/events$/.test(url.pathname)) {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      const sessionId = url.pathname.split("/")[4];
      try {
        const [events, metrics] = await Promise.all([
          sessionEventLog.read(sessionId),
          sessionEventLog.metrics(sessionId),
        ]);
        sendJson(response, 200, { success: true, sessionId, events, metrics });
      } catch (error) {
        sendJson(response, 500, { success: false, error: String(error?.message || error) });
      }
      return;
    }

    // --- Eval metrics (P1-8): online metrics closed loop from session event logs ---
    if (request.method === "GET" && url.pathname === "/api/ai/metrics") {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      const windowDaysRaw = Number(url.searchParams?.get("windowDays") ?? 7);
      const windowDays = Number.isFinite(windowDaysRaw)
        ? Math.max(1, Math.min(90, Math.floor(windowDaysRaw)))
        : 7;
      try {
        const report = await evalMetricsService.report({ windowDays });
        sendJson(response, 200, {
          success: true,
          windowDays: report.windowDays,
          aggregate: report.aggregate,
          daily: report.daily,
          generatedAt: report.generatedAt,
        });
      } catch (error) {
        sendJson(response, 500, { success: false, error: String(error?.message || error) });
      }
      return;
    }

    // --- Offline vs online divergence (P0-A5): golden baseline vs live task success ---
    if (request.method === "GET" && url.pathname === "/api/ai/metrics/offline-vs-online") {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      try {
        const baseline = readOfflineBaseline();
        const onlineReport = await evalMetricsService.report({ windowDays: 7 });
        const divergence = deriveOfflineVsOnline({
          offline: baseline ? { accuracy: baseline.accuracy, n: baseline.total } : null,
          online: {
            successRate: onlineReport.aggregate?.taskSuccessRate ?? null,
            n: onlineReport.aggregate?.evaluableTurns ?? 0,
          },
        });
        sendJson(response, 200, { success: true, divergence, baseline, generatedAt: onlineReport.generatedAt });
      } catch (error) {
        sendJson(response, 500, { success: false, error: String(error?.message || error) });
      }
      return;
    }

    // --- Governed sandbox SQL (strategic item): dry-run preview + approval-gated execution ---
    // Default OFF; enable with VIZION_SANDBOX_SQL=1. Results are evidence-kind
    // "sandbox_result" (non-claim-bearing): they may inform an answer but must
    // be labeled 未经治理校验 and never back a cited claim.
    if (request.method === "POST" && (url.pathname === "/api/ai/sandbox-sql/preview" || url.pathname === "/api/ai/sandbox-sql/execute")) {
      if (!isSandboxSqlEnabled()) {
        sendJson(response, 404, { success: false, error: "SANDBOX_SQL_DISABLED" });
        return;
      }
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      const guard = getSandboxSqlGuard();
      if (!guard) {
        sendJson(response, 503, { success: false, error: "SANDBOX_ONTOLOGY_NOT_COMPILED" });
        return;
      }
      const body = await readJsonBody(request);
      const sql = typeof body?.sql === "string" ? body.sql.trim() : "";
      const intent = typeof body?.intent === "string" ? body.intent : "list";
      const actor = body?.actor && typeof body.actor === "object" && !Array.isArray(body.actor) ? body.actor : null;

      if (url.pathname.endsWith("/preview")) {
        if (!sql) {
          sendJson(response, 400, { success: false, error: "sql required" });
          return;
        }
        if (!actor) {
          sendJson(response, 400, { success: false, error: "actor required (row-level policy is enforced per actor scope)" });
          return;
        }
        const preview = await guard.dryRun({ sql, actor, intent });
        sendJson(response, preview?.ok ? 200 : 400, {
          success: Boolean(preview?.ok),
          ...preview,
          evidenceKind: "sandbox_result",
          claimBearing: false,
        });
        return;
      }

      // execute path: approval-gated two-phase
      const approvalId = typeof body?.approvalId === "string" ? body.approvalId.trim() : "";
      if (approvalId) {
        const decision = typeof body?.decision === "string" ? body.decision.trim().toLowerCase() : "approved";
        if (!["approved", "rejected"].includes(decision)) {
          sendJson(response, 400, { success: false, error: "decision must be approved|rejected" });
          return;
        }
        try {
          const outcome = await approvalFlow.decide({ approvalId, decision, decidedBy: body?.decidedBy || "user" });
          if (outcome?.status !== "ok") {
            sendJson(response, 404, { success: false, error: "APPROVAL_NOT_FOUND_OR_EXPIRED" });
            return;
          }
          if (decision !== "approved" || outcome.handoffState?.kind !== "sandbox_sql") {
            sendJson(response, 200, { success: true, status: decision === "approved" ? "kind_mismatch" : "rejected" });
            return;
          }
          const handoff = outcome.handoffState;
          const limit = Math.max(1, Math.min(5000, Number(handoff.limit) || 200));
          const executed = await guard.execute({
            sql: handoff.sql,
            actor: handoff.actor,
            intent: handoff.intent || "list",
            limit,
          });
          await safeAppendSessionEvent(sessionEventLog, {
            type: "sandbox/execute",
            sessionId: handoff.sessionId || "sandbox",
            payload: { approvalId, ok: Boolean(executed?.ok), rowCount: executed?.rowCount ?? 0, reason: executed?.reason || "" },
          }).catch(() => {});
          sendJson(response, executed?.ok ? 200 : 400, {
            success: Boolean(executed?.ok),
            ...executed,
            approvalId,
            evidenceKind: "sandbox_result",
            claimBearing: false,
            governanceNote: "Sandbox results are 未经治理校验: label them in the answer and never back a cited claim with them.",
          });
        } catch (error) {
          sendJson(response, 500, { success: false, error: String(error?.message || error) });
        }
        return;
      }

      if (!sql) {
        sendJson(response, 400, { success: false, error: "sql required" });
        return;
      }
      if (!actor) {
        sendJson(response, 400, { success: false, error: "actor required (row-level policy is enforced per actor scope)" });
        return;
      }
      const limit = Math.max(1, Math.min(5000, Number(body?.limit) || 200));
      const preview = await guard.dryRun({ sql, actor, intent });
      if (!preview?.ok) {
        sendJson(response, 400, { success: false, ...preview });
        return;
      }
      try {
        const request2 = await approvalFlow.request({
          sessionId: body?.sessionId || "sandbox",
          kind: "sandbox_sql",
          summary: `execute sandbox sql on ${preview.tables?.join(", ") || "governed tables"}`,
          toolCall: { name: "sandbox_sql_execute", arguments: { sql, intent, limit } },
          handoffState: { kind: "sandbox_sql", sql, actor, intent, limit, sessionId: body?.sessionId || "sandbox" },
        });
        sendJson(response, 202, {
          success: true,
          status: "approval_pending",
          approvalId: request2.approvalId,
          preview,
          next: `POST /api/ai/sandbox-sql/execute {approvalId, decision:"approved|rejected"}`,
        });
      } catch (error) {
        sendJson(response, 500, { success: false, error: String(error?.message || error) });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/duplicate-feedback") {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      const body = await readJsonBody(request);
      const queryText = typeof body?.queryText === "string" ? body.queryText.trim() : "";
      const ticketId = typeof body?.ticketId === "string" ? body.ticketId.trim() : "";
      const signal = typeof body?.signal === "string" ? body.signal.trim().toLowerCase() : "";

      if (!queryText || !ticketId || !signal) {
        sendJson(response, 400, {
          success: false,
          error: "queryText/ticketId/signal are required",
        });
        return;
      }

      const result = await runDuplicateBridge({
        action: "feedback",
        query_text: queryText,
        ticket_id: ticketId,
        signal,
        base_score: body?.baseScore,
        rank_pos: body?.rankPos,
        user_id: body?.userId,
      });

      sendJson(response, result?.success ? 200 : 500, result);
      return;
    }

    // --- Create Test Case (slash command /create-testcase) ---

    if (request.method === "POST" && url.pathname === "/api/create-testcase/warmup") {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      try {
        const result = await runTestCaseBridge({ action: "warmup" });
        sendJson(response, result?.success ? 200 : 500, result);
      } catch (error) {
        sendJson(response, 500, { success: false, error: String(error?.message || error) });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/create-testcase") {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      const body = await readJsonBody(request);
      const defectId = typeof body?.defect_id === "string" ? body.defect_id.trim() : "";

      if (!defectId) {
        sendJson(response, 400, { success: false, error: "defect_id is required" });
        return;
      }

      try {
        const chatConfig = resolveChatModelConfig(undefined, process.env);
        const result = await prepareTestCaseProposal({
          defectId,
          runTestCaseBridge,
          generateContent: (defectInfo, fewShotText) => generateTestCaseContent(defectInfo, fewShotText, chatConfig),
        });

        sendJson(response, 200, { success: true, result });
      } catch (error) {
        sendJson(response, 500, { success: false, error: String(error?.message || error) });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/create-testcase/commit") {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      const body = await readJsonBody(request);
      const testCaseData = body?.test_case_data;
      const featureId = typeof body?.feature_id === "string" ? body.feature_id.trim() : "";
      const ownerId = typeof body?.owner_workspace_user_id === "string" ? body.owner_workspace_user_id.trim() : "";

      if (!testCaseData) {
        sendJson(response, 400, { success: false, error: "test_case_data is required" });
        return;
      }

      try {
        const result = await runTestCaseBridge({
          action: "commit",
          test_case_data: { ...testCaseData, owner_workspace_user_id: ownerId },
          feature_id: featureId,
        });
        sendJson(response, result?.success ? 200 : 500, result);
      } catch (error) {
        sendJson(response, 500, { success: false, error: String(error?.message || error) });
      }
      return;
    }

    if (serveStaticAsset(request, response, url)) {
      return;
    }

    sendJson(response, 404, { success: false, error: `Not found: ${url.pathname}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error";
    sendJson(response, 500, { success: false, error: message });
  }
});

server.listen(port, localHttpBoundary.listenHost, () => {
  console.log(`Vizion local API listening on http://${localHttpBoundary.listenHost}:${port}`);
  duplicateWarmupManager.triggerBackgroundWarmup({ reason: "startup" });
});

function shutdown() {
  stopDuplicateBridgeRuntime();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
