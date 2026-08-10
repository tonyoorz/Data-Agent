// @vitest-environment node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Phase 1 qualification assets", () => {
  it("defines the frozen PR smoke suite and operations evidence files", () => {
    const schema = JSON.parse(fs.readFileSync("evals/main-agent/schema/eval-case.schema.json", "utf8"));
    const cases = fs.readFileSync("evals/main-agent/pr-smoke/phase1-runtime.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));

    expect(schema.$id).toBe("https://vizion-lab.local/evals/main-agent/eval-case.schema.json");
    expect(cases).toHaveLength(60);
    expect(new Set(cases.map((item) => item.case_id)).size).toBe(60);
    expect(cases.filter((item) => item.language === "zh-CN")).toHaveLength(42);
    expect(cases.filter((item) => item.language === "en-US")).toHaveLength(12);
    expect(cases.filter((item) => item.language === "mixed")).toHaveLength(6);
    expect(fs.existsSync("scripts/evaluateAgentRuntime.mjs")).toBe(true);
    expect(fs.existsSync("scripts/loadAgentRuntime.mjs")).toBe(true);
    expect(fs.existsSync("scripts/qualifyAgentRollout.mjs")).toBe(true);
    expect(fs.existsSync("scripts/cleanupAgentRuntime.mjs")).toBe(true);
    expect(fs.existsSync("evals/main-agent/real-model/runtime.jsonl")).toBe(true);
    expect(fs.existsSync(".github/workflows/main-agent-real-model.yml")).toBe(true);
    expect(fs.existsSync("docs/main-agent-runtime/dependency-review.md")).toBe(true);
    expect(fs.existsSync("docs/main-agent-runtime/operations.md")).toBe(true);
    expect(fs.existsSync("docs/main-agent-v2/ontology-v1.md")).toBe(true);
    expect(fs.existsSync("docs/main-agent-v2/api-event-protocol.md")).toBe(true);
    expect(fs.existsSync("docs/main-agent-v2/rollout-qualification.md")).toBe(true);
    expect(fs.existsSync("ontology/v1/policies.json")).toBe(true);
    expect(fs.existsSync("ontology/v1/constraints.json")).toBe(true);

    const realModelWorkflow = fs.readFileSync(".github/workflows/main-agent-real-model.yml", "utf8");
    expect(realModelWorkflow).toContain("MAIN_AGENT_QUALIFICATION_HEADERS_JSON: ${{ secrets.MAIN_AGENT_QUALIFICATION_HEADERS_JSON }}");
    expect(realModelWorkflow).toContain("STAGING_BASE_URL: ${{ vars.MAIN_AGENT_QUALIFICATION_BASE_URL }}");
    expect(realModelWorkflow).not.toContain("inputs.base_url");
    expect(realModelWorkflow).not.toContain("--headers-json");
  });

  it("rejects non-HTTPS real-model targets before sending credentials", () => {
    const result = spawnSync(process.execPath, [
      "scripts/evaluateAgentRuntime.mjs",
      "--suite", "evals/main-agent/real-model/runtime.jsonl",
      "--qualification", "real-model",
      "--base-url", "http://127.0.0.1:9",
      "--model", "certified-staging-model",
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("REAL_MODEL_BASE_URL_INVALID");
  });

  it("rejects real-model credentials passed through process arguments", () => {
    const result = spawnSync(process.execPath, [
      "scripts/evaluateAgentRuntime.mjs",
      "--suite", "evals/main-agent/real-model/runtime.jsonl",
      "--qualification", "real-model",
      "--base-url", "https://staging.example.invalid",
      "--model", "certified-staging-model",
      "--headers-json", JSON.stringify({ Authorization: "Bearer deterministic-test-value" }),
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("QUALIFICATION_HEADERS_CLI_FORBIDDEN");
    expect(result.stderr).not.toContain("deterministic-test-value");
  });
});
