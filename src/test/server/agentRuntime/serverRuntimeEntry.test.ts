// @vitest-environment node
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("server agent runtime entry", () => {
  it("has one LangGraph chat path and no unreachable legacy tool-loop branch", () => {
    const source = readFileSync(new URL("../../../../server/index.mjs", import.meta.url), "utf8");

    expect(source).toContain("streamLangGraphChatResponse");
    expect(source).not.toContain("resolveMainAgentToolContext");
    expect(source).not.toContain("shouldResolveGatewayAnalyticsContext");
    expect(source).not.toContain("streamCompanyChatCompletion");
    expect(source).toContain("buildAgentStreamAuditEvent");

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
});
