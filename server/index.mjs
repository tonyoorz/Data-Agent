import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import duplicateBridgeRuntime from "./duplicateBridgeRuntime.cjs";
import { streamLangGraphChatResponse } from "./agentRuntime/langGraphChatHandler.mjs";
import { createLangGraphChatRuntime, resolveAgentRuntimeMode } from "./agentRuntime/langGraphChatRuntime.mjs";
import { MemorySaver } from "@langchain/langgraph";
import { createFileAgentRuntimeStore } from "./agentRuntime/runtimeAuditStore.mjs";
import { buildAgentStreamAuditEvent } from "./agentRuntime/streamAudit.mjs";
import { resolveAgentOperationsResponse } from "./agentOperations.mjs";
import {
  createDuplicateWarmupManager,
  shouldWarmDuplicateSearch,
} from "./duplicateWarmup.mjs";
import { extractLatestUserQuery, resolveAiDefectContext } from "./aiContext.mjs";
import {
  controlledChatErrorDiagnostic,
  toSafeCompanyChatError,
  writeSseEvent,
} from "./companyChat.mjs";
import { resolveRequestUrl } from "./httpRequestUrl.mjs";
import {
  resolveInternalAuxiliaryActor,
  runAuthenticatedAgentRequest,
  runAuthenticatedChatRequest,
  toSafeAgentAuthResponse,
} from "./agentAuth.mjs";
import { attachDuplicateSummary } from "./duplicateResultEnrichment.mjs";
import { assertSupportedNodeVersion } from "../scripts/nodeVersion.mjs";
import { loadLocalEnv } from "./loadLocalEnv.mjs";
import {
  resolveAnalyticsApiBase,
  resolveAnalyticsProxyTimeoutMs,
} from "./analyticsApiConfig.mjs";
import { proxyAnalyticsJson } from "./analyticsProxy.mjs";
import {
  buildLocalCorsHeaders,
  isJsonApiRequest,
  isTrustedLocalApiRequest,
  listenLocalApiServer,
  readBoundedJsonBody,
  resolveJsonBodyLimit,
  resolveLocalApiPort,
  toSafeLocalApiBodyResponse,
} from "./localApiBinding.mjs";
import {
  buildQGateDashboardCsp,
  createQGateDashboardNonce,
  defaultQGateReportsRoot,
  findLatestQGateDashboardReport,
  resolveQGateDashboardHtmlPath,
  stampQGateScriptNonce,
} from "./qgateReports.mjs";
import { handleTranscribeRequest, toSafeTranscriptionError } from "./transcribe.mjs";
import { resolveChatModelConfig } from "./chatModelConfig.mjs";
import testcaseBridgeRuntime from "./testcaseBridgeRuntime.cjs";

const { runDuplicateBridge, stopDuplicateBridgeRuntime } = duplicateBridgeRuntime;
const { runTestCaseBridge, stopTestCaseBridgeRuntime } = testcaseBridgeRuntime;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
assertSupportedNodeVersion();
loadLocalEnv();
const analyticsApiBase = resolveAnalyticsApiBase();
const analyticsProxyTimeoutMs = resolveAnalyticsProxyTimeoutMs();
const port = resolveLocalApiPort(process.env.VIZION_API_PORT, 3004, "VIZION_API_PORT");
const webPort = resolveLocalApiPort(process.env.VIZION_WEB_PORT, 8080, "VIZION_WEB_PORT");
const jsonBodyLimitBytes = resolveJsonBodyLimit(process.env);
const staticDir = fs.existsSync(path.join(repoRoot, "dist")) ? path.join(repoRoot, "dist") : "";
const duplicateWarmupManager = createDuplicateWarmupManager({
  runDuplicateBridge,
  logger: console,
});
const agentRuntimeStore = createFileAgentRuntimeStore();

// Persistent checkpointer so conversations survive process restarts (the default
// MemorySaver is in-process only and loses state on restart). SqliteSaver needs
// @langchain/langgraph-checkpoint-sqlite + better-sqlite3; if either is missing
// or the API differs we fall back to MemorySaver so the server still boots.
let agentCheckpointer;
try {
  const checkpointDbPath = process.env.VIZION_AGENT_CHECKPOINT_DB
    || path.join(repoRoot, "data", "agent-checkpoints.db");
  fs.mkdirSync(path.dirname(checkpointDbPath), { recursive: true });
  const sqliteModule = await import("@langchain/langgraph-checkpoint-sqlite");
  const SqliteSaver = sqliteModule.SqliteSaver;
  agentCheckpointer = await SqliteSaver.fromConnString(checkpointDbPath);
  console.info(`[vizion] agent checkpointer: SqliteSaver @ ${checkpointDbPath}`);
} catch (error) {
  agentCheckpointer = new MemorySaver();
  console.warn(`[vizion] SqliteSaver unavailable, using in-process MemorySaver: ${error?.message || error}`);
}

