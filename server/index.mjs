import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import duplicateBridgeRuntime from "./duplicateBridgeRuntime.cjs";
import { streamLangGraphChatResponse } from "./agentRuntime/langGraphChatHandler.mjs";
import { createLangGraphChatRuntime, resolveAgentRuntimeMode } from "./agentRuntime/langGraphChatRuntime.mjs";
import { createFileAgentRuntimeStore } from "./agentRuntime/runtimeAuditStore.mjs";
import { resolveAiAnalyticsContext } from "./aiAnalyticsContext.mjs";
import { resolveMainAgentToolContext } from "./mainAgentToolLoop.mjs";
import { shouldPlanMainAgentTools } from "./mainAgentToolPlanning.mjs";
import { createDuplicateWarmupManager } from "./duplicateWarmup.mjs";
import { extractLatestUserQuery, resolveAiDefectContext } from "./aiContext.mjs";
import { streamCompanyChatCompletion, writeSseEvent } from "./companyChat.mjs";
import { resolveRequestUrl } from "./httpRequestUrl.mjs";
import { withInternalActorScope } from "./internalActorScope.mjs";
import { attachDuplicateSummary } from "./duplicateResultEnrichment.mjs";
import { loadLocalEnv } from "./loadLocalEnv.mjs";
import {
  defaultQGateReportsRoot,
  findLatestQGateDashboardReport,
  resolveQGateDashboardHtmlPath,
} from "./qgateReports.mjs";
import { handleTranscribeRequest } from "./transcribe.mjs";

const { runDuplicateBridge, stopDuplicateBridgeRuntime } = duplicateBridgeRuntime;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
loadLocalEnv();
const port = Number(process.env.VIZION_API_PORT || 3004);
const staticDir = fs.existsSync(path.join(repoRoot, "dist")) ? path.join(repoRoot, "dist") : "";
const duplicateWarmupManager = createDuplicateWarmupManager({
  runDuplicateBridge,
  logger: console,
});
const langGraphChatRuntime = createLangGraphChatRuntime({
  runtimeStore: createFileAgentRuntimeStore(),
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

async function handleAiChatRequest(rawBody, response) {
  const body = withInternalActorScope(rawBody, process.env);
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
        toolDependencies: {
          runDuplicateBridge,
          ensureDuplicateWarmup: () => duplicateWarmupManager.ensureWarm({ reason: "langgraph-agent-tool" }),
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
  const url = resolveRequestUrl(request.url, request.headers.host);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
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
      sendJson(response, 200, duplicateWarmupManager.getStatus());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/duplicate-search/warmup") {
      const body = await readJsonBody(request);
      const status = await duplicateWarmupManager.ensureWarm({
        reason: typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim() : "manual",
      });
      sendJson(response, 200, status);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/chat") {
      const body = await readJsonBody(request);
      await handleAiChatRequest(body, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ai/transcribe") {
      const body = await readJsonBody(request);
      const result = await handleTranscribeRequest(body);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJsonBody(request);
      await handleAiChatRequest(body, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/duplicate-search") {
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

    if (request.method === "POST" && url.pathname === "/api/duplicate-feedback") {
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

    if (serveStaticAsset(request, response, url)) {
      return;
    }

    sendJson(response, 404, { success: false, error: `Not found: ${url.pathname}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error";
    sendJson(response, 500, { success: false, error: message });
  }
});

server.listen(port, () => {
  console.log(`Vizion local API listening on http://127.0.0.1:${port}`);
  duplicateWarmupManager.triggerBackgroundWarmup({ reason: "startup" });
});

function shutdown() {
  stopDuplicateBridgeRuntime();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
