import { encodeSseEvent } from "./events.mjs";
import { handlePreflight, readJsonBody, writeHttpError, writeJson, writeSseHeaders } from "./httpUtils.mjs";

const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled"]);

function httpError(code, statusCode) {
  return Object.assign(new Error(code), { code, statusCode, retryable: false });
}

export function createAgentHttpRoutes({ runtime, eventStore, modelRegistry, identityResolver, config }) {
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

    if (request.method === "POST" && url.pathname === "/api/agent/runs") {
      const body = await readJsonBody(request, { maxBytes: config.jsonBodyMaxBytes || 1024 * 1024 });
      const started = await runtime.startRun({ actor, request: body });
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
      const body = await readJsonBody(request, { maxBytes: config.jsonBodyMaxBytes || 1024 * 1024 });
      const cancelled = await runtime.cancelRun({ actor, runId, threadVersion: body.threadVersion, reasonCode: body.reasonCode || "user_stop" });
      writeJson(response, request, config, 202, { schemaVersion: "1.0", runId, status: cancelled.status, threadVersion: cancelled.threadVersion }, { "X-Agent-Protocol": "1.0", "X-Agent-Run-ID": runId });
      return true;
    }

    const resumeMatch = /^\/api\/agent\/runs\/([^/]+)\/resume$/.exec(url.pathname);
    if (request.method === "POST" && resumeMatch) {
      const runId = resumeMatch[1];
      const body = await readJsonBody(request, { maxBytes: config.jsonBodyMaxBytes || 1024 * 1024 });
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