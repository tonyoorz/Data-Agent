import http from "node:http";
import { createAgentHttpRoutes, routeWithErrors } from "./agentRuntime/httpRoutes.mjs";

export function createAgentApp(deps = {}) {
  const config = { mode: "legacy", allowedOrigins: [], jsonBodyMaxBytes: 1024 * 1024, ...(deps.config || {}) };
  const agentRoutes = deps.runtime ? createAgentHttpRoutes({ ...deps, config }) : null;
  return async function agentRequestListener(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ service: "agent-api", ready: Boolean(deps.runtime), runtimeMode: config.mode, graphDefinitionVersion: "main-agent-v1", applicationSchemaVersion: 1, saverReady: true, analyticsReady: true }));
      return;
    }
    if (agentRoutes && await routeWithErrors(agentRoutes, request, response, config)) return;
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ code: "NOT_FOUND" }));
  };
}

export function createAgentServer(deps) {
  return http.createServer(createAgentApp(deps));
}

export async function buildProductionDependencies() {
  throw new Error("PRODUCTION_COMPOSITION_NOT_CONFIGURED");
}