// @vitest-environment node
import http from "node:http";
import { createAgentApp } from "../../../../server/app.mjs";
import { createTestRuntime, alice } from "./runtimeFixture";

export async function startTestAgentServer() {
  const fixture = await createTestRuntime();
  const modelRegistry = {
    defaultModelId: "deepseek-v4-flash",
    listPublic: () => [{ id: "deepseek-v4-flash", label: "DeepSeek", capabilities: { certificationStatus: "planner_certified" }, default: true }],
  };
  const app = createAgentApp({
    runtime: fixture.runtime,
    eventStore: fixture.eventStore,
    threadStore: fixture.threadStore,
    modelRegistry,
    identityResolver: async () => alice,
    config: { allowedOrigins: ["https://vizion.example"] },
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return {
    ...fixture,
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