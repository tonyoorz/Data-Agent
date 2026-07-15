// @vitest-environment node
import fs from "node:fs";
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
    expect(fs.existsSync("scripts/cleanupAgentRuntime.mjs")).toBe(true);
    expect(fs.existsSync("docs/main-agent-runtime/dependency-review.md")).toBe(true);
    expect(fs.existsSync("docs/main-agent-runtime/operations.md")).toBe(true);
  });
});