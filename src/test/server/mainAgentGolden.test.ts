// @vitest-environment node
import fs from "node:fs";
import { describe, expect, it } from "vitest";

import {
  selectMainAgentToolset,
  shouldPlanMainAgentTools,
} from "../../../server/mainAgentToolPlanning.mjs";

describe("Main agent golden suite", () => {
  it("repeats intent and toolset routing cases exactly", () => {
    const cases = fs.readFileSync("evals/main-agent/target/agent-golden.jsonl", "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(cases.length).toBeGreaterThanOrEqual(10);

    for (const item of cases) {
      const messages = [{ role: "user", content: item.query }];
      const selected = selectMainAgentToolset(messages);

      expect(shouldPlanMainAgentTools(messages), item.caseId).toBe(item.expected.shouldPlanTools);
      expect(selected.intent, item.caseId).toBe(item.expected.intent);
      for (const toolName of item.expected.toolNamesInclude || []) {
        expect(selected.toolNames, item.caseId).toContain(toolName);
      }
      for (const toolName of item.expected.toolNamesExclude || []) {
        expect(selected.toolNames, item.caseId).not.toContain(toolName);
      }
    }
  });
});