const langGraphChatRuntime = createLangGraphChatRuntime({
  runtimeStore: agentRuntimeStore,
  checkpointer: agentCheckpointer,
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
  };
}

function logMetric(event, payload) {
  console.info(`[vizion-metric] ${JSON.stringify({ event, ...payload })}`);
}

export async function handleAiChatRequest(request, response) {
  return runAuthenticatedChatRequest(request, {
    env: process.env,
    readBody: () => readBoundedJsonBody(request, { maxBytes: jsonBodyLimitBytes }),
    runChat: (body) => handleAuthenticatedAiChatRequest(body, response),
    sendAuthResponse: (authResponse) => sendJson(response, authResponse.statusCode, authResponse.payload),
    sendBadRequestResponse: (badRequestResponse) => sendJson(
      response,
      badRequestResponse.statusCode,
      badRequestResponse.payload,
    ),
  });
}

export async function handleAiTranscribeRequest(request, response) {
  return runAuthenticatedAgentRequest(request, {
    env: process.env,
    readBody: () => readBoundedJsonBody(request, { maxBytes: jsonBodyLimitBytes }),
    runRequest: async (body) => {
      try {
        const result = await handleTranscribeRequest(body);
        sendJson(response, 200, result);
      } catch (error) {
        const safeError = toSafeTranscriptionError(error);
        sendJson(response, safeError.statusCode, safeError.payload);
      }
    },
    invalidBodyError: "INVALID_TRANSCRIBE_REQUEST_BODY",
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
  let streamMetrics = null;
  let runtimeResult = null;

  try {
    const graphResult = await streamLangGraphChatResponse({
      body,
      response,
      runtime: langGraphChatRuntime,
      toolDependencies: {
        runDuplicateBridge,
        ensureDuplicateWarmup: () => duplicateWarmupManager.ensureWarm({ reason: "langgraph-agent-tool" }),
      },
      onCompleted: async (completed) => {
        await agentRuntimeStore.appendRunEvent(buildAgentStreamAuditEvent(completed));
      },
    });
    runtimeResult = graphResult.runtimeResult;
    streamMetrics = graphResult.streamMetrics;

    const outcome = graphResult.terminal?.status
      || (graphResult.answerValidation?.valid === false ? "blocked" : "completed");
    logMetric(outcome === "failed" ? "ai_chat_request_failed" : "ai_chat_request", {
      requestId,
      outcome,
      runtime: runtimeMode,
      model: String(body?.model || ""),
      query: summarizeQuery(runtimeResult?.queryText || queryText),
      aiContextEnabled: runtimeResult?.metrics?.aiContextEnabled || false,
      analyticsContextEnabled: runtimeResult?.metrics?.analyticsContextEnabled || false,
      mainAgentToolCallCount: runtimeResult?.metrics?.mainAgentToolCallCount || 0,
      aiContextTimings: runtimeResult?.metrics?.aiContextTimings || null,
      streamMetrics,
      totalMs: roundMs(nowMs() - startedAt),
    });
  } catch (error) {
    const safeError = toSafeCompanyChatError(error);
    const diagnostic = controlledChatErrorDiagnostic(error);
    logMetric("ai_chat_request_failed", {
      requestId,
      runtime: runtimeMode,
      model: String(body?.model || ""),
      query: summarizeQuery(runtimeResult?.queryText || queryText),
      aiContextEnabled: runtimeResult?.metrics?.aiContextEnabled || body?.useDefectContext === true,
      analyticsContextEnabled: runtimeResult?.metrics?.analyticsContextEnabled || body?.useAnalyticsContext === true,
      mainAgentToolCallCount: runtimeResult?.metrics?.mainAgentToolCallCount || 0,
      aiContextTimings: runtimeResult?.metrics?.aiContextTimings || null,
      streamMetrics,
      totalMs: roundMs(nowMs() - startedAt),
      errorCode: safeError.payload.error,
      diagnostic,
    });
    if (response.headersSent) {
      writeSseEvent(response, { type: "error", message: safeError.payload.error });
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }
    sendJson(response, safeError.statusCode, safeError.payload);
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
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
  if (!isTrustedLocalApiRequest(request, { apiPort: port, webPort })) {
    sendJson(response, 403, { success: false, error: "LOCAL_API_ORIGIN_REQUIRED" });
    return;
  }
  const url = resolveRequestUrl(request.url, request.headers.host);

  if (request.method === "OPTIONS") {
    response.writeHead(204, buildLocalCorsHeaders(request, { apiPort: port, webPort }));
    response.end();
    return;
  }

  if (!isJsonApiRequest(request, url.pathname)) {
    sendJson(response, 415, { success: false, error: "JSON_CONTENT_TYPE_REQUIRED" });
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
      await proxyAnalyticsJson({
        pathname: url.pathname,
        searchParams: url.searchParams,
        response,
        analyticsApiBase,
        timeoutMs: analyticsProxyTimeoutMs,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/qgate-reports/dashboard-html") {
      const filePath = resolveQGateDashboardHtmlPath(
        defaultQGateReportsRoot,
        url.searchParams.get("run"),
        url.searchParams.get("file"),
      );
      const nonce = createQGateDashboardNonce();
      const body = stampQGateScriptNonce(fs.readFileSync(filePath, "utf8"), nonce);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": buildQGateDashboardCsp(nonce),
        "X-Content-Type-Options": "nosniff",
      });
      response.end(body);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/context") {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      const startedAt = nowMs();
      const requestId = buildRequestId("ai-context");
      const body = await readBoundedJsonBody(request, { maxBytes: jsonBodyLimitBytes });
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
      const body = await readBoundedJsonBody(request, { maxBytes: jsonBodyLimitBytes });
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
      await handleAiTranscribeRequest(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      await handleAiChatRequest(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/duplicate-search") {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      const body = await readBoundedJsonBody(request, { maxBytes: jsonBodyLimitBytes });
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

    if (request.method === "POST" && url.pathname === "/api/duplicate-feedback") {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      const body = await readBoundedJsonBody(request, { maxBytes: jsonBodyLimitBytes });
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
      const body = await readBoundedJsonBody(request, { maxBytes: jsonBodyLimitBytes });
      const defectId = typeof body?.defect_id === "string" ? body.defect_id.trim() : "";

      if (!defectId) {
        sendJson(response, 400, { success: false, error: "defect_id is required" });
        return;
      }

      try {
        // Step 1: Python bridge — read defect + RAG retrieve similar test cases
        const prepared = await runTestCaseBridge({ action: "prepare", defect_id: defectId });
        if (!prepared?.success || !prepared?.defect_info) {
          sendJson(response, 500, { success: false, error: prepared?.error || "failed to prepare defect" });
          return;
        }

        const defectInfo = prepared.defect_info;
        const similarCases = prepared.similar_cases || [];
        const fewShotText = prepared.few_shot_text || "";

        // Step 2: LLM generation — build description HTML + steps text
        const chatConfig = resolveChatModelConfig(undefined, process.env);
        const llmResult = await generateTestCaseContent(defectInfo, fewShotText, chatConfig);

        // Step 3: Python bridge — verify quality
        const verified = await runTestCaseBridge({
          action: "verify",
          defect_info: defectInfo,
          description_html: llmResult.descriptionHtml,
          steps_text: llmResult.stepsText,
        });

        const result = {
          defectId: defectInfo.defect_id,
          defectName: defectInfo.name,
          defectSeverity: defectInfo.severity,
          defectSoftwareVersion: defectInfo.software_version,
          defectAssignedEcu: defectInfo.assigned_ecu,
          defectLeadModel: defectInfo.lead_model,
          descriptionHtml: llmResult.descriptionHtml,
          stepsText: llmResult.stepsText,
          name: llmResult.testName,
          verification: verified?.verification || { passed: false, criteria: [], feedback: "verification skipped" },
          similarCases,
          generatedAt: new Date().toISOString(),
        };

        sendJson(response, 200, { success: true, result });
      } catch (error) {
        sendJson(response, 500, { success: false, error: String(error?.message || error) });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/create-testcase/commit") {
      if (!await requireInternalAuxiliaryActor(request, response)) return;
      const body = await readBoundedJsonBody(request, { maxBytes: jsonBodyLimitBytes });
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
    const safeBodyResponse = toSafeLocalApiBodyResponse(error);
    if (safeBodyResponse) {
      sendJson(response, safeBodyResponse.statusCode, safeBodyResponse.payload);
      return;
    }
    console.error(`[vizion-local-api] ${controlledChatErrorDiagnostic(error)}`);
    sendJson(response, 500, { success: false, error: "LOCAL_API_REQUEST_FAILED" });
  }
});

listenLocalApiServer(server, port, () => {
  console.log(`Vizion local API listening on http://127.0.0.1:${port}`);
  if (shouldWarmDuplicateSearch(process.env)) {
    duplicateWarmupManager.triggerBackgroundWarmup({ reason: "startup" });
  }
});

function shutdown() {
  stopDuplicateBridgeRuntime();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
