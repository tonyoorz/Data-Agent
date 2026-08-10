import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildChatCompletionRequest, resolveChatModelConfig } from "../../../server/chatModelConfig.mjs";

const repoRoot = process.cwd();

function readRepoFile(relativePath: string) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("project runtime isolation", () => {
  it("uses the native QGate KPI generator for the npm report script", () => {
    const packageJson = JSON.parse(readRepoFile("package.json"));

    expect(packageJson.scripts["report:qgate-kpi"]).toBe(
      "python -m backend.analytics_cli generate-qgate-kpi-reports",
    );
  });

  it("does not require Lovable Playwright helpers", () => {
    expect(readRepoFile("playwright.config.ts")).not.toContain("lovable-agent-playwright-config");
    expect(readRepoFile("playwright-fixture.ts")).not.toContain("lovable-agent-playwright-config");
  });

  it("does not load chat credentials from a sibling TPMDashboard repository", () => {
    const config = resolveChatModelConfig("deepseek-v4-flash", {
      DUPSEARCH_CHAT_ACCESS_CODE: "",
      ACCESS_CODE: "",
      DEEPSEEK_ACCESS_CODE: "",
    });

    expect(config.accessCode).toBe("");
    expect(config.credential).toBe("");
  });

  it("defaults company chat requests to the supported DeepSeek flash model", () => {
    const request = buildChatCompletionRequest({
      messages: [{ role: "user", content: "hello" }],
      env: {
        DUPSEARCH_CHAT_ACCESS_CODE: "test-access-code",
      },
    });

    expect(request.config.model).toBe("deepseek-v4-flash");
    expect(request.body.model).toBe("deepseek-v4-flash");
    expect(request.config.usesInternalEndpoint).toBe(true);
    expect(request.headers.authorization).toBe("ACCESSCODE test-access-code");
  });
});