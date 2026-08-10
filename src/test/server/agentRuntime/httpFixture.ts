// @vitest-environment node
import http from "node:http";
import { createAgentApp } from "../../../../server/app.mjs";
import { createArtifactStore } from "../../../../server/agentRuntime/artifactStore.mjs";
import { createTestRuntime, alice } from "./runtimeFixture";
import path from "node:path";

export async function startTestAgentServer() {
  const fixture = await createTestRuntime();
  const modelRegistry = {
    defaultModelId: "deepseek-v4-flash",
    listPublic: () => [{ id: "deepseek-v4-flash", label: "DeepSeek", capabilities: { certificationStatus: "planner_certified" }, default: true }],
  };
  let artifactId = 0;
  const artifactStore = createArtifactStore({ db: fixture.runtimeDb.db, artifactRoot: path.join(fixture.root, "artifacts"), now: fixture.clock.now, randomUUID: () => `http-artifact-${++artifactId}` });
  const app = createAgentApp({
    runtime: fixture.runtime,
    eventStore: fixture.eventStore,
    threadStore: fixture.threadStore,
    artifactStore,
    auditStore: fixture.auditStore,
    modelRegistry,
    identityResolver: async () => alice,
    config: { mode: "langgraph", allowedOrigins: ["https://vizion.example"] },
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return {
    ...fixture,
    artifactStore,
    baseUrl,
    async fetch(path: string, init: RequestInit = {}) {
      return fetch(`${baseUrl}${path}`, init);
    },
    async cleanupServer() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fixture.cleanup();
    },
  };
}
