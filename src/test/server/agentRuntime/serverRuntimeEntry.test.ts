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
    expect(source).toContain("answerValidationViolations");
  });
});
