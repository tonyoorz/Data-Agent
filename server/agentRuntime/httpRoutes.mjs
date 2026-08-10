import { encodeSseEvent } from "./events.mjs";
import { createContractRegistry } from "./contracts.mjs";
import { handlePreflight, readBinaryBody, readJsonBody, writeHttpError, writeJson, writeSseHeaders } from "./httpUtils.mjs";

const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled"]);

function httpError(code, statusCode) {
  return Object.assign(new Error(code), { code, statusCode, retryable: false });
}

function validateRequest(validate, value) {
  try {
    return validate(value);
  } catch (error) {
    const raw = String(error?.code || error?.message || "");
    const code = /^([A-Z][A-Z0-9_]{2,79})(?::|$)/.exec(raw)?.[1] || "INVALID_REQUEST";
    throw httpError(code, 400);
  }
}

function artifactFileName(request) {
  const raw = String(request.headers["x-artifact-file-name"] || "artifact");
  try {
    return decodeURIComponent(raw);
  } catch {
    throw httpError("ARTIFACT_FILE_NAME_INVALID", 400);
  }
}

export function createAgentHttpRoutes({ runtime, eventStore, modelRegistry, identityResolver, config, threadStore, artifactStore, auditStore, contracts = createContractRegistry() }) {
  return async function route(request, response, url) {
    if (request.method === "OPTIONS") {
      handlePreflight(response, request, config);
      return true;
    }
    const actor = await identityResolver(request);
    if (!actor?.actorId) throw httpError("UNAUTHORIZED", 401);

    if (request.method === "GET" && url.pathname === "/api/ai/models") {
      writeJson(response, request, config, 200, { schemaVersion: "1.0", defaultModelId: modelRegistry.defaultModelId, models: modelRegistry.listPublic() });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/agent/config") {
      const decision = config.resolveRuntimeDecision
        ? config.resolveRuntimeDecision(actor.actorId)
        : { runtimeMode: config.resolveRuntimeMode ? config.resolveRuntimeMode(actor.actorId) : config.mode, serverControlled: true };
      const runtimeMode = decision.runtimeMode;
      const agentApiEnabled = decision.agentApiEnabled ?? runtimeMode === "langgraph";
      writeJson(
        response,
        request,
        config,
        200,
        { schemaVersion: "1.0", runtimeMode, agentApiEnabled, serverControlled: decision.serverControlled !== false },
        {
          "X-Agent-Runtime-Mode": runtimeMode,
          "X-Agent-API-Enabled": String(agentApiEnabled),
          "X-Agent-Server-Controlled": "true",
        },
      );
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/artifacts") {
      if (!artifactStore) throw httpError("ARTIFACT_STORE_UNAVAILABLE", 503);
      const threadId = String(request.headers["x-agent-thread-id"] || "").trim();
      if (!threadId) throw httpError("ARTIFACT_THREAD_REQUIRED", 400);
      const declaredMime = String(request.headers["content-type"] || "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
      const bytes = await readBinaryBody(request, { maxBytes: config.binaryBodyMaxBytes || 8 * 1024 * 1024 });
      const artifact = await artifactStore.put({ actor, threadId, fileName: artifactFileName(request), declaredMime, bytes });
      auditStore?.append({ actor, threadId, action: "artifact.upload", details: { artifactId: artifact.artifactId, contentHash: artifact.contentHash, sizeBytes: artifact.sizeBytes, mimeType: artifact.mimeType } });
      writeJson(response, request, config, 201, { schemaVersion: "1.0", ...artifact });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/threads") {
      if (!threadStore) throw httpError("THREAD_STORE_UNAVAILABLE", 503);
      const body = validateRequest(contracts.validateCreateThread, await readJsonBody(request, { maxBytes: config.jsonBodyMaxBytes || 1024 * 1024 }));
      const thread = threadStore.createThread({ actor, title: body.title || "新对话" });
      auditStore?.append({ actor, threadId: thread.threadId, action: "thread.create", details: { source: "agent-api" } });
      writeJson(response, request, config, 201, { schemaVersion: "1.0", thread });
      return true;
    }

    const threadMatch = /^\/api\/agent\/threads\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && threadMatch) {
      if (!threadStore) throw httpError("THREAD_STORE_UNAVAILABLE", 503);
      const threadId = threadMatch[1];
      const thread = threadStore.getThread({ actor, threadId });
      const messages = threadStore.listMessages({ actor, threadId });
      writeJson(response, request, config, 200, { schemaVersion: "1.0", thread, messages });
      return true;
    }

    if (request.method === "PATCH" && threadMatch) {
      if (!threadStore) throw httpError("THREAD_STORE_UNAVAILABLE", 503);
      const body = validateRequest(contracts.validateThreadPatch, await readJsonBody(request, { maxBytes: config.jsonBodyMaxBytes || 1024 * 1024 }));
      const { schemaVersion: _schemaVersion, threadVersion, ...patch } = body;
      const thread = threadStore.updateThread({ actor, threadId: threadMatch[1], threadVersion, patch });
      auditStore?.append({ actor, threadId: thread.threadId, action: "thread.update", details: { fields: Object.keys(patch) } });
      writeJson(response, request, config, 200, { schemaVersion: "1.0", thread });
      return true;
    }

    const forkMatch = /^\/api\/agent\/threads\/([^/]+)\/fork$/.exec(url.pathname);
    if (request.method === "POST" && forkMatch) {
      if (!threadStore) throw httpError("THREAD_STORE_UNAVAILABLE", 503);
      const body = validateRequest(contracts.validateForkRequest, await readJsonBody(request, { maxBytes: config.jsonBodyMaxBytes || 1024 * 1024 }));
      const thread = threadStore.forkThread({ actor, threadId: forkMatch[1], ...body });
      auditStore?.append({ actor, threadId: thread.threadId, action: "thread.fork", details: { parentThreadId: forkMatch[1], parentRunId: body.parentRunId } });
      writeJson(response, request, config, 201, { schemaVersion: "1.0", thread });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/threads/import") {
      if (!threadStore) throw httpError("THREAD_STORE_UNAVAILABLE", 503);
      const body = validateRequest(contracts.validateLegacyImport, await readJsonBody(request, { maxBytes: config.legacyImportMaxBytes || 28 * 1024 * 1024 }));
      const thread = threadStore.importLegacyThread({ actor, clientConversationId: body.clientConversationId, messages: body.messages });
      auditStore?.append({ actor, threadId: thread.threadId, action: "thread.import", details: { clientConversationId: body.clientConversationId, messageCount: body.messages.length } });
      writeJson(response, request, config, 201, { schemaVersion: "1.0", thread });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/runs") {
      const runtimeMode = config.resolveRuntimeMode ? config.resolveRuntimeMode(actor.actorId) : config.mode;
      if (runtimeMode !== "langgraph") throw httpError("AGENT_RUNTIME_NOT_ENABLED", 409);
      const body = validateRequest(contracts.validateRunRequest, await readJsonBody(request, { maxBytes: config.jsonBodyMaxBytes || 1024 * 1024 }));
      const started = await runtime.startRun({ actor, request: body, runtimeMode });
      writeJson(response, request, config, 202, { schemaVersion: "1.0", threadId: started.threadId, runId: started.runId, threadVersion: started.threadVersion, eventsUrl: `/api/agent/runs/${started.runId}/events` }, { "X-Agent-Protocol": "1.0", "X-Agent-Run-ID": started.runId, "X-Agent-Thread-ID": started.threadId });
      return true;
    }

    const eventsMatch = /^\/api\/agent\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (request.method === "GET" && eventsMatch) {
      const runId = eventsMatch[1];
      const afterEventId = request.headers["last-event-id"];
      eventStore.listAfter({ actor, runId, afterEventId });
      writeSseHeaders(response, request, config, { "X-Agent-Protocol": "1.0", "X-Agent-Run-ID": runId });
      const seen = new Set();
      let terminal = false;
      const writeEvents = (events) => {
        for (const event of events) {
          if (seen.has(event.eventId)) continue;
          seen.add(event.eventId);
          response.write(encodeSseEvent(event, "agent-v1"));
          if (TERMINAL_EVENTS.has(event.type)) terminal = true;
        }
      };
      const follow = url.searchParams.get("follow") === "1";
      let resolveFollow;
      const onEvents = (events) => {
        writeEvents(events);
        if (terminal) resolveFollow?.();
      };
      if (follow) eventStore.notifier.on(runId, onEvents);
      try {
        writeEvents(eventStore.listAfter({ actor, runId, afterEventId }));
        if (follow && !terminal && !response.writableEnded) {
          await new Promise((resolve) => {
            const done = () => {
              clearTimeout(timeout);
              resolve();
            };
            resolveFollow = done;
            const timeout = setTimeout(done, config.sseFollowMaxMs || 30000);
            request.once("close", done);
            response.once("close", done);
          });
        }
      } finally {
        if (follow) eventStore.notifier.off(runId, onEvents);
      }
      response.end();
      return true;
    }

    const cancelMatch = /^\/api\/agent\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
    if (request.method === "POST" && cancelMatch) {
      const runId = cancelMatch[1];
      const body = validateRequest(contracts.validateCancelRequest, await readJsonBody(request, { maxBytes: config.jsonBodyMaxBytes || 1024 * 1024 }));
      const cancelled = await runtime.cancelRun({ actor, runId, threadVersion: body.threadVersion, reasonCode: body.reasonCode || "user_stop" });
      writeJson(response, request, config, 202, { schemaVersion: "1.0", runId, status: cancelled.status, threadVersion: cancelled.threadVersion }, { "X-Agent-Protocol": "1.0", "X-Agent-Run-ID": runId });
      return true;
    }

    const resumeMatch = /^\/api\/agent\/runs\/([^/]+)\/resume$/.exec(url.pathname);
    if (request.method === "POST" && resumeMatch) {
      const runId = resumeMatch[1];
      const body = validateRequest(contracts.validateResumeRequest, await readJsonBody(request, { maxBytes: config.jsonBodyMaxBytes || 1024 * 1024 }));
      const resumed = await runtime.resumeRun({ actor, runId, interactionId: body.interactionId, threadVersion: body.threadVersion, value: body.value });
      writeJson(response, request, config, 202, { schemaVersion: "1.0", runId, interactionId: resumed.interactionId, status: resumed.status, threadVersion: resumed.threadVersion }, { "X-Agent-Protocol": "1.0", "X-Agent-Run-ID": runId });
      return true;
    }

    return false;
  };
}

export async function routeWithErrors(route, request, response, config) {
  try {
    return await route(request, response, new URL(request.url, "http://127.0.0.1"));
  } catch (error) {
    writeHttpError(response, request, config, error);
    return true;
  }
}
