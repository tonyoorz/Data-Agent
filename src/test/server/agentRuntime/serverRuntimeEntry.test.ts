// @vitest-environment node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("server agent runtime entry", () => {
  it("has one LangGraph chat path and no unreachable legacy tool-loop branch", () => {
    const source = readFileSync(new URL("../../../../server/index.mjs", import.meta.url), "utf8");

    expect(source).toContain("streamLangGraphChatResponse");
    expect(source).not.toContain("resolveMainAgentToolContext");
    expect(source).not.toContain("shouldResolveGatewayAnalyticsContext");
    expect(source).not.toContain("streamCompanyChatCompletion");
    expect(source).toContain("buildAgentStreamAuditEvent");
    expect(source).toContain("assertSupportedNodeVersion();");

    const auditSource = readFileSync(new URL("../../../../server/agentRuntime/streamAudit.mjs", import.meta.url), "utf8");
    expect(auditSource).toContain("answerValidationViolations");
    expect(auditSource).toContain("terminalStatus");
    expect(auditSource).toContain("failureCode");
  });

  it("maps chat failures to stable client codes instead of raw exception messages", () => {
    const source = readFileSync(new URL("../../../../server/index.mjs", import.meta.url), "utf8");

    expect(source).toContain("toSafeCompanyChatError(error)");
    expect(source).toContain("message: safeError.payload.error");
    expect(source).toContain("sendJson(response, safeError.statusCode, safeError.payload)");
    expect(source).not.toContain('error instanceof Error ? error.message : "Unknown server error"');
  });

  it("does not copy user query text into process metrics", () => {
    const source = readFileSync(new URL("../../../../server/index.mjs", import.meta.url), "utf8");

    expect(source).toContain("query: summarizeQuery(");
    expect(source).not.toContain("preview: normalized");
    expect(source).not.toContain("normalized.slice(0, 80)");
  });

  it.each([
    ["remote plaintext origin", { VIZION_ANALYTICS_API_BASE: "http://analytics.example.test:8103" }, "VIZION_ANALYTICS_API_BASE_INVALID"],
    ["invalid timeout", { VIZION_ANALYTICS_PROXY_TIMEOUT_MS: "0" }, "VIZION_ANALYTICS_PROXY_TIMEOUT_INVALID"],
    ["zero API port", { VIZION_API_PORT: "0" }, "VIZION_API_PORT_INVALID"],
    ["invalid web port", { VIZION_WEB_PORT: "not-a-port" }, "VIZION_WEB_PORT_INVALID"],
  ])("fails before listening when analytics %s is invalid", (_description, overrides, errorCode) => {
    const result = spawnSync(process.execPath, ["server/index.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VIZION_AGENT_AUTH_MODE: "oidc",
        VIZION_ANALYTICS_API_BASE: "http://127.0.0.1:3003",
        VIZION_ANALYTICS_PROXY_TIMEOUT_MS: "10000",
        ...overrides,
      },
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(errorCode);
    expect(result.stdout).not.toContain("Vizion local API listening");
  });
});